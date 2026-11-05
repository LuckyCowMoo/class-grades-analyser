// Builds the anonymised class dataset that is allowed to leave the browser,
// and guards the final payload so that nothing identifying slips through.
//
// Design rules:
//  * Pupils are referred to only by random codes (e.g. P07). The code -> name
//    key never leaves this file's return value and is only used for display.
//  * Only assessment names, measure headers and assessment values are sent.
//    Free text, comments, teacher names, class names, school names, dates of
//    birth, UPNs and similar are never part of the payload.
//  * Every string that *is* sent is scrubbed of every pupil's name tokens and
//    identifier patterns, and the final payload is scanned again before it is
//    allowed out ("belt and braces").

import { classifyValue, matchLabel, measureFlags, PII_PATTERNS } from './parse-report.js';
import { scanCommonNames, wordsAround } from './common-names.js?v=3';

const CODE_PREFIXES = ['P', 'S', 'K', 'Q', 'Z', 'ID'];

export function buildClassDataset(parsedPupils, options = {}) {
  const { includePastoral = false, seed = null } = options;

  // 1. Random code assignment so alphabetical order from filenames does not leak.
  const order = shuffle(parsedPupils.map((_, i) => i), seed);
  const pad = Math.max(2, String(parsedPupils.length).length);
  const pupils = order.map((srcIdx, k) => {
    const p = parsedPupils[srcIdx];
    return {
      codeNumber: k + 1,
      codeSuffix: String(k + 1).padStart(pad, '0'),
      displayName: p.displayName,
      nameTokens: p.nameTokens,
      identifiers: p.identifiers,
      sourceFile: p.sourceFile,
      segmentIndex: p.segmentIndex,
      fields: p.fields,
      assessments: p.assessments,
      excluded: p.excluded,
      warnings: p.warnings,
      rowsAreSubjects: p.rowsAreSubjects,
    };
  });

  // 2. Global scrub lists.
  const nameTokens = new Set();
  const fullNames = new Set();
  const identifierStrings = new Set();
  const contextStrings = new Set();
  for (const p of pupils) {
    p.nameTokens.forEach((t) => nameTokens.add(t));
    if (p.displayName) fullNames.add(p.displayName.toLowerCase());
    p.identifiers.forEach((id) => identifierStrings.add(id));
    for (const [key, list] of Object.entries(p.fields || {})) {
      for (const f of list) {
        if (!f.value) continue;
        if (f.cat === 'identifying') {
          identifierStrings.add(f.value);
          if (['name', 'forename', 'surname', 'preferredName', 'middleName', 'contact', 'teacher'].includes(key)) {
            for (const tok of tokenise(f.value)) nameTokens.add(tok);
          }
        } else if (f.cat === 'context' && ['teacher', 'school', 'class'].includes(key)) {
          // Teacher, school and class names are blocked as whole strings (they are
          // never part of the payload anyway). Periods, year groups and pastoral
          // values (e.g. "96%") are simply never included; guarding them as strings
          // would collide with real scores.
          contextStrings.add(f.value);
        }
      }
    }
  }
  // Very short tokens (2 letters) are only scrubbed as whole words; keep them but
  // they are unlikely to appear in assessment names.
  const scrub = makeScrubber({ nameTokens, fullNames, identifierStrings });

  // 3. Consolidate assessments and measures across pupils.
  const assessments = []; // { id, key, name, measures:Set }
  const byKey = new Map();
  const measures = []; // { name, flags, cat }
  const measureByKey = new Map();
  const scrubLog = [];

  const addMeasure = (raw) => {
    const name = scrub(raw, scrubLog, 'measure header');
    const key = normKey(name);
    if (!measureByKey.has(key)) {
      const label = matchLabel(name);
      const cat = label ? label.cat : null;
      const m = { name, key, flags: measureFlags(name), cat, excluded: false };
      if (cat === 'sensitive' && !includePastoral) m.excluded = true;
      if (cat === 'identifying' || cat === 'context') m.excluded = true;
      measureByKey.set(key, m);
      measures.push(m);
    }
    return measureByKey.get(key);
  };

  for (const p of pupils) {
    p.results = new Map(); // assessmentKey -> { measureKey -> value }
    for (const a of p.assessments) {
      const cleanName = scrub(a.name, scrubLog, 'assessment name');
      const key = normKey(cleanName);
      if (!key) continue;
      if (!byKey.has(key)) {
        const entry = { id: `A${assessments.length + 1}`, key, name: cleanName, kind: a.kind || 'topic', measures: new Set(), count: 0, excluded: false };
        const label = matchLabel(cleanName);
        if (label && (label.cat === 'sensitive') && !includePastoral) entry.excluded = true;
        if (label && (label.cat === 'identifying' || label.cat === 'context')) entry.excluded = true;
        byKey.set(key, entry);
        assessments.push(entry);
      } else if (a.kind && byKey.get(key).kind === 'topic') {
        byKey.get(key).kind = a.kind;
      }
      const entry = byKey.get(key);
      entry.count++;
      const rec = p.results.get(key) || {};
      for (const [mRaw, vRaw] of Object.entries(a.values || {})) {
        const m = addMeasure(mRaw);
        const v = scrub(String(vRaw), scrubLog, 'value');
        rec[m.key] = v;
        entry.measures.add(m.key);
      }
      p.results.set(key, rec);
    }
  }

  // Renumber ids after exclusions so the AI sees a contiguous list.
  let n = 0;
  for (const a of assessments) a.id = a.excluded ? null : `A${++n}`;

  const dataset = {
    pupils,
    assessments,
    measures,
    nameTokens,
    fullNames,
    identifierStrings,
    contextStrings,
    scrubLog,
    scrub,
    codePrefix: 'P',
    includePastoral,
  };
  dataset.codePrefix = choosePrefix(dataset);
  for (const p of pupils) p.code = dataset.codePrefix + p.codeSuffix;
  return dataset;
}

