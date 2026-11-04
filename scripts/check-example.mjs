import fs from 'node:fs';
import { getDocument } from 'file:///C:/Users/lukea/AppData/Local/Temp/pdfjs-extract/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfStructure } from '../js/pdf-extract.js';
import { parseReport } from '../js/parse-report.js';
import { buildClassDataset, buildPayload, guardPayload } from '../js/anonymise.js';

const data = new Uint8Array(fs.readFileSync('C:/Users/lukea/Downloads/Example-name-A000000000000.pdf'));
const structure = await extractPdfStructure({ getDocument }, data);
const parsed = parseReport(structure, { filename: 'Example-name-A000000000000.pdf' });
const p = parsed.pupils[0];
const byKind = {};
for (const a of p.assessments) {
  byKind[a.kind] = byKind[a.kind] || [];
  byKind[a.kind].push(`${a.name} => ${JSON.stringify(a.values)}`);
}
const dataset = buildClassDataset(parsed.pupils, { seed: 1 });
const payload = buildPayload(dataset, { subject: p.subjectHints[0] || '', yearGroup: p.yearGroup || '', notes: '' });
const guard = guardPayload(payload, dataset);
const leaks = ['Grogan', 'Christ', 'King', 'Example', '11EGN', 'Edexcel'].filter((n) => payload.toLowerCase().includes(n.toLowerCase()));
console.log(JSON.stringify({
  layout: parsed.layout,
  name: p.displayName,
  year: p.yearGroup,
  subject: p.subjectHints,
  identifiers: p.identifiers,
  counts: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])),
  kinds: byKind,
  guardOk: guard.ok,
  leaks,
}, null, 2));
