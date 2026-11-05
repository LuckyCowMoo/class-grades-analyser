// Adaptive parser for per-pupil school report PDFs.
//
// Input: the row/cell structure produced by pdf-extract.js (plus the file name).
// Output: one or more pupil records containing
//   - fields:      labelled values found in the document ("Name: ...", "UPN: ...")
//                  each tagged with a privacy category
//   - assessments: [{ name, values: { <measure header>: <value> } }]
//   - measures:    the list of measure headers seen (Grade, Score, Target, ...)
//
// The parser does not assume a particular school system. It looks for
// (1) labelled key/value pairs, (2) tables with a header row, (3) tables
// without a header, and (4) "horizontal" tables where the assessment names
// run across the page and the values sit underneath.

// ---------------------------------------------------------------------------
// Labels and privacy categories
// ---------------------------------------------------------------------------

// identifying: must never leave the browser.
// sensitive:   personal but not identifying on its own; never sent.
// context:     school/class/teacher context; not needed by the AI, never sent.
// useful:      non-personal context that may be offered to the teacher (subject).
export const LABELS = [
  { re: /^(pupil|student|learner|child|candidate|legal|preferred|full)?\s*(full\s*)?name(\s*of\s*(pupil|student))?$/, key: 'name', cat: 'identifying' },
  { re: /^(pupil|student|learner|candidate)$/, key: 'name', cat: 'identifying' },
  { re: /^(known\s*as|preferred\s*(fore)?name|chosen\s*name)$/, key: 'preferredName', cat: 'identifying' },
  { re: /^(forename|first\s*name|given\s*name|legal\s*forename)s?$/, key: 'forename', cat: 'identifying' },
  { re: /^(surname|last\s*name|family\s*name|legal\s*surname)$/, key: 'surname', cat: 'identifying' },
  { re: /^(middle\s*name)s?$/, key: 'middleName', cat: 'identifying' },
  { re: /^(upn|unique\s*pupil\s*(number|no\.?|id)|uln|unique\s*learner\s*(number|no\.?))$/, key: 'upn', cat: 'identifying' },
  { re: /^(adm(ission)?\s*(no|number|num)\.?|adno|admission|student\s*(id|number|no\.?)|pupil\s*(id|number|no\.?)|learner\s*(id|number)|candidate\s*(no|number)\.?|exam\s*(no|number)\.?|arbor\s*id|mis\s*id|id)$/, key: 'admissionNo', cat: 'identifying' },
  { re: /^(date\s*of\s*birth|dob|d\.o\.b\.?|birth\s*date|born|birthday)$/, key: 'dob', cat: 'identifying' },
  { re: /^(address|home\s*address|postcode|post\s*code|email|e-?mail(\s*address)?|telephone|tel|phone|mobile|contact(\s*(number|details|name))?|parent(s)?(\s*\/\s*carer(s)?)?|carer(s)?|guardian|next\s*of\s*kin|emergency\s*contact)$/, key: 'contact', cat: 'identifying' },
  { re: /^(nhs\s*(no|number)\.?|ni\s*(no|number)\.?|passport(\s*no)?|photo|photograph)$/, key: 'otherId', cat: 'identifying' },
  { re: /^(gender|sex|ethnicity|ethnic\s*(group|origin)|nationality|religion|faith|first\s*language|home\s*language|language|eal|sen(d)?(\s*(status|stage|need))?|pupil\s*premium|pp|fsm|free\s*school\s*meals|looked\s*after|lac|cla|disability|medical(\s*(needs|conditions|information))?|dietary(\s*requirements)?)$/, key: 'sensitive', cat: 'sensitive' },
  { re: /^(attendance(\s*%|\s*percentage)?|punctuality|lates?|late\s*marks|authorised\s*absences?|unauthorised\s*absences?|absences?|sessions\s*missed|behaviour(\s*points)?|achievement\s*points|conduct\s*points|merits|demerits|detentions|sanctions|rewards|house\s*points|exclusions)$/, key: 'pastoral', cat: 'sensitive' },
  { re: /^(school|academy|college|establishment|school\s*name|head\s*(teacher|of\s*year|of\s*school)|headteacher|principal)$/, key: 'school', cat: 'context' },
  { re: /^((class|subject|form|group|set)\s*teacher|teacher(s)?|taught\s*by|tutor|form\s*tutor|personal\s*tutor|staff|teacher\s*name|hoy|head\s*of\s*(year|department|faculty))$/, key: 'teacher', cat: 'context' },
  { re: /^(form|form\s*group|tutor\s*group|reg(istration)?\s*group|reg|registration|class|teaching\s*group|teaching\s*set|set|group|class\s*code|class\s*name|band|house)$/, key: 'class', cat: 'context' },
  { re: /^(year|year\s*group|yr|nc\s*year|key\s*stage|ks)$/, key: 'yearGroup', cat: 'useful' },
  { re: /^(academic\s*year|term|reporting\s*period|report(\s*(date|period|name|cycle))?|date|date\s*(printed|of\s*report|published|issued)|printed(\s*on)?|generated(\s*on)?|published)$/, key: 'period', cat: 'context' },
  { re: /^(subject|course|qualification|exam\s*board|specification|spec|tier|level|course\s*title|programme)$/, key: 'subject', cat: 'useful' },
];

export function matchLabel(raw) {
  const label = normaliseLabel(raw);
  if (!label) return null;
  for (const l of LABELS) {
    if (l.re.test(label)) return { key: l.key, cat: l.cat, label: raw.trim().replace(/[:\-–—]+$/, '').trim() };
  }
  return null;
}