function choosePrefix(dataset) {
  const texts = [];
  for (const a of dataset.assessments) texts.push(a.name);
  for (const m of dataset.measures) texts.push(m.name);
  for (const p of dataset.pupils) for (const rec of p.results.values()) texts.push(...Object.values(rec));
  const joined = texts.join(' ');
  for (const prefix of CODE_PREFIXES) {
    const re = new RegExp(`\\b${prefix}\\d{1,3}\\b`, 'i');
    if (!re.test(joined)) return prefix;
  }
  return 'PUPIL';
}

export function parsePupilCode(code) {
  const s = String(code || '');
  const m = s.match(/^(.*?)(\d+)$/);
  if (!m) return { prefix: s || 'P', number: null, suffix: '' };
  return { prefix: m[1], number: parseInt(m[2], 10), suffix: m[2] };
}

export function pupilsFromKey(pupilKey, codePrefixHint = '') {
  const rows = Array.isArray(pupilKey) ? pupilKey : [];
  const pupils = rows.map((row, i) => {
    const code = String(row && row.code != null ? row.code : '');
    const parsed = parsePupilCode(code);
    return {
      code,
      displayName: (row && (row.name || row.displayName)) || '',
      codeNumber: parsed.number == null ? i + 1 : parsed.number,
      codeSuffix: parsed.suffix || String(i + 1).padStart(2, '0'),
    };
  });
  const inferred = pupils.map((p) => parsePupilCode(p.code).prefix).find((p) => p);
  return { pupils, codePrefix: codePrefixHint || inferred || 'P' };
}

export function codeRegex(dataset) {
  const prefix = escapeRe(dataset.codePrefix || 'P');
  return new RegExp(`\\b${prefix}[-.\\s]*0*(\\d{1,4})\\b`, 'gi');
}

