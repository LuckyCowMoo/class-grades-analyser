import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('./vendor/jszip.min.js');
import * as pdfjsLib from './vendor/pdf.min.js';
import './vendor/pdf.worker.min.js';
import { extractPdfStructure } from './js/pdf-extract.js';
import { parseReport } from './js/parse-report.js';
import { buildClassDataset, buildPayload, guardPayload, anonymiseText, verifyAllMessagesSafe } from './js/anonymise.js';
import { setSecurityDataset, assertSafeToSend } from './js/ai-client.js';

async function runTests() {
  console.log('=== STARTING SECURITY VERIFICATION TESTS ===\n');

  // 1. Read sample-class.zip
  const zipBuffer = fs.readFileSync('samples/sample-class.zip');
  const zip = await JSZip.loadAsync(zipBuffer);
  const pdfFiles = Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.pdf') && !n.startsWith('__MACOSX'));
  console.log(`Found ${pdfFiles.length} pupil PDF reports in sample-class.zip`);

  const parsedPupils = [];
  for (const name of pdfFiles) {
    const data = await zip.files[name].async('uint8array');
    const structure = await extractPdfStructure(pdfjsLib, data);
    const parsed = parseReport(structure, { filename: name });
    parsedPupils.push(...parsed.pupils);
  }
  console.log(`Successfully parsed ${parsedPupils.length} pupils.`);

  // Verify identifying information parsed
  for (const p of parsedPupils) {
    console.log(`  Pupil found: "${p.displayName}", UPN: ${p.upn || 'none'}, Identifiers: ${p.identifiers.length}`);
  }

  // 2. Build dataset and verify anonymisation
  // Assign a teacher name to test teacher redaction
  parsedPupils[0].teacher = 'Mr J Grogan';
  const dataset = buildClassDataset(parsedPupils);
  setSecurityDataset(dataset);
  console.log(`\nDataset built with ${dataset.pupils.length} anonymised records.`);
  console.log(`Tokens registered in redaction dictionary: ${dataset.nameTokens.size}`);
  console.log(`Full names registered: ${dataset.fullNames.size}`);
  console.log(`Sensitive identifiers registered: ${dataset.identifierStrings.size}`);

  // 3. Build payload and verify no pupil names or IDs leak
  const payload = buildPayload(dataset);
  console.log('\nTesting generated outgoing payload...');
  for (const p of parsedPupils) {
    if (p.displayName && payload.includes(p.displayName)) {
      throw new Error(`FAIL: Payload contains pupil full name "${p.displayName}"!`);
    }
    for (const tok of p.nameTokens || []) {
      if (tok.length > 2 && payload.toLowerCase().includes(tok.toLowerCase())) {
        throw new Error(`FAIL: Payload contains pupil name token "${tok}"!`);
      }
    }
    if (p.upn && payload.includes(p.upn)) {
      throw new Error(`FAIL: Payload contains pupil UPN "${p.upn}"!`);
    }
  }
  console.log('PASS: Zero pupil names, name tokens, or UPNs found in generated payload.');

  // 4. Test Guard on clean payload
  const cleanGuard = guardPayload(payload, dataset);
  if (!cleanGuard.ok) {
    console.error('Guard findings on clean payload:', cleanGuard.findings);
    throw new Error('FAIL: Clean payload was rejected by guard!');
  }
  console.log('PASS: Clean anonymised payload passed guard inspection.');

  // 5. Test Pre-flight Assertion on clean payload
  try {
    assertSafeToSend([{ role: 'user', content: payload }], 'System instructions');
    console.log('PASS: Pre-flight assertSafeToSend passed for clean payload.');
  } catch (e) {
    throw new Error(`FAIL: assertSafeToSend rejected clean payload: ${e.message}`);
  }

  // 6. Adversarial Attack Tests: Ensure ALL leak vectors are blocked
  console.log('\n--- Running Privacy Tests (Hard Blocks vs Smart Question Warnings) ---');
  const samplePupil = parsedPupils[0];
  const firstName = samplePupil.nameTokens[0];
  const lastName = samplePupil.nameTokens[1];
  const hardBlockCases = [
    { name: 'Pupil full name', text: `Please give extra help to ${samplePupil.displayName}.` },
    { name: 'Pupil first name', text: `Look closely at ${firstName}'s paper.` },
    { name: 'Pupil surname', text: `Can you review ${lastName}?` },
    { name: 'Pupil UPN', text: samplePupil.upn ? `The pupil with UPN ${samplePupil.upn} failed.` : `UPN W123456789012` },
    { name: 'Full Date of Birth', text: `Born on 14/05/2010.` },
    { name: 'Full DOB text', text: `Date of birth: 22 September 2009.` },
    { name: 'School Name Variant 1', text: `Christ the King Catholic High School` },
    { name: 'School Name Variant 2', text: `CTK Sixth Form Centre, Southport` },
    { name: 'Teacher Name', text: `Assessed by Mr J Grogan.` },
    { name: 'Teacher Surname token', text: `Send feedback to Grogan.` },
    { name: 'UK Phone Number', text: `Call 07700 900123 for details.` },
    { name: 'Email Address', text: `Email student@school.co.uk.` },
    { name: 'Postcode', text: `Home address PR8 4NQ.` },
  ];

  for (const tc of hardBlockCases) {
    // A. Test guardPayload
    const g = guardPayload(tc.text, dataset);
    if (g.ok) {
      throw new Error(`FAIL: guardPayload allowed hard-blocked input: ${tc.name} ("${tc.text}")`);
    }
    const blocks = g.findings.filter(f => f.severity === 'block');
    if (!blocks.length) {
      throw new Error(`FAIL: guardPayload did not assign 'block' severity to: ${tc.name}`);
    }

    // B. Test verifyAllMessagesSafe
    const v = verifyAllMessagesSafe([{ role: 'user', content: tc.text }], dataset);
    if (v.ok) {
      throw new Error(`FAIL: verifyAllMessagesSafe allowed adversarial input: ${tc.name}`);
    }

    // C. Test assertSafeToSend
    let asserted = false;
    try {
      assertSafeToSend([{ role: 'user', content: tc.text }]);
    } catch {
      asserted = true;
    }
    if (!asserted) {
      throw new Error(`FAIL: assertSafeToSend did not abort for: ${tc.name}`);
    }

    console.log(`  PASS: Strictly Blocked ${tc.name} -> detected ${blocks.map(b => `${b.type}: "${b.match}"`).join(', ')}`);
  }

  // 7. Test Question / Exam Paper Name Warning System (e.g. "Alice has 3 watermelons")
  console.log('\n--- Testing Question / Exam Paper Name Warning System ---');
  const questionText = 'Question 4: Alice has 3 watermelons, calculate the mass of the sun.';
  const qGuard = guardPayload(questionText, dataset);
  
  // Should NOT be a hard block
  if (!qGuard.ok) {
    throw new Error('FAIL: Question text with character name was hard-blocked instead of warned!');
  }

  // Should have a warning for Alice
  const nameWarnings = qGuard.findings.filter(f => f.severity === 'warn' && f.type === 'possible name');
  if (!nameWarnings.length || nameWarnings[0].match.toLowerCase() !== 'alice') {
    throw new Error(`FAIL: Alice was not detected as a possible name warning: ${JSON.stringify(nameWarnings)}`);
  }
  console.log(`  PASS: Flagged character name warning: "${nameWarnings[0].match}" in "${questionText}"`);

  // Should allow sending when user clicks "Send anyway" (assertSafeToSend allows warnings)
  try {
    assertSafeToSend([{ role: 'user', content: questionText }]);
    console.log('  PASS: assertSafeToSend allows question text to proceed when teacher confirms "Send anyway".');
  } catch (e) {
    throw new Error(`FAIL: assertSafeToSend blocked permissible question name: ${e.message}`);
  }

  // 8. Test anonymiseText helper
  console.log('\n--- Testing anonymiseText Name Translation ---');
  const rawQuery = `What did ${samplePupil.displayName} score on test 1?`;
  const anonQuery = anonymiseText(rawQuery, dataset);
  console.log(`  Raw:  "${rawQuery}"`);
  console.log(`  Anon: "${anonQuery}"`);
  if (anonQuery.includes(samplePupil.displayName)) {
    throw new Error('FAIL: anonymiseText did not replace pupil full name with code!');
  }
  const assignedCode = dataset.pupils.find(p => p.displayName === samplePupil.displayName).code;
  if (!anonQuery.includes(assignedCode)) {
    throw new Error(`FAIL: anonymiseText did not inject pupil code ${assignedCode}!`);
  }
  console.log(`PASS: Pupil name properly mapped to code ${assignedCode}.`);

  console.log('\n=== ALL SECURITY VERIFICATION TESTS PASSED (100%) ===');
}

runTests().catch(err => {
  console.error('\nTEST ERROR:', err);
  process.exit(1);
});