function normaliseLabel(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[:\-–—.*]+$/, '')
    .replace(/[()\[\]"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

const DESCRIPTORS = [
  // [regex, ordinal, scheme]
  [/^(working\s*towards(\s*(the\s*)?(expected\s*)?standard)?|wts|wt|below(\s*(expected|standard|age\s*related))?|pre[-\s]?key\s*stage|pks)$/, 1, 'standard'],
  [/^(working\s*at(\s*(the\s*)?expected(\s*standard)?)?|expected(\s*standard)?|exs|exp|ex|at(\s*(expected|standard|age\s*related))?|meeting(\s*expectations?)?|met|on\s*track|secure|achieved|age\s*related(\s*expectations?)?|are)$/, 2, 'standard'],
  [/^(greater\s*depth|gds|gd|above(\s*(expected|standard|age\s*related))?|exceeding(\s*expectations?)?|exceeded|mastery|mastered|beyond)$/, 3, 'standard'],
  [/^(emerging|beginning|developing|entering|foundation|novice|needs\s*(support|improvement))$/, 1, 'progress'],
  [/^(consolidating|improving|progressing|approaching|working\s*within|partially\s*met|partially)$/, 2, 'progress'],
  [/^(securing|established|competent|proficient|confident|secure\+)$/, 3, 'progress'],
  [/^(excelling|extending|advanced|exceptional|expert|outstanding)$/, 4, 'progress'],
  [/^(not\s*yet(\s*(met|achieved))?|not\s*met|not\s*achieved|unsuccessful|fail(ed)?|u|ungraded|x)$/, 0, 'pass'],
  [/^(pass(ed)?|p|successful|l1p|level\s*1\s*pass)$/, 1, 'pass'],
  [/^(merit|m|l2m|l1m)$/, 2, 'pass'],
  [/^(distinction|d|l2d|l1d)$/, 3, 'pass'],
  [/^(distinction\s*\*|d\*|l2d\*)$/, 4, 'pass'],
  [/^(red|r|cause\s*for\s*concern|concern|serious\s*concern|poor|unsatisfactory|inadequate|rarely)$/, 1, 'rag'],
  [/^(amber|a|some\s*concern|requires\s*improvement|ri|satisfactory|inconsistent|sometimes|variable)$/, 2, 'rag'],
  [/^(green|g|good|no\s*concern|usually|consistent)$/, 3, 'rag'],
  [/^(excellent|very\s*good|exemplary|always|outstanding)$/, 4, 'rag'],
  [/^(bronze)$/, 1, 'medal'], [/^(silver)$/, 2, 'medal'], [/^(gold)$/, 3, 'medal'], [/^(platinum)$/, 4, 'medal'],
  [/^(below\s*target|under\s*target|behind)$/, 1, 'target'],
  [/^(on\s*target|at\s*target|in\s*line)$/, 2, 'target'],
  [/^(above\s*target|ahead)$/, 3, 'target'],
  [/^(low|lower)$/, 1, 'lmh'], [/^(medium|middle|mid)$/, 2, 'lmh'], [/^(high|higher)$/, 3, 'lmh'],
  [/^(yes|y|complete(d)?|submitted|done|✓|✔|tick)$/, 1, 'bool'],
  [/^(no|n|incomplete|missing|not\s*submitted|late|✗|✘|cross)$/, 0, 'bool'],
];

const MISSING = /^(n\/?a|na|abs(ent)?|ab|x|-+|–|—|\.|…|none|not\s*(assessed|entered|available|applicable|sat)|no\s*(data|entry|grade|result)|tbc|tba|pending|awaiting|\?|nr|ne|dnq|w)$/i;

const LETTER_GRADES = { 'A*': 8, A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1, U: 0 };

// Returns null when the text does not look like an assessment value.
export function classifyValue(raw) {
  if (raw == null) return null;
  let t = String(raw).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.length > 40) return null;
  if (MISSING.test(t)) return { kind: 'missing', numeric: null, text: t };

  // "Grade 5", "Level 4b", "Band 3" -> strip the prefix.
  const prefixed = t.match(/^(grade|level|band|step|stage|score|mark|lvl|gr)\s*:?\s*(.+)$/i);
  if (prefixed) t = prefixed[2].trim();

  let m;
  if ((m = t.match(/^(-?\d{1,3}(?:\.\d+)?)\s*%$/))) {
    return { kind: 'percent', numeric: parseFloat(m[1]), text: t };
  }
  if ((m = t.match(/^(\d{1,4}(?:\.\d+)?)\s*(?:\/|out\s*of|of)\s*(\d{1,4}(?:\.\d+)?)$/i))) {
    const a = parseFloat(m[1]); const b = parseFloat(m[2]);
    return { kind: 'fraction', numeric: b > 0 ? Math.round((a / b) * 1000) / 10 : null, raw: a, outOf: b, text: t };
  }
  if ((m = t.match(/^([1-9])\s*([abc])$/i))) {
    // National curriculum style sub-levels 4a/4b/4c (a is highest).
    const sub = { a: 0.66, b: 0.33, c: 0 }[m[2].toLowerCase()];
    return { kind: 'level', numeric: parseInt(m[1], 10) + sub, text: t };
  }
  if ((m = t.match(/^([1-9])\s*([+\-=])$/))) {
    const adj = { '+': 0.33, '-': -0.33, '=': 0 }[m[2]];
    return { kind: 'gcse', numeric: parseInt(m[1], 10) + adj, text: t };
  }
  if ((m = t.match(/^([1-9])\s*\/\s*([1-9])$/)) && Math.abs(parseInt(m[1], 10) - parseInt(m[2], 10)) === 1) {
    // Combined science style "5/4".
    return { kind: 'gcse', numeric: (parseInt(m[1], 10) + parseInt(m[2], 10)) / 2, text: t };
  }
  if ((m = t.match(/^(A\*|[A-G]|U)\s*([+\-])?$/i))) {
    const key = m[1].toUpperCase();
    if (key.length === 1 && /^[A-G]$/.test(key) && m[2] == null && key !== 'U') {
      // A single letter is ambiguous (A/B/C could be RAG, effort or a grade).
      // We still accept it as a letter grade; descriptors handle A/G/R separately only
      // when the surrounding column looks like a RAG column.
    }
    return { kind: 'letter', numeric: (LETTER_GRADES[key] ?? null) + ({ '+': 0.33, '-': -0.33 }[m[2]] || 0), text: t };
  }
  if ((m = t.match(/^(-?\d{1,4}(?:\.\d+)?)$/))) {
    return { kind: 'number', numeric: parseFloat(m[1]), text: t };
  }
  if ((m = t.match(/^(-?\d{1,4}(?:\.\d+)?)\s*(marks?|pts?|points?)$/i))) {
    return { kind: 'number', numeric: parseFloat(m[1]), text: t };
  }
  if ((m = t.match(/^(\d{1,3})(st|nd|rd|th)$/i))) {
    return { kind: 'rank', numeric: parseInt(m[1], 10), text: t };
  }
  const lower = t.toLowerCase().replace(/[.!]+$/, '');
  for (const [re, ord, scheme] of DESCRIPTORS) {
    if (re.test(lower)) return { kind: 'descriptor', scheme, numeric: ord, text: t };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

const NAME_COL = /^(assessment|assessments|test|tests|topic|topics|unit|units|task|tasks|title|exam|exams|paper|module|component|assignment|strand|skill|skills|objective|objectives|subject|subjects|area|areas|criteria|criterion|theme|key\s*(topic|skill|area)|learning\s*objective|focus|activity|activities|name\s*of\s*(test|assessment|unit)|description|item|category|course|qualification|statement)$/i;

const MEASURE_COL = /(grade|result|score|\bmarks?\b|%|percent|percentage|\blevel|target|effort|attitude|\batl\b|attainment|progress|\bband\b|outcome|achieved|working\s*at|current|predict|forecast|expected|aspirational|minimum|\bmeg\b|\bfft\b|on\s*track|\brag\b|judgement|judgment|standard|rating|average|\bavg\b|\bmean\b|class\s*av|cohort|\brank\b|position|\btotal\b|\bmax\b|out\s*of|homework|behaviour|engagement|independence|organisation|participation|conduct|points|\bvalue\b|\braw\b|scaled|\bsub\b|\bfine\b|\bstep\b|\bstage\b|teacher\s*assessment|\bta\b|t\.a\.|autumn|spring|summer|\bterm\b|cycle|half\s*term|\bht\s?\d|\bmock|baseline|\bentry\b|\bexit\b|\bpre\b|\bpost\b|\bq\d|quiz|checkpoint|milestone|data\s*(drop|point|capture)|\bdc\s?\d|\bdp\s?\d|review|assessment\s*\d|test\s*\d|unit\s*\d|topic\s*\d|paper\s*\d)/i;

const SEMANTIC_FLAGS = [
  ['target', /(target|aspir|expected|predict|forecast|meg|fft|minimum|mtg|ftg|end\s*of\s*(year|key\s*stage|course))/i],
  ['effort', /(effort|attitude|atl|behaviour|homework|engagement|independence|organisation|participation|conduct|focus|respect|learning\s*habits|readiness|punctuality|equipment)/i],
  ['classAverage', /(class|cohort|group|year|national)\s*(average|avg|mean|median)|average|avg|mean|median/i],
  ['rank', /(rank|position|percentile)/i],
  ['attainment', /(grade|result|score|mark|%|percent|level|attainment|working\s*at|current|achieved|outcome|band|standard|raw|scaled|total|judgement|judgment|assessment|test|exam)/i],
];

export function measureFlags(header) {
  const flags = [];
  for (const [flag, re] of SEMANTIC_FLAGS) if (re.test(header)) flags.push(flag);
  if (!flags.length) flags.push('attainment');
  return flags;
}

const SUBJECT_WORDS = /^(maths?|mathematics|further\s*maths|numeracy|english(\s*(language|literature|lit|lang))?|literacy|reading|writing|spelling|phonics|grammar|spag|science|combined\s*science|trilogy|biology|chemistry|physics|history|geography|humanities|french|spanish|german|mandarin|chinese|latin|mfl|languages?|computing|computer\s*science|ict|it|art(\s*(and|&)\s*design)?|music|drama|dance|performing\s*arts|pe|physical\s*education|games|sport|re|rs|religious\s*(education|studies)|philosophy(\s*(and|&)\s*ethics)?|ethics|pshe|citizenship|dt|design(\s*(and|&)\s*)?technology|technology|food(\s*(technology|and\s*nutrition|prep(aration)?))?|textiles|resistant\s*materials|graphics|product\s*design|engineering|business(\s*studies)?|economics|psychology|sociology|politics|law|media(\s*studies)?|film(\s*studies)?|photography|health\s*(and|&)\s*social\s*care|child\s*development|travel\s*(and|&)\s*tourism|statistics|astronomy|geology|environmental\s*science|classics|classical\s*civilisation|life\s*skills|enrichment|tutor(ial)?|form)$/i;

export function looksLikeSubject(text) {
  return SUBJECT_WORDS.test(String(text || '').trim());
}

function isNameColumnHeader(text) {
  return NAME_COL.test(normaliseLabel(text));
}

function isMeasureHeader(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  if (classifyValue(t) && !/[a-z]{3,}/i.test(t)) return false; // a bare value, not a header
  return MEASURE_COL.test(t);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseReport(structure, { filename = '' } = {}) {
  const rows = [];
  for (const page of structure.pages) {
    for (const row of page.rows) rows.push({ ...row, page: page.pageNumber });
  }
  const fileInfo = parseFilename(filename);
  if (looksLikePupilProgress(rows)) {
    return { filename, fileInfo, pupils: [parsePupilProgress(rows, fileInfo, filename)], layout: 'pupil-progress' };
  }
  const segments = splitIntoPupils(rows);
  const pupils = segments.map((segRows, i) => parseSegment(segRows, fileInfo, segments.length > 1 ? i : null, filename));
  return { filename, fileInfo, pupils };
}

function looksLikePupilProgress(rows) {
  const t = rows.map((r) => r.text || r.cells.map((c) => c.text).join(' ')).join('\n').toLowerCase();
  return t.includes('live tracking') && t.includes('topic summary');
}

const PP_MID = 290; // left dashboard column vs right column on Pupil Progress reports

function cellCol(cell) {
  return cell.x >= PP_MID ? 'right' : 'left';
}

function parsePupilProgress(rows, fileInfo, filename) {
  const warnings = [];
  const fields = {};
  const assessments = [];
  const addField = (key, cat, label, value) => {
    const v = String(value || '').trim();
    if (!v) return;
    if (!fields[key]) fields[key] = [];
    fields[key].push({ label, value: v, cat, page: 1 });
  };
  const add = (name, values, kind) => {
    const n = String(name || '').replace(/\s+/g, ' ').replace(/\s*\/\s*%\s*$/, '').trim();
    if (!n || n.length > 140) return;
    const clean = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s === '') continue;
      clean[k] = s;
    }
    assessments.push({ name: n, values: clean, kind: kind || 'topic' });
  };

  const textOf = (row) => row.cells.map((c) => c.text).join(' | ');

  // Header band (usually the first page, top ~15 rows).
  for (const row of rows.slice(0, 20)) {
    const t = textOf(row);
    let m;
    if ((m = t.match(/GCSE\s+in\s+([^|]+)/i))) addField('subject', 'useful', 'Subject', m[1].trim());
    if ((m = t.match(/Year\s*Group\s+(\d{1,2})/i))) addField('yearGroup', 'useful', 'Year group', m[1]);
    else if ((m = t.match(/\bY(?:ear)?\s*(\d{1,2})\b/i)) && !fields.yearGroup) addField('yearGroup', 'useful', 'Year group', m[1]);
    if ((m = t.match(/\bClass\s+([A-Z0-9][A-Z0-9/._-]{1,20})/i))) addField('class', 'context', 'Class', m[1]);
    if (/christ\s*the\s*king/i.test(t) || /high\s*school/i.test(t)) addField('school', 'context', 'School', t.replace(/\s*\|\s*/g, ' '));
    const tm = t.match(/(?:class\s*teacher|teacher|taught\s*by|form\s*tutor|tutor)\s*:\s*([^|]+)/i);
    if (tm) addField('teacher', 'context', 'Teacher', tm[1].trim());
    else if (/^(?:ms|mr|mrs|miss|mx|dr)\.?\s+[A-Za-z]/i.test(t.trim())) addField('teacher', 'context', 'Teacher', t.trim());
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t.trim())) addField('period', 'context', 'Report date', t.trim());
  }

  // Pupil name: a short title-case line that is not school/teacher/date.
  const skipName = /year group|gcse|live tracking|christ the king|high school|sixth form|target grid|minimum target|ms |mr |mrs |miss /i;
  for (const row of rows.slice(0, 12)) {
    if (row.page !== 1) continue;
    const t = (row.cells[0] && row.cells[0].text || '').trim();
    if (t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 5 && /[A-Za-z]/.test(t) && !/\d{4}/.test(t) && !skipName.test(t) && !/\|/.test(t)) {
      addField('name', 'identifying', 'Name', t);
      break;
    }
  }

  // Headline grades sitting near "Minimum Target" / "Average Unit Grade".
  let minTarget = null;
  let avgUnit = null;
  for (let i = 0; i < rows.length; i++) {
    const texts = rows[i].cells.map((c) => c.text);
    const joined = texts.join(' ');
    if (/minimum\s*target/i.test(joined)) {
      for (const r of rows.slice(i, i + 6)) {
        for (const c of r.cells) {
          if (c.x < 200 && classifyValue(c.text) && classifyValue(c.text).kind !== 'missing' && Number(classifyValue(c.text).numeric) <= 9) {
            minTarget = c.text.trim();
          }
        }
      }
    }
    if (/average\s*unit\s*grade/i.test(joined) && avgUnit == null) {
      const next = rows[i + 3] || rows[i + 1];
      if (next) {
        const nums = next.cells.filter((c) => c.x > 250 && c.x < 400 && classifyValue(c.text));
        if (nums[0]) avgUnit = nums[0].text.trim();
      }
      // Fallback: a lone grade under the label on the same cluster.
      for (const r of rows.slice(i, i + 5)) {
        for (const c of r.cells) {
          if (c.x > 250 && c.x < 380 && classifyValue(c.text) && /^[1-9]$/.test(c.text.trim())) avgUnit = avgUnit || c.text.trim();
        }
      }
    }
  }
  if (minTarget) add('Minimum target grade', { Grade: minTarget }, 'headline');
  if (avgUnit) add('Average unit grade', { Grade: avgUnit }, 'headline');

  // Unit / paper grades across the top: "1: Non-calculator (33%)" with a grade underneath.
  const unitHeader = rows.find((r) => r.cells.some((c) => /non-calculator|end of topic tests/i.test(c.text)));
  if (unitHeader) {
    const hdrIdx = rows.indexOf(unitHeader);
    const valueRow = rows.slice(hdrIdx + 1, hdrIdx + 3).find((r) => r.cells.filter((c) => classifyValue(c.text)).length >= 1);
    const headers = unitHeader.cells.filter((c) => /end of topic|non-calculator|calculator/i.test(c.text));
    if (valueRow) {
      for (const h of headers) {
        let best = null; let bestD = 80;
        for (const c of valueRow.cells) {
          const d = Math.abs((c.x + c.end) / 2 - (h.x + h.end) / 2);
          if (d < bestD && classifyValue(c.text)) { bestD = d; best = c; }
        }
        if (best) add(h.text.replace(/\s+/g, ' ').trim(), { Grade: best.text.trim() }, 'paper');
      }
    }
  }

  // Attitude to learning strip.
  const atlRow = rows.find((r) => r.cells.some((c) => /atl\s*classwork/i.test(c.text)));
  if (atlRow) {
    const idx = rows.indexOf(atlRow);
    const valRow = rows[idx + 1];
    const atlValues = {};
    if (valRow) {
      for (const h of atlRow.cells) {
        let best = null; let bestD = 60;
        for (const c of valRow.cells) {
          const d = Math.abs(c.x - h.x);
          if (d < bestD && classifyValue(c.text)) { bestD = d; best = c; }
        }
        const key = h.text.replace(/^AtL\s*/i, '').trim();
        if (best && key) atlValues[key] = best.text.trim();
      }
    }
    if (Object.keys(atlValues).length) add('Attitude to learning', atlValues, 'atl');
  }

  // Topic summary (left) plus areas of strength / progress opportunities (right).
  let modeRight = 'strength';
  for (const row of rows) {
    if (row.page !== 1) continue;
    const left = row.cells.filter((c) => cellCol(c) === 'left');
    const right = row.cells.filter((c) => cellCol(c) === 'right');
    const leftText = left.map((c) => c.text).join(' ');
    const rightText = right.map((c) => c.text).join(' ');
    if (/progress opportunities/i.test(rightText)) modeRight = 'gap';
    if (/areas of strength/i.test(rightText)) modeRight = 'strength';

    const topicCell = left.find((c) => /[A-Za-z]{3,}/.test(c.text) && !/topic summary|^%$/i.test(c.text));
    const topicVal = left.find((c) => classifyValue(c.text) && c !== topicCell);
    if (topicCell && /:|number|algebra|ratio|geometry|probability|statistics|measures/i.test(topicCell.text)) {
      add(topicCell.text, topicVal ? { '%': topicVal.text.trim() } : {}, 'topic');
    }

    const skillCell = right.find((c) => /^[A-Z]\d+\b/.test(c.text.trim()) || / - /.test(c.text));
    const skillVal = right.find((c) => classifyValue(c.text) && c !== skillCell);
    if (skillCell && !/progress opportunities|areas of strength|topic summary/i.test(skillCell.text)) {
      add(skillCell.text, skillVal ? { '%': skillVal.text.trim() } : {}, modeRight === 'gap' ? 'gap' : 'strength');
    }
  }

  // Page 2+: two paper columns and question-level analysis.
  let paperContext = { left: 'End of Topic Tests', right: 'Paper' };
  let qlaBuffer = null;
  const flushQla = () => {
    if (qlaBuffer && qlaBuffer.name) {
      const vals = {};
      if (qlaBuffer.marks != null) vals.Marks = qlaBuffer.outOf ? `${qlaBuffer.marks}/${qlaBuffer.outOf}` : String(qlaBuffer.marks);
      add(qlaBuffer.name.replace(/\s+\d+$/, '').replace(/\s+/g, ' ').trim(), vals, 'skill');
    }
    qlaBuffer = null;
  };

  for (const row of rows) {
    if (row.page === 1) continue;
    const left = row.cells.filter((c) => cellCol(c) === 'left');
    const right = row.cells.filter((c) => cellCol(c) === 'right');
    const handlePaperCells = (cells, side) => {
      const joined = cells.map((c) => c.text).join(' ');
      if (/question level analysis/i.test(joined)) return 'qla';
      if (/^(end of topic tests|1:\s*non-calculator|2:\s*calculator|3:\s*calculator)/i.test(joined.trim())) {
        paperContext[side] = joined.replace(/\s+/g, ' ').replace(/\bGrade\b/ig, '').trim();
        return 'section';
      }
      const label = cells.find((c) => /[A-Za-z]{3,}/.test(c.text) && !/^(total|marks|grade)$/i.test(c.text));
      const nums = cells.filter((c) => classifyValue(c.text) && (!label || c !== label));
      if (!label) return null;
      const name = label.text.replace(/\s+/g, ' ').trim();
      if (/^https?:\/\//i.test(name) || /^\/\s*\d+$/.test(name)) return null;
      if (/^current unit grade$/i.test(name)) {
        if (nums[0]) add(`${paperContext[side]} – current unit grade`, { Grade: nums[0].text.trim() }, 'headline');
        return 'paper';
      }
      if (/raw total marks|average total marks|paper|mock|test|exam/i.test(name)) {
        flushQla();
        const values = {};
        const frac = name.match(/\/\s*(\d+)\s*$/);
        if (nums[0] && frac) values.Marks = `${nums[0].text.trim()}/${frac[1]}`;
        else if (nums[0]) values.Marks = nums[0].text.trim();
        if (nums[1]) values.Grade = nums[1].text.trim();
        const cleanName = name.replace(/\s*\/\s*\d+\s*$/, '').trim();
        const titled = /end of|mock|paper|test|exam/i.test(cleanName) ? cleanName : `${paperContext[side]} – ${cleanName}`;
        if (Object.keys(values).length) add(titled, values, 'paper');
        return 'paper';
      }
      return null;
    };
    const leftKind = handlePaperCells(left, 'left');
    const rightKind = handlePaperCells(right, 'right');

    const rJoin = right.map((c) => c.text).join(' ');
    if (rightKind === 'paper' || /raw total marks|average total marks|current unit grade|past paper/i.test(rJoin)) {
      flushQla();
      continue;
    }
    const qm = rJoin.match(/^(\d+)\)\s+(.+)/);
    if (qm) {
      flushQla();
      qlaBuffer = { name: qm[2].replace(/https?:\/\/\S+/g, '').replace(/\s*\/\s*\d+\s*$/, '').trim(), marks: null, outOf: null };
      const n = right.find((c) => classifyValue(c.text) && /^[0-9]+$/.test(c.text.trim()));
      if (n) qlaBuffer.marks = n.text.trim();
      const of = rJoin.match(/\/\s*(\d+)\s*$/);
      if (of) qlaBuffer.outOf = of[1];
    } else if (qlaBuffer) {
      const extra = right
        .map((c) => c.text)
        .join(' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s*\/\s*(\d+)\s*$/, (_, n) => { qlaBuffer.outOf = qlaBuffer.outOf || n; return ''; })
        .replace(/\s+/g, ' ')
        .trim();
      if (extra && !/^(total|marks|grade)$/i.test(extra) && !classifyValue(extra)) {
        qlaBuffer.name = `${qlaBuffer.name} ${extra}`.replace(/\s+/g, ' ').trim();
      }
      const n = right.find((c) => classifyValue(c.text) && qlaBuffer.marks == null && /^[0-9]+$/.test(c.text.trim()));
      if (n) qlaBuffer.marks = n.text.trim();
    }
  }
  flushQla();

  // Deduplicate identical name+kind rows (page-2 repeats).
  const seen = new Set();
  const uniq = [];
  for (const a of assessments) {
    const key = `${a.kind}|${a.name.toLowerCase()}|${JSON.stringify(a.values)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(a);
  }

  if (!uniq.length) warnings.push('No assessment table could be detected in this file.');

  const nameField = (fields.name || [])[0];
  const displayName = (nameField && nameField.value) || fileInfo.name || fileInfo.base || 'Unknown pupil';
  const nameTokens = new Set();
  const addTokens = (s) => {
    for (const tok of String(s || '').split(/[^\p{L}'’\-]+/u)) {
      const clean = tok.replace(/^['’\-]+|['’\-]+$/g, '');
      if (clean.length >= 2) nameTokens.add(clean.toLowerCase());
    }
  };
  addTokens(displayName);
  (fileInfo.nameTokens || []).forEach((t) => nameTokens.add(String(t).toLowerCase()));

  const identifiers = new Set();
  if (fileInfo.upn) identifiers.add(fileInfo.upn);
  for (const row of rows) {
    for (const cell of row.cells) {
      for (const id of findIdentifiers(cell.text)) identifiers.add(id);
    }
  }

  const subjectHints = new Set();
  for (const f of fields.subject || []) subjectHints.add(f.value.replace(/\s*\|\s*/g, ' ').trim());
  const yearGroup = (fields.yearGroup || []).map((f) => f.value)[0] || fileInfo.yearGroup || null;
  const measures = [];
  const measureSet = new Set();
  for (const a of uniq) {
    for (const m of Object.keys(a.values)) {
      if (!measureSet.has(m)) { measureSet.add(m); measures.push(m); }
    }
  }

  return {
    displayName,
    nameTokens: [...nameTokens],
    identifiers: [...identifiers],
    fields,
    assessments: uniq,
    measures,
    excluded: [],
    rowsAreSubjects: false,
    subjectHints: [...subjectHints],
    yearGroup,
    warnings,
    sourceFile: filename,
    segmentIndex: null,
    rowCount: rows.length,
    layout: 'pupil-progress',
  };
}

// Splits a multi-pupil PDF (e.g. a bulk export) into one segment per pupil.
function splitIntoPupils(rows) {
  const segments = [];
  let current = [];
  let currentName = null;
  let currentPage = null;
  for (const row of rows) {
    const nameHere = findNameInRow(row);
    if (nameHere && currentName && nameHere.toLowerCase() !== currentName.toLowerCase() && row.page !== currentPage && current.length) {
      segments.push(current);
      current = [];
      currentName = null;
    }
    if (nameHere && !currentName) {
      currentName = nameHere;
      currentPage = row.page;
    }
    current.push(row);
  }
  if (current.length) segments.push(current);
  return segments.length ? segments : [rows];
}

function findNameInRow(row) {
  const fields = extractFieldsFromRow(row);
  const f = fields.find((x) => x.key === 'name');
  return f ? f.value : null;
}

function parseSegment(rows, fileInfo, segmentIndex, filename) {
  const fields = {};
  const fieldRowIdx = new Set();
  const warnings = [];

  rows.forEach((row, idx) => {
    // A table header such as "Subject | Current Grade | Target" must not be read as "Subject: Current Grade".
    if (analyseHeader(row)) return;
    const found = extractFieldsFromRow(row);
    if (found.length) {
      fieldRowIdx.add(idx);
      for (const f of found) {
        if (!fields[f.key]) fields[f.key] = [];
        fields[f.key].push({ label: f.label, value: f.value, cat: f.cat, page: row.page });
      }
    }
  });

  // Work out the pupil's name (local only).
  const nameParts = [];
  const take = (key) => (fields[key] || []).map((f) => f.value);
  nameParts.push(...take('name'), ...take('preferredName'), ...take('forename'), ...take('middleName'), ...take('surname'));
  const docName = buildDisplayName(fields);
  const docText = rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
  const wordInDoc = (tok) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(tok)}(?=$|[^\\p{L}])`, 'iu').test(docText);

  // Filename tokens that actually occur in the document are almost certainly the
  // pupil's name; tokens that never occur ("Report", "Combined", ...) are noise.
  const fileTokens = fileInfo.nameTokens.filter((t) => t.length >= 2);
  const confirmedFileTokens = fileTokens.filter(wordInDoc);
  const titleName = !docName ? findTitleName(rows, confirmedFileTokens) : '';

  let displayName = docName || titleName || fileInfo.name || '';
  if (!displayName && segmentIndex != null) displayName = `Unknown pupil ${segmentIndex + 1}`;
  if (!displayName) displayName = fileInfo.base || 'Unknown pupil';

  const nameTokens = new Set();
  const addTokens = (s) => {
    for (const tok of String(s || '').split(/[^\p{L}'’\-]+/u)) {
      const clean = tok.replace(/^['’\-]+|['’\-]+$/g, '');
      if (clean.length >= 2) nameTokens.add(clean.toLowerCase());
    }
  };
  nameParts.forEach(addTokens);
  addTokens(titleName);
  if (docName || titleName || confirmedFileTokens.length) {
    confirmedFileTokens.forEach((t) => nameTokens.add(t.toLowerCase()));
  } else {
    // Nothing in the document confirms the filename (e.g. a scanned PDF with no text):
    // err on the side of caution and scrub every filename token.
    fileTokens.forEach((t) => nameTokens.add(t.toLowerCase()));
  }
  // Also catch "Smith, John" -> both orders, and apostrophe variants.
  for (const tok of [...nameTokens]) {
    if (tok.includes('’')) nameTokens.add(tok.replace(/’/g, "'"));
    if (tok.includes("'")) nameTokens.add(tok.replace(/'/g, '’'));
  }

  // Identifiers found anywhere in the text (UPNs etc.), not only in labelled fields.
  const identifiers = new Set();
  if (fileInfo.upn) identifiers.add(fileInfo.upn);
  for (const row of rows) {
    for (const cell of row.cells) {
      for (const id of findIdentifiers(cell.text)) identifiers.add(id);
    }
  }
  for (const f of fields.upn || []) identifiers.add(f.value);
  for (const f of fields.admissionNo || []) identifiers.add(f.value);

  // Assessment tables.
  const tables = extractTables(rows, fieldRowIdx);
  const assessments = [];
  const measures = [];
  const measureSet = new Set();
  const excluded = [];
  for (const table of tables) {
    for (const m of table.measures) {
      if (!measureSet.has(m)) { measureSet.add(m); measures.push(m); }
    }
    for (const a of table.rows) {
      const label = matchLabel(a.name);
      if (label && (label.cat === 'identifying' || label.cat === 'sensitive' || label.cat === 'context')) {
        excluded.push({ name: a.name, reason: label.cat, values: a.values });
        continue;
      }
      assessments.push(a);
    }
  }
  if (!assessments.length) warnings.push('No assessment table could be detected in this file.');

  const subjectHints = new Set();
  for (const f of fields.subject || []) subjectHints.add(f.value);
  const subjectRows = assessments.filter((a) => looksLikeSubject(a.name)).length;
  const rowsAreSubjects = assessments.length >= 3 && subjectRows / assessments.length >= 0.6;
  for (const row of rows) {
    if (row.cells.length === 1 && looksLikeSubject(row.cells[0].text)) subjectHints.add(row.cells[0].text.trim());
  }

  const yearGroup = (fields.yearGroup || []).map((f) => f.value)[0] || fileInfo.yearGroup || null;

  return {
    displayName,
    nameTokens: [...nameTokens],
    identifiers: [...identifiers],
    fields,
    assessments,
    measures,
    excluded,
    rowsAreSubjects,
    subjectHints: [...subjectHints],
    yearGroup,
    warnings,
    sourceFile: filename,
    segmentIndex,
    rowCount: rows.length,
  };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Looks for the pupil's name in a title line such as "Ava Taylor - Year 7 Mathematics"
// using the tokens we already know from the file name.
function findTitleName(rows, tokens) {
  if (!tokens.length) return '';
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  for (const row of rows.slice(0, 12)) {
    for (const cell of row.cells) {
      const words = cell.text.split(/\s+/);
      const idx = words.map((w) => lowerTokens.includes(w.replace(/[^\p{L}'’\-]/gu, '').toLowerCase()));
      const first = idx.indexOf(true);
      const last = idx.lastIndexOf(true);
      if (first === -1) continue;
      const hits = idx.filter(Boolean).length;
      if (hits >= Math.min(2, lowerTokens.length) && last - first <= 3) {
        return words.slice(first, last + 1).join(' ').replace(/[,:;\-–—]+$/, '').trim();
      }
    }
  }
  return '';
}

function buildDisplayName(fields) {
  const first = (key) => (fields[key] || []).map((f) => f.value).find((v) => v);
  const full = first('name');
  if (full) {
    // "Smith, John" -> "John Smith"
    const m = full.match(/^([^,]+),\s*(.+)$/);
    return m ? `${m[2].trim()} ${m[1].trim()}` : full.trim();
  }
  const fore = first('preferredName') || first('forename');
  const sur = first('surname');
  if (fore || sur) return [fore, sur].filter(Boolean).join(' ');
  return '';
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function extractFieldsFromRow(row) {
  const out = [];
  const cells = row.cells;
  for (let i = 0; i < cells.length; i++) {
    const text = cells[i].text;
    // "Label: value" inside one cell
    const m = text.match(/^([^:]{1,40}):\s*(.+)$/);
    if (m) {
      const lab = matchLabel(m[1]);
      if (lab && m[2].trim()) {
        // The value might itself contain another "Label: value" (e.g. "Name: J Smith Form: 9X").
        const inner = m[2].match(/^(.*?)\s{1,}([A-Za-z][A-Za-z .\/]{1,30}):\s*(.+)$/);
        if (inner && matchLabel(inner[2])) {
          out.push({ ...lab, value: inner[1].trim() });
          const lab2 = matchLabel(inner[2]);
          out.push({ ...lab2, value: inner[3].trim() });
        } else {
          out.push({ ...lab, value: m[2].trim() });
        }
        continue;
      }
    }
    // "Label" followed by a value in the next cell
    const lab = matchLabel(text);
    if (lab && i + 1 < cells.length) {
      const next = cells[i + 1].text;
      if (!matchLabel(next) || /\d/.test(next)) {
        if (next && !/^[:\-–—]$/.test(next)) {
          out.push({ ...lab, value: next.replace(/^[:\-–—]\s*/, '').trim() });
          i++;
          continue;
        }
      }
    }
  }
  return out;
}

const UPN_RE = /\b[A-HJ-NP-RT-Z]\d{12}\b|\b[A-HJ-NP-RT-Z]\d{11}[A-Z]\b/g; // permanent and temporary UPNs
const ULN_RE = /\b\d{10}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const UK_PHONE_RE = /(?:(?:\+44\s?\d{4}|\(?0\d{4}\)?)\s?\d{3}\s?\d{3}|(?:\+44\s?\d{3}|\(?0\d{3}\)?)\s?\d{3}\s?\d{4}|(?:\+44\s?\d{2}|\(?0\d{2}\)?)\s?\d{4}\s?\d{4}|\b07\d{3}\s?\d{3}\s?\d{3}\b)\b/g;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
const DATE_RE = /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b/gi;
const FULL_DATE_RE = /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-](?:19|20)\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}\b/gi;
const LONG_DIGITS_RE = /\b\d{6,}\b/g;

export function findIdentifiers(text) {
  const out = [];
  const s = String(text || '');
  for (const re of [UPN_RE, ULN_RE, EMAIL_RE, UK_PHONE_RE, POSTCODE_RE, LONG_DIGITS_RE, FULL_DATE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) out.push(m[0]);
  }
  return out;
}

export const PII_PATTERNS = { UPN_RE, ULN_RE, EMAIL_RE, UK_PHONE_RE, POSTCODE_RE, DATE_RE, FULL_DATE_RE, LONG_DIGITS_RE };

// ---------------------------------------------------------------------------
// Filename parsing: "John-Smith-A123456789012.pdf", "Smith, John - 9X.pdf", ...
// ---------------------------------------------------------------------------

const FILENAME_NOISE = /^(report|reports|progress|assessment|assessments|grade|grades|card|cards|term|termly|autumn|spring|summer|year|yr|y\d{1,2}|class|form|set|group|data|pdf|student|pupil|learner|final|draft|copy|v\d+|\d+|ks\d|gcse|a\s*level|interim|full|summary|hy|ht\d|cycle\d*|dc\d*|dp\d*|tracking|tracker|export|download|individual|academic|school|academy|college|the|of|and|for)$/i;

export function parseFilename(filename) {
  const justName = String(filename || '').split(/[\\/]/).pop() || '';
  const base = justName.replace(/\.pdf$/i, '');
  let upn = null;
  let working = base;
  const upnMatch = working.match(/[A-HJ-NP-RT-Z]\d{12}|[A-HJ-NP-RT-Z]\d{11}[A-Z]/);
  if (upnMatch) {
    upn = upnMatch[0];
    working = working.replace(upnMatch[0], ' ');
  }
  let yearGroup = null;
  const ym = working.match(/\b(?:year|yr|y)\s*[-_ ]?(\d{1,2})\b/i);
  if (ym) yearGroup = ym[1];
  const tokens = working
    // "GeorgeDavies" -> "George Davies"
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .split(/[\s_\-–—,.()\[\]]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const nameTokens = tokens.filter((t) => /^[\p{L}'’]+$/u.test(t) && !FILENAME_NOISE.test(t));
  // "Smith, John" ordering -> keep tokens but display as given.
  const name = nameTokens.join(' ');
  return { base, upn, yearGroup, nameTokens, name };
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

function extractTables(rows, skipIdx) {
  const tables = [];
  const used = new Set();

  // Pass 1: tables with a header row.
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i) || skipIdx.has(i)) continue;
    const header = analyseHeader(rows[i]);
    if (!header) continue;
    const table = collectTableBelow(rows, i, header, used, skipIdx);
    if (table && table.rows.length) {
      tables.push(table);
      used.add(i);
      table.rowIdx.forEach((k) => used.add(k));
    }
  }

  // Pass 2: horizontal tables (names across, values below).
  for (let i = 0; i < rows.length - 1; i++) {
    if (used.has(i) || skipIdx.has(i)) continue;
    const table = collectHorizontalTable(rows, i, used, skipIdx);
    if (table && table.rows.length >= 2) {
      tables.push(table);
      table.rowIdx.forEach((k) => used.add(k));
    }
  }

  // Pass 3: header-less vertical runs of "text | value [| value]".
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i) || skipIdx.has(i)) continue;
    const table = collectHeaderlessTable(rows, i, used, skipIdx);
    if (table && table.rows.length >= 2) {
      tables.push(table);
      table.rowIdx.forEach((k) => used.add(k));
    }
  }

  return tables;
}

function analyseHeader(row) {
  const cells = row.cells;
  if (cells.length < 2 || cells.length > 24) return null;
  // Rows made of "Label: value" pairs are metadata, not table headers.
  const labelled = cells.filter((c) => { const m = c.text.match(/^([^:]{1,40}):\s*\S/); return m && matchLabel(m[1]); }).length;
  if (labelled > 0 && labelled >= cells.length / 2) return null;
  const cols = cells.map((c) => ({
    x: c.x, end: c.end, text: c.text,
    isName: isNameColumnHeader(c.text),
    isMeasure: isMeasureHeader(c.text),
    isValue: !!classifyValue(c.text),
  }));
  const measureCount = cols.filter((c) => c.isMeasure && !c.isValue).length;
  const nameCount = cols.filter((c) => c.isName).length;
  if (measureCount === 0) return null;
  if (cols.filter((c) => c.isValue && !c.isMeasure).length > cols.length / 2) return null;
  // Header must have mostly short texts.
  if (cols.some((c) => c.text.length > 70)) return null;
  // Decide the name column: an explicit one, otherwise the first column.
  let nameIdx = cols.findIndex((c) => c.isName);
  if (nameIdx === -1) nameIdx = 0;
  if (nameCount === 0 && measureCount < 1) return null;
  if (nameIdx !== 0 && cols[0].isMeasure && cols.length === 2) nameIdx = 0;
  return { cols, nameIdx, y: row.y, page: row.page };
}

function assignToColumns(row, header) {
  // Map each cell to the header column it belongs to by horizontal overlap/nearness.
  const assigned = new Array(header.cols.length).fill(null);
  for (const cell of row.cells) {
    let best = -1; let bestScore = Infinity;
    header.cols.forEach((col, k) => {
      const overlap = Math.min(cell.end, col.end + 2) - Math.max(cell.x, col.x - 2);
      let score;
      if (overlap > 0) score = -overlap;
      else score = Math.min(Math.abs(cell.x - col.x), Math.abs(cell.end - col.end), Math.abs((cell.x + cell.end) / 2 - (col.x + col.end) / 2));
      if (score < bestScore) { bestScore = score; best = k; }
    });
    if (best === -1) continue;
    if (bestScore > 0 && bestScore > 60) continue; // too far from any column
    assigned[best] = assigned[best] ? `${assigned[best]} ${cell.text}` : cell.text;
  }
  return assigned;
}

function collectTableBelow(rows, headerIdx, header, used, skipIdx) {
  const out = [];
  const rowIdx = [];
  const measureIdx = header.cols.map((c, k) => k).filter((k) => k !== header.nameIdx);
  const measures = measureIdx.map((k) => header.cols[k].text);
  let misses = 0;
  let lastRow = null;
  let lastY = header.y;
  let lastPage = header.page;
  for (let j = headerIdx + 1; j < rows.length; j++) {
    if (used.has(j)) break;
    const row = rows[j];
    if (row.page !== lastPage) {
      // Continue across a page break only if the next page starts with data rows.
      lastPage = row.page; lastY = row.y + 1000;
    }
    if (skipIdx.has(j)) { misses++; if (misses > 1) break; continue; }
    if (analyseHeader(row) && j !== headerIdx) {
      // A new header: if it looks like the same header repeated (page break), continue.
      const same = row.cells.length === header.cols.length && row.cells.every((c, k) => c.text === header.cols[k].text);
      if (same) { rowIdx.push(j); continue; }
      break;
    }
    const assigned = assignToColumns(row, header);
    const name = assigned[header.nameIdx];
    const values = {};
    const raw = {};
    let valueCount = 0;
    let textInMeasures = 0;
    measureIdx.forEach((k) => {
      const v = assigned[k];
      if (v == null) return;
      raw[header.cols[k].text] = v;
      const cls = classifyValue(v);
      if (cls) { values[header.cols[k].text] = v; valueCount++; }
      else textInMeasures++;
    });
    const gap = lastY - row.y;
    if (valueCount === 0) {
      // Wrapped text continuing the previous row: either the assessment name
      // ("Fractions, Decimals &" / "Percentages") or a long descriptor
      // ("Requires" / "Improvement").
      const isShortContinuation = lastRow && gap < 30 && row.cells.length <= 2 && (!name || name.length < 60);
      if (isShortContinuation) {
        let merged = false;
        if (name && !/[.:]$/.test(lastRow.name)) {
          lastRow.name = `${lastRow.name} ${name}`.trim();
          merged = true;
        }
        for (const [h, v] of Object.entries(raw)) {
          const combined = lastRow.raw[h] ? `${lastRow.raw[h]} ${v}` : v;
          lastRow.raw[h] = combined;
          if (classifyValue(combined)) { lastRow.values[h] = combined; merged = true; }
          else if (!lastRow.values[h]) merged = true;
        }
        if (merged) {
          rowIdx.push(j);
          lastY = row.y;
          continue;
        }
      }
      misses++;
      if (misses > 1 || row.cells.length === 1 && row.cells[0].text.length > 80) break;
      continue;
    }
    if (!name || name.length > 120 || (textInMeasures > valueCount)) {
      if (!name && valueCount > 0 && lastRow && Object.keys(lastRow.values).length < measures.length) {
        // Values on a continuation line.
        Object.assign(lastRow.values, values);
        rowIdx.push(j);
        continue;
      }
      misses++;
      if (misses > 1) break;
      continue;
    }
    misses = 0;
    lastRow = { name: name.trim(), values, raw, page: row.page };
    out.push(lastRow);
    rowIdx.push(j);
    lastY = row.y;
  }
  for (const r of out) delete r.raw;
  return { kind: 'vertical', measures, rows: out, rowIdx };
}

function collectHorizontalTable(rows, i, used, skipIdx) {
  const head = rows[i];
  if (head.cells.length < 2) return null;
  const next = rows[i + 1];
  if (!next || used.has(i + 1) || skipIdx.has(i + 1)) return null;
  // Header cells must be text (not values); allow a leading blank/label cell.
  const headCells = head.cells;
  const headValueCount = headCells.filter((c) => classifyValue(c.text) && !/[a-z]{3,}/i.test(c.text)).length;
  if (headValueCount > 0) return null;
  if (headCells.some((c) => c.text.length > 60)) return null;

  const valueRows = [];
  const rowIdx = [i];
  for (let j = i + 1; j < rows.length && j <= i + 8; j++) {
    if (used.has(j) || skipIdx.has(j)) break;
    const r = rows[j];
    const cells = r.cells;
    if (cells.length < 2) break;
    const classified = cells.map((c) => classifyValue(c.text));
    const valueCells = classified.filter(Boolean).length;
    const firstIsLabel = !classified[0] && /[a-z]/i.test(cells[0].text) && cells[0].text.length < 50;
    if (valueCells >= Math.max(2, cells.length - 1) && (valueCells === cells.length || firstIsLabel)) {
      valueRows.push({ label: firstIsLabel ? cells[0].text : null, cells, classified, firstIsLabel });
      rowIdx.push(j);
    } else break;
  }
  if (!valueRows.length) return null;

  // Align header columns and value columns by x.
  const header = { cols: headCells.map((c) => ({ x: c.x, end: c.end, text: c.text })), nameIdx: -1 };
  const names = [];
  const measures = valueRows.map((vr, k) => vr.label || (valueRows.length === 1 ? 'Result' : `Value ${k + 1}`));
  const result = header.cols.map(() => ({}));
  let totalAssigned = 0;
  valueRows.forEach((vr, k) => {
    const assigned = assignToColumns({ cells: vr.cells }, header);
    assigned.forEach((v, colIdx) => {
      if (v == null) return;
      if (vr.firstIsLabel && colIdx === 0 && v === vr.cells[0].text) return; // label cell
      if (!classifyValue(v)) return;
      result[colIdx][measures[k]] = v;
      totalAssigned++;
    });
  });
  if (totalAssigned < 2) return null;
  const out = [];
  header.cols.forEach((col, idx) => {
    if (Object.keys(result[idx]).length === 0) return;
    if (!/[a-z]/i.test(col.text)) return;
    out.push({ name: col.text, values: result[idx], page: head.page });
  });
  return { kind: 'horizontal', measures, rows: out, rowIdx };
}

function collectHeaderlessTable(rows, i, used, skipIdx) {
  const out = [];
  const rowIdx = [];
  let width = null;
  let lastY = null;
  for (let j = i; j < rows.length; j++) {
    if (used.has(j) || skipIdx.has(j)) break;
    const r = rows[j];
    if (r.cells.length < 2 || r.cells.length > 8) break;
    const name = r.cells[0].text;
    if (classifyValue(name) || name.length > 90 || !/[a-z]{2,}/i.test(name)) break;
    if (matchLabel(name) && matchLabel(name).cat !== 'useful') {
      // Skip labelled context rows but don't end the table for a single one.
      if (out.length) { rowIdx.push(j); continue; }
      break;
    }
    const vals = r.cells.slice(1).map((c) => classifyValue(c.text));
    if (vals.some((v) => !v)) break;
    if (lastY != null && r.page === rows[rowIdx[rowIdx.length - 1]].page && lastY - r.y > 60) break;
    if (width == null) width = vals.length;
    const values = {};
    vals.forEach((v, k) => { values[defaultMeasureName(v, k, vals.length)] = r.cells[k + 1].text; });
    out.push({ name, values, page: r.page });
    rowIdx.push(j);
    lastY = r.y;
  }
  if (out.length < 2) return null;
  const measures = [];
  for (const o of out) for (const m of Object.keys(o.values)) if (!measures.includes(m)) measures.push(m);
  return { kind: 'headerless', measures, rows: out, rowIdx };
}

function defaultMeasureName(cls, k, n) {
  if (n === 1) {
    if (cls.kind === 'percent' || cls.kind === 'fraction') return 'Score';
    if (cls.kind === 'descriptor') return 'Judgement';
    return 'Grade';
  }
  return `Value ${k + 1}`;
}