// Replace codes with names (display only).
export function reidentify(text, dataset) {
  const pupils = dataset.pupils || [];
  const byNumber = new Map(pupils.map((p) => [p.codeNumber, p.displayName || p.code]));
  let out = String(text);
  const exact = [...pupils].filter((p) => p.code).sort((a, b) => b.code.length - a.code.length);
  for (const p of exact) {
    const name = p.displayName || p.code;
    if (!name) continue;
    out = out.replace(new RegExp(`\\b${escapeRe(p.code)}\\b`, 'gi'), name);
  }
  out = out.replace(codeRegex(dataset), (m, num) => {
    const n = parseInt(num, 10);
    return byNumber.has(n) ? byNumber.get(n) : m;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function buildPayload(dataset, context = {}) {
  const { subject = '', yearGroup = '', notes = '', templateTopics = [] } = context;
  const activeAssessments = dataset.assessments.filter((a) => !a.excluded && a.id);
  const activeMeasures = dataset.measures.filter((m) => !m.excluded && activeAssessments.some((a) => a.measures.has(m.key)));
  const nPupils = dataset.pupils.length;
  const lines = [];
  lines.push('# Anonymised class assessment data');
  lines.push('');
  if (subject) lines.push(`Subject: ${subject}`);
  if (yearGroup) lines.push(`Year group: ${yearGroup}`);
  lines.push(`Number of pupils: ${nPupils}`);
  lines.push(`Pupil codes: ${dataset.codePrefix}${dataset.pupils[0]?.codeSuffix} to ${dataset.codePrefix}${dataset.pupils[dataset.pupils.length - 1]?.codeSuffix} (randomly assigned; they carry no meaning).`);
  if (dataset.pupils.some((p) => p.rowsAreSubjects)) {
    lines.push('Note: the rows below are school subjects (this is a whole-school style report).');
  }
  lines.push('');
  lines.push('## How to read this');
  lines.push('This is a live tracker, usually captured part-way through the year. Empty / "—" means not yet sat. Any 0% in the tracker has already been sent as —. Do not treat those as scores of zero. A few pupils may be resitting the year, so the set of completed assessments can differ from pupil to pupil.');
  if (notes) {
    lines.push('');
    lines.push('Teacher notes:');
    lines.push(notes.trim());
  }
  if (templateTopics.length) {
    lines.push('');
    lines.push('## Course outline (from an empty assessment sheet)');
    lines.push('These are the assessments on the course. Some will have no results yet.');
    for (const t of templateTopics) lines.push(`- ${t}`);
  }

  const schemes = detectSchemes(dataset, activeAssessments, activeMeasures);
  if (schemes.length) {
    lines.push('');
    lines.push('## Value formats');
    for (const s of schemes) lines.push(`- ${s}`);
  }

  const groups = [
    ['headline', 'Headline grades'],
    ['atl', 'Attitude to learning'],
    ['paper', 'Papers and mocks'],
    ['topic', 'Topic coverage so far'],
    ['strength', 'Areas of strength (from the tracker)'],
    ['gap', 'Progress opportunities (from the tracker)'],
    ['skill', 'Question-level skills'],
  ];
  const used = new Set();
  for (const [kind, title] of groups) {
    const cols = activeAssessments.filter((a) => (a.kind || 'topic') === kind);
    if (!cols.length) continue;
    cols.forEach((a) => used.add(a.key));
    writeAssessmentBlock(lines, dataset, cols, activeMeasures, title, kind);
  }
  const leftover = activeAssessments.filter((a) => !used.has(a.key));
  if (leftover.length) writeAssessmentBlock(lines, dataset, leftover, activeMeasures, 'Other assessments', 'other');

  const stats = computeStats(dataset, activeAssessments.filter((a) => (a.kind || 'topic') !== 'skill'), activeMeasures);
  if (stats.length) {
    lines.push('');
    lines.push('## Class summary (computed locally; n is how many pupils have sat it)');
    lines.push('| Assessment | Measure | n sat | mean | median | min | max | distribution |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const s of stats) {
      if (s.n < 2) continue;
      lines.push(`| ${s.name} | ${s.measure} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.median)} | ${s.min} | ${s.max} | ${s.distribution} |`);
    }
  }
  const log = [];
  const scrubbed = lines.map((l) => dataset.scrub(l, log, 'payload', { keepLayout: true }));
  dataset.payloadScrubLog = log;
  return scrubbed.join('\n');
}

function isZeroPercent(v, measure) {
  if (v == null) return false;
  const t = String(v).trim();
  if (!t) return false;
  if (/^0+(?:\.0+)?\s*%$/.test(t)) return true;
  const c = classifyValue(t);
  if (c && c.kind === 'percent' && Number(c.numeric) === 0) return true;
  if (measure && /^%|percent/i.test(measure.name || '') && c && c.kind === 'number' && Number(c.numeric) === 0) return true;
  return false;
}

function payloadCell(v, measure) {
  if (v == null || String(v).trim() === '' || isZeroPercent(v, measure)) return '—';
  return v;
}

function coverage(dataset, assessment, measure) {
  let n = 0;
  for (const p of dataset.pupils) {
    const rec = p.results.get(assessment.key);
    const v = rec ? rec[measure.key] : undefined;
    if (v != null && String(v).trim() !== '' && !isZeroPercent(v, measure)) n++;
  }
  return n;
}

function writeAssessmentBlock(lines, dataset, cols, measures, title, kind) {
  lines.push('');
  lines.push(`## ${title}`);
  const nPupils = dataset.pupils.length;
  const relevantMeasures = measures.filter((m) => cols.some((a) => a.measures.has(m.key)));
  const dense = kind === 'topic' || kind === 'headline' || kind === 'atl' || (cols.length <= 8 && cols.every((a) => {
    const m = relevantMeasures.find((x) => a.measures.has(x.key));
    return m && coverage(dataset, a, m) >= Math.max(3, nPupils * 0.4);
  }));

  if (kind === 'skill' || !dense) {
    lines.push('| Pupil | Assessment | ' + relevantMeasures.map((m) => m.name).join(' | ') + ' |');
    lines.push(`|---|---|${relevantMeasures.map(() => '---').join('|')}|`);
    for (const p of dataset.pupils) {
      for (const a of cols) {
        const rec = p.results.get(a.key);
        const cells = relevantMeasures.map((m) => {
          if (!a.measures.has(m.key)) return '—';
          const v = rec ? rec[m.key] : undefined;
          return payloadCell(v, m);
        });
        if (cells.every((c) => c === '—')) continue;
        lines.push(`| ${p.code} | ${a.name} | ${cells.join(' | ')} |`);
      }
    }
    return;
  }

  if (kind === 'atl' && cols.length === 1) {
    const a = cols[0];
    lines.push(`| Pupil | ${relevantMeasures.map((m) => m.name).join(' | ')} |`);
    lines.push(`|---|${relevantMeasures.map(() => '---').join('|')}|`);
    for (const p of dataset.pupils) {
      const rec = p.results.get(a.key);
      const cells = relevantMeasures.map((m) => {
        const v = rec ? rec[m.key] : undefined;
        return payloadCell(v, m);
      });
      lines.push(`| ${p.code} | ${cells.join(' | ')} |`);
    }
    return;
  }

  const primary = relevantMeasures[0];
  if (relevantMeasures.length === 1 || kind === 'topic') {
    const measure = kind === 'topic' ? (relevantMeasures.find((m) => m.name === '%') || primary) : primary;
    lines.push(`Values are ${measure.name}. — means not yet sat.`);
    lines.push(`| Pupil | ${cols.map((a) => a.name).join(' | ')} |`);
    lines.push(`|---|${cols.map(() => '---').join('|')}|`);
    for (const p of dataset.pupils) {
      const cells = cols.map((a) => {
        const rec = p.results.get(a.key);
        const v = rec ? rec[measure.key] : undefined;
        return payloadCell(v, measure);
      });
      lines.push(`| ${p.code} | ${cells.join(' | ')} |`);
    }
    return;
  }

  lines.push('| Pupil | Assessment | ' + relevantMeasures.map((m) => m.name).join(' | ') + ' |');
  lines.push(`|---|---|${relevantMeasures.map(() => '---').join('|')}|`);
  for (const p of dataset.pupils) {
    for (const a of cols) {
      const rec = p.results.get(a.key);
      const cells = relevantMeasures.map((m) => {
        const v = rec ? rec[m.key] : undefined;
        return payloadCell(v, m);
      });
      if (cells.every((c) => c === '—')) continue;
      lines.push(`| ${p.code} | ${a.name} | ${cells.join(' | ')} |`);
    }
  }
}

function describeFlags(flags) {
  const map = { target: 'target / expected grade', effort: 'effort or attitude score', classAverage: 'class average', rank: 'rank', attainment: 'attainment result' };
  return flags.map((f) => map[f] || f).join(', ');
}

function detectSchemes(dataset, assessments, measures) {
  const kinds = new Map();
  for (const p of dataset.pupils) {
    for (const a of assessments) {
      const rec = p.results.get(a.key);
      if (!rec) continue;
      for (const m of measures) {
        const v = rec[m.key];
        if (v == null || isZeroPercent(v, m)) continue;
        const c = classifyValue(v);
        if (!c || c.kind === 'missing') continue;
        const key = c.kind === 'descriptor' ? `descriptor:${c.scheme}` : c.kind;
        kinds.set(key, (kinds.get(key) || 0) + 1);
      }
    }
  }
  const desc = {
    percent: 'Percentages (higher is better).',
    fraction: 'Raw scores written as "marks / total".',
    number: 'Plain numbers (treat as scores or grade numbers; higher is better unless the measure says otherwise).',
    gcse: 'GCSE-style 9 to 1 grades (9 is highest; + / - are fine grades).',
    level: 'National-curriculum style levels with sub-levels (a is highest, then b, then c).',
    letter: 'Letter grades A* to G (A* highest, U is ungraded).',
    rank: 'Rank positions (1st is best).',
    'descriptor:standard': 'Descriptors: Working Towards < Expected < Greater Depth.',
    'descriptor:progress': 'Descriptors: Emerging < Developing < Secure < Mastered/Excelling.',
    'descriptor:pass': 'Pass / Merit / Distinction style outcomes.',
    'descriptor:rag': 'RAG or effort words (e.g. Red < Amber < Green, Poor < Satisfactory < Good < Excellent).',
    'descriptor:medal': 'Bronze < Silver < Gold.',
    'descriptor:target': 'Below target < On target < Above target.',
    'descriptor:lmh': 'Low < Medium < High.',
    'descriptor:bool': 'Yes / No style completion flags.',
  };
  return [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => desc[k]).filter(Boolean);
}

export function computeStats(dataset, assessments, measures) {
  const out = [];
  for (const a of assessments) {
    for (const m of measures) {
      if (!a.measures.has(m.key)) continue;
      const nums = [];
      const dist = new Map();
      for (const p of dataset.pupils) {
        const rec = p.results.get(a.key);
        const v = rec ? rec[m.key] : undefined;
        if (v == null || v === '' || isZeroPercent(v, m)) continue;
        const c = classifyValue(v);
        if (!c || c.kind === 'missing') continue;
        if (typeof c.numeric === 'number' && !Number.isNaN(c.numeric)) nums.push(c.numeric);
        dist.set(c.text, (dist.get(c.text) || 0) + 1);
      }
      if (!dist.size) continue;
      const sorted = [...nums].sort((x, y) => x - y);
      const mean = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
      const median = nums.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
      // A value-by-value distribution only helps for grade-like data; for raw
      // percentages (mostly unique values) quartiles are more useful.
      let distribution;
      if (dist.size <= 8) {
        distribution = [...dist.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(', ');
      } else if (sorted.length >= 4) {
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
        distribution = `lower quartile ${fmt(q(0.25))}, upper quartile ${fmt(q(0.75))}`;
      } else {
        distribution = '';
      }
      out.push({ id: a.id, name: a.name, measure: m.name, n: dist.size ? [...dist.values()].reduce((s, x) => s + x, 0) : 0, mean, median, min: sorted.length ? sorted[0] : '', max: sorted.length ? sorted[sorted.length - 1] : '', distribution });
    }
  }
  return out;
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '';
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Scrubbing + guard
// ---------------------------------------------------------------------------

export function tokenise(s) {
  return String(s || '')
    .split(/[^\p{L}'’\-]+/u)
    .map((t) => t.replace(/^['’\-]+|['’\-]+$/g, '').toLowerCase())
    .filter((t) => t.length >= 2);
}

function makeScrubber({ nameTokens, fullNames, identifierStrings }) {
  const tokens = [...nameTokens].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
  const tokenRe = tokens.length ? new RegExp(`(^|[^\\p{L}])(${tokens.map(escapeRe).join('|')})(?=$|[^\\p{L}])`, 'giu') : null;
  const ids = [...identifierStrings].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
  const idRe = ids.length ? new RegExp(`(${ids.map(escapeRe).join('|')})`, 'gi') : null;
  const fulls = [...fullNames].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
  const fullRe = fulls.length ? new RegExp(`(${fulls.map(escapeRe).join('|')})`, 'gi') : null;
  return (text, log, where, { keepLayout = false } = {}) => {
    let out = String(text ?? '');
    const before = out;
    if (fullRe) out = out.replace(fullRe, '[removed]');
    if (idRe) out = out.replace(idRe, '[removed]');
    if (tokenRe) out = out.replace(tokenRe, (m, pre) => `${pre}[removed]`);
    for (const re of [PII_PATTERNS.UPN_RE, PII_PATTERNS.EMAIL_RE, PII_PATTERNS.UK_PHONE_RE, PII_PATTERNS.POSTCODE_RE, PII_PATTERNS.LONG_DIGITS_RE]) {
      re.lastIndex = 0;
      out = out.replace(re, '[removed]');
    }
    if (!keepLayout) out = out.replace(/\s+/g, ' ').trim();
    if (out !== (keepLayout ? before : before.replace(/\s+/g, ' ').trim()) && log) log.push({ where, before, after: out });
    return out;
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scans the final payload. Returns { ok, findings:[{severity, type, match, context}] }.
export function guardPayload(payload, dataset) {
  const findings = [];
  const text = String(payload);
  const add = (severity, type, match, index, extra = {}) => {
    const start = Math.max(0, index - 40); const end = Math.min(text.length, index + String(match).length + 40);
    findings.push({
      severity,
      type,
      match,
      index,
      context: text.slice(start, end).replace(/\n/g, ' '),
      ...extra,
    });
  };

  // Full names and identifier strings, as whole strings.
  for (const full of dataset.fullNames) {
    if (full.length < 3) continue;
    const re = new RegExp(escapeRe(full), 'gi');
    let m; while ((m = re.exec(text))) add('block', 'pupil name', m[0], m.index);
  }
  for (const id of dataset.identifierStrings) {
    if (!id || id.length < 3) continue;
    const re = new RegExp(escapeRe(id), 'gi');
    let m; while ((m = re.exec(text))) add('block', 'identifier from report', m[0], m.index);
  }
  for (const ctx of dataset.contextStrings) {
    if (!ctx || ctx.length < 3 || /^\d{1,2}$/.test(ctx)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\d])${escapeRe(ctx)}(?=$|[^\\p{L}\\d])`, 'giu');
    let m; while ((m = re.exec(text))) add('block', 'class/teacher/school detail from report', ctx, m.index);
  }
  // Name tokens as whole words.
  const tokens = [...dataset.nameTokens].filter((t) => t.length >= 2);
  if (tokens.length) {
    const re = new RegExp(`(^|[^\\p{L}])(${tokens.map(escapeRe).join('|')})(?=$|[^\\p{L}])`, 'giu');
    let m; while ((m = re.exec(text))) add('block', 'pupil name token', m[2], m.index + m[1].length);
  }
  const patternChecks = [
    ['block', 'UPN', PII_PATTERNS.UPN_RE],
    ['block', 'email address', PII_PATTERNS.EMAIL_RE],
    ['block', 'phone number', PII_PATTERNS.UK_PHONE_RE],
    ['block', 'postcode', PII_PATTERNS.POSTCODE_RE],
    ['block', 'long number (possible ID)', PII_PATTERNS.LONG_DIGITS_RE],
    ['warn', 'date', PII_PATTERNS.DATE_RE],
  ];
  for (const [severity, type, re] of patternChecks) {
    re.lastIndex = 0;
    let m; while ((m = re.exec(text))) add(severity, type, m[0], m.index);
  }
  const already = new Set(findings.map((f) => String(f.match || '').toLowerCase()));
  for (const hit of scanCommonNames(text)) {
    if (already.has(hit.key) || already.has(String(hit.match).toLowerCase())) continue;
    add('warn', 'possible name', hit.match, hit.index, wordsAround(text, hit.index, hit.match));
    already.add(hit.key);
  }
  const blocked = findings.some((f) => f.severity === 'block');
  return { ok: !blocked, findings, source: text };
}

// ---------------------------------------------------------------------------
// Exports (CSV)
// ---------------------------------------------------------------------------

export function toCsv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = c == null ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

export function datasetToCsv(dataset, { withNames = false } = {}) {
  const active = dataset.assessments.filter((a) => !a.excluded);
  const measures = dataset.measures.filter((m) => !m.excluded);
  const header = [withNames ? 'Pupil' : 'Code'];
  const cols = [];
  for (const a of active) for (const m of measures) if (a.measures.has(m.key)) { header.push(`${a.name} — ${m.name}`); cols.push([a.key, m.key]); }
  const rows = [header];
  for (const p of dataset.pupils) {
    const row = [withNames ? p.displayName : p.code];
    for (const [ak, mk] of cols) { const rec = p.results.get(ak); row.push(rec ? rec[mk] ?? '' : ''); }
    rows.push(row);
  }
  return toCsv(rows);
}

export function keyToCsv(dataset) {
  return toCsv([['Code', 'Pupil', 'Source file'], ...dataset.pupils.map((p) => [p.code, p.displayName, p.sourceFile])]);
}

// ---------------------------------------------------------------------------

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let rnd;
  if (seed != null) {
    let s = seed >>> 0 || 1;
    rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  } else if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    rnd = () => { globalThis.crypto.getRandomValues(buf); return buf[0] / 4294967296; };
  } else {
    rnd = Math.random;
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
