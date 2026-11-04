import * as pdfjsLib from '../vendor/pdf.min.js';
import { extractPdfStructure } from './pdf-extract.js';
import { parseReport, classifyValue } from './parse-report.js';
import { buildClassDataset, buildPayload, guardPayload, reidentify, pupilsFromKey } from './anonymise.js?v=2';
import { fetchModels, rankFreeReasoningModels, runWithFallback, fetchModelCard, explainAiError, OPENROUTER_BASE, FREE_ROUTER_ID } from './ai-client.js?v=4';
import { buildOutgoing } from './prompt.js?v=3';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { attachReportStream } from './report-stream.js';

window.__appBooted = true;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).toString();

const SETTINGS_KEY = 'cga.settings.v1';
const REPORTS_KEY = 'cga.reports.v1';
const PROMPT_KEY = 'cga.prompt.v1';
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  settings: {
    apiKey: '', rememberKey: true, provider: 'openrouter', customUrl: '', customModel: '',
    dataCollection: 'deny', includePastoral: false, model: 'auto', referer: '',
  },
  sessionKey: '',
  files: [],
  parsedPupils: [],
  dataset: null,
  payload: '',
  outgoing: null,
  guard: null,
  models: [], ranked: [], rankedAll: [],
  result: null,
  messages: [],
  showNames: true,
  abort: null,
  templateTopics: [],
  screen: 'home',
  analysePhase: 'idle',
};

let transitioning = false;

function currentKey() { return (state.settings.apiKey || state.sessionKey || '').trim(); }
function isOpenRouter() { return state.settings.provider !== 'custom'; }
function baseUrl() { return isOpenRouter() ? OPENROUTER_BASE : (state.settings.customUrl || '').trim(); }

function showScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('on', s.id === `screen-${name}`);
  });
  if (name === 'reports') renderReportList();
  if (name === 'analyse') updateModelCard();
}

async function goTo(name) {
  if (transitioning) return;
  if (state.screen === name) { showScreen(name); return; }
  transitioning = true;
  const unlock = setTimeout(() => {
    transitioning = false;
    const fx = $('fx');
    if (fx) fx.className = 'fx';
  }, 5000);
  try {
    await playTransition(state.screen, name);
  } finally {
    clearTimeout(unlock);
    transitioning = false;
    const fx = $('fx');
    if (fx) fx.className = 'fx';
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ASSEMBLE_HOME = 1800;
const ASSEMBLE_PAGE = 1600;

function clearAssemble(el) {
  if (!el) return;
  el.classList.remove('assemble', 'from-navy', 'from-peach', 'play');
}

function prepAssemble(el, fromColor) {
  document.querySelectorAll('.screen.assemble').forEach(clearAssemble);
  el.classList.remove('play');
  el.classList.add('assemble', fromColor === 'peach' ? 'from-peach' : 'from-navy');
  if (el.id === 'screen-home') {
    el.querySelectorAll('.home-bar, .cloud').forEach((n) => { n.style.transform = ''; });
  }
}

async function playAssemble(el, dur) {
  await frame();
  el.classList.add('play');
  await wait(dur);
  clearAssemble(el);
}

async function coverThenAssemble({ fxClass, coverMs, to, fromColor }) {
  const fx = $('fx');
  const el = $(`screen-${to}`);
  const dur = to === 'home' ? ASSEMBLE_HOME : ASSEMBLE_PAGE;
  if (reduceMotion()) {
    showScreen(to);
    return;
  }
  try {
    fx.className = `fx go ${fxClass}`;
    await wait(coverMs);
    prepAssemble(el, fromColor);
    showScreen(to);
    await frame();
    fx.className = 'fx';
    await playAssemble(el, dur);
  } finally {
    fx.className = 'fx';
  }
}

async function playFx(className, swapAt, to, extraDelay = 0) {
  const fx = $('fx');
  fx.className = `fx go ${className}`;
  await wait(swapAt);
  showScreen(to);
  if (extraDelay) await wait(extraDelay);
  fx.className = 'fx';
}

function coverScale(rect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(window.innerWidth - cx, cy),
    Math.hypot(cx, window.innerHeight - cy),
    Math.hypot(window.innerWidth - cx, window.innerHeight - cy),
  );
  return (radius / (rect.width / 2)) * 1.06;
}

function playAnim(el, keyframes, opts) {
  return el.animate(keyframes, { fill: 'forwards', ...opts }).finished.catch(() => {});
}

function placeBloomCircle(el, x, y, size, scale, opacity) {
  el.style.inset = 'auto';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.margin = '0';
  el.style.borderRadius = '50%';
  el.style.transform = `translate(-50%, -50%) scale(${scale})`;
  if (opacity != null) el.style.opacity = String(opacity);
}

async function bloomReveal(to) {
  const fx = $('fx');
  const blob = fx.querySelector('.fx-blob');
  const full = fx.querySelector('.fx-full');
  const dest = $(`screen-${to}`);
  const home = $('screen-home');
  if (reduceMotion()) {
    showScreen(to);
    return;
  }
  const from = document.querySelector('.upload-disc').getBoundingClientRect();
  const size = from.width;
  const cx = from.left + size / 2;
  const cy = from.top + from.height / 2;
  const grow = coverScale(from);
  const easeCover = 'cubic-bezier(.22, .72, .14, 1)';
  const easeSettle = 'cubic-bezier(.16, .84, .18, 1)';

  placeBloomCircle(blob, cx, cy, size, 1, 1);
  placeBloomCircle(full, cx, cy, size, 1, 0);
  home.classList.add('bloom-leave');
  fx.className = 'fx go bloom';
  try {
    await Promise.all([
      playAnim(blob, [
        { left: `${cx}px`, top: `${cy}px`, transform: 'translate(-50%, -50%) scale(1)' },
        { left: `${cx}px`, top: `${cy}px`, transform: `translate(-50%, -50%) scale(${grow})` },
      ], { duration: 720, easing: easeCover }),
      playAnim(full, [
        { left: `${cx}px`, top: `${cy}px`, transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
        { left: `${cx}px`, top: `${cy}px`, transform: `translate(-50%, -50%) scale(${grow * 0.62})`, opacity: 0, offset: 0.55 },
        { left: `${cx}px`, top: `${cy}px`, transform: `translate(-50%, -50%) scale(${grow})`, opacity: 1 },
      ], { duration: 720, easing: easeCover }),
    ]);

    dest.classList.add('bloom-in');
    showScreen(to);
    await frame();

    const land = dest.querySelector('.back-orb').getBoundingClientRect();
    const tx = land.left + land.width / 2;
    const ty = land.top + land.height / 2;
    const end = land.width / size;

    await Promise.all([
      playAnim(blob, [
        { left: `${cx}px`, top: `${cy}px`, transform: `translate(-50%, -50%) scale(${grow})` },
        { left: `${tx}px`, top: `${ty}px`, transform: `translate(-50%, -50%) scale(${end * 1.05})`, offset: 0.84 },
        { left: `${tx}px`, top: `${ty}px`, transform: `translate(-50%, -50%) scale(${end})` },
      ], { duration: 840, easing: easeSettle }),
      playAnim(full, [
        { left: `${cx}px`, top: `${cy}px`, transform: `translate(-50%, -50%) scale(${grow})`, opacity: 1 },
        { left: `${cx + (tx - cx) * 0.18}px`, top: `${cy + (ty - cy) * 0.18}px`, transform: `translate(-50%, -50%) scale(${grow * 0.78})`, opacity: 1, offset: 0.16 },
        { left: `${tx}px`, top: `${ty}px`, transform: `translate(-50%, -50%) scale(${end})`, opacity: 0 },
      ], { duration: 840, easing: easeSettle }),
    ]);

    dest.classList.remove('bloom-in');
    await playAnim(blob, [
      { opacity: 1 },
      { opacity: 0 },
    ], { duration: 160, easing: 'ease-out' });
  } finally {
    home.classList.remove('bloom-leave');
    fx.className = 'fx';
    try {
      blob.getAnimations().forEach((a) => a.cancel());
      full.getAnimations().forEach((a) => a.cancel());
    } catch { /* ignore */ }
    blob.removeAttribute('style');
    full.removeAttribute('style');
    dest.classList.remove('bloom-in');
  }
}

async function splitReveal(to) {
  const fx = $('fx');
  fx.className = 'fx go split';
  await wait(340);
  showScreen(to);
  fx.classList.add('part2');
  await wait(560);
  fx.className = 'fx';
}

async function doorsThenHome() {
  const fx = $('fx');
  const el = $('screen-home');
  if (reduceMotion()) {
    showScreen('home');
    return;
  }
  try {
    fx.className = 'fx go close';
    await wait(520);
    prepAssemble(el, 'navy');
    showScreen('home');
    await frame();
    fx.className = 'fx';
    await playAssemble(el, ASSEMBLE_HOME);
  } finally {
    fx.className = 'fx';
  }
}

async function playTransition(from, to) {
  if (from === 'home' && to === 'review') return bloomReveal(to);
  if (from === 'home' && to === 'help') {
    return coverThenAssemble({ fxClass: 'slash-wipe', coverMs: 720, to, fromColor: 'peach' });
  }
  if (from === 'home' && to === 'reports') {
    return coverThenAssemble({ fxClass: 'flood', coverMs: 620, to, fromColor: 'peach' });
  }
  if (from === 'home' && to === 'key') {
    return coverThenAssemble({ fxClass: 'spin', coverMs: 740, to, fromColor: 'navy' });
  }
  if (from === 'home' && to === 'safety') {
    return coverThenAssemble({ fxClass: 'circle', coverMs: 720, to, fromColor: 'peach' });
  }
  if (from === 'home' && to === 'contact') return splitReveal(to);
  if (from === 'review' && to === 'analyse') return splitReveal(to);
  if (from === 'analyse' && to === 'review') return playFx('flood', 520, to);
  if (from === 'key' && to === 'home') {
    return coverThenAssemble({ fxClass: 'flood', coverMs: 580, to, fromColor: 'peach' });
  }
  if (to === 'home') return doorsThenHome();
  return splitReveal(to);
}

function goInitial() {
  showScreen(currentKey() ? 'home' : 'key');
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { /* ignore */ }
  $('api-key').value = state.settings.apiKey || '';
  if (state.settings.referer) $('referer').value = state.settings.referer;
  updateKeyStatus();
}

function saveSettings() {
  const s = state.settings;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, apiKey: s.rememberKey ? s.apiKey : '' })); } catch { /* ignore */ }
}

function updateKeyStatus() {
  const pill = $('key-status');
  const key = currentKey();
  if (!key) { pill.hidden = true; pill.textContent = ''; }
  else { pill.hidden = false; pill.textContent = 'A key is saved on this computer.'; }
}

function setMessage(id, text, kind = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'ok' ? 'var(--good)' : kind === 'bad' ? 'var(--white)' : '';
}

function wireChrome() {
  document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => goTo(el.getAttribute('data-go')));
  });
  $('to-analyse').addEventListener('click', () => goTo('analyse'));
  $('new-class').addEventListener('click', () => { resetClass(); goTo('home'); });
  const home = $('screen-home');
  const setParallax = (el, mx, my) => {
    if (!el) return;
    el.style.setProperty('--mx', `${mx}px`);
    el.style.setProperty('--my', `${my}px`);
  };
  let paraRaf = 0;
  let paraX = 0;
  let paraY = 0;
  const flushHomeParallax = () => {
    paraRaf = 0;
    if (state.screen !== 'home') return;
    const x = paraX;
    const y = paraY;
    home.querySelectorAll('.home-bar').forEach((b, i) => {
      const n = i + 1;
      setParallax(b, x * 18 * n, y * 14 * n);
    });
    home.querySelectorAll('.cloud').forEach((c, i) => {
      setParallax(c, x * 24 * (i + 1), y * 16 * (i + 1));
    });
    setParallax(home.querySelector('.home-pills'), x * 8, y * 6);
  };
  const applyHomeParallax = (e) => {
    if (state.screen !== 'home') return;
    paraX = e.clientX / innerWidth - 0.5;
    paraY = e.clientY / innerHeight - 0.5;
    if (!paraRaf) paraRaf = requestAnimationFrame(flushHomeParallax);
  };
  window.addEventListener('pointermove', applyHomeParallax, { passive: true });
}

function wireSettings() {
  $('save-key').addEventListener('click', () => {
    const key = $('api-key').value.trim();
    state.settings.rememberKey = true;
    state.settings.apiKey = key;
    state.settings.referer = $('referer').value.trim();
    state.sessionKey = '';
    saveSettings();
    updateKeyStatus();
    if (key) goTo('home');
    loadModels();
  });
  $('toggle-key').addEventListener('click', () => {
    const input = $('api-key');
    const btn = $('toggle-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
  });
}

function wireUpload() {
  $('load-class').addEventListener('click', () => {
    $('file-input').click();
  });
  $('folder-input').addEventListener('change', (e) => { handleFiles(Array.from(e.target.files || [])); e.target.value = ''; });
  $('file-input').addEventListener('change', (e) => { handleFiles(Array.from(e.target.files || [])); e.target.value = ''; });
  const home = $('screen-home');
  ['dragenter', 'dragover'].forEach((ev) => home.addEventListener(ev, (e) => { e.preventDefault(); }));
  home.addEventListener('drop', (e) => {
    e.preventDefault();
    handleFiles(Array.from(e.dataTransfer.files || []));
  });
}

async function handleFiles(files, { followUp = false } = {}) {
  const pdfs = [];
  for (const f of files) {
    const name = f.name || 'file';
    if (/\.zip$/i.test(name)) {
      try {
        const zip = await JSZip.loadAsync(await f.arrayBuffer());
        const entries = Object.values(zip.files).filter((z) => !z.dir && /\.pdf$/i.test(z.name) && !/(^|\/)(__MACOSX|\.)/.test(z.name));
        for (const z of entries) pdfs.push({ name: z.name.split('/').pop(), data: await z.async('uint8array') });
      } catch (err) {
        showProgress(true, `Could not open ${name}: ${err.message}`, 0);
      }
    } else if (/\.pdf$/i.test(name)) {
      pdfs.push({ name, data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  if (!pdfs.length) { showProgress(false); return []; }
  if (!followUp) { state.files = []; state.parsedPupils = []; }
  const parsed = [];
  let done = 0;
  for (const pdf of pdfs) {
    showProgress(true, `${pdf.name}  ·  ${done + 1} of ${pdfs.length}`, done / pdfs.length);
    const item = { name: pdf.name, status: 'ok', pupils: [], warnings: [] };
    try {
      const structure = await extractPdfStructure(pdfjsLib, pdf.data);
      const totalRows = structure.pages.reduce((s, p) => s + p.rows.length, 0);
      if (!totalRows) { item.status = 'bad'; item.warnings.push('No selectable text.'); }
      else {
        const report = parseReport(structure, { filename: pdf.name });
        item.pupils = report.pupils;
        parsed.push(...report.pupils);
      }
    } catch (err) {
      item.status = 'bad';
      item.warnings.push(err.message);
    }
    if (!followUp) state.files.push(item);
    done++;
    await new Promise((r) => setTimeout(r, 0));
  }
  showProgress(false, 'Done.', 1);
  if (followUp) return parsed;
  rebuildFromFiles();
  await wait(700);
  showProgress(false);
  await goTo('review');
  return parsed;
}

function showProgress(show, text = '', frac = 0) {
  const orb = $('load-class');
  const disc = document.querySelector('.upload-disc');
  const lab = $('progress-label');
  const p = String(Math.round(frac * 100));
  if (show) {
    orb.classList.add('loading');
    if (disc) { disc.classList.add('loading'); disc.style.setProperty('--p', p); }
    lab.hidden = false;
    lab.textContent = text;
  } else {
    orb.classList.remove('loading');
    if (disc) { disc.classList.remove('loading'); disc.style.removeProperty('--p'); }
    lab.hidden = !text;
    lab.textContent = text;
  }
}

function rebuildFromFiles() {
  const byName = new Map();
  const pupils = [];
  for (const file of state.files) {
    for (const p of file.pupils) {
      const key = p.displayName && !/^unknown pupil/i.test(p.displayName) ? p.displayName.toLowerCase() : null;
      if (key && byName.has(key)) {
        const existing = byName.get(key);
        existing.assessments = existing.assessments.concat(p.assessments);
        continue;
      }
      const copy = { ...p };
      if (key) byName.set(key, copy);
      pupils.push(copy);
    }
  }
  state.parsedPupils = pupils;
  if (pupils.length) rebuildDataset();
}

function classMetaFromPupils(pupils) {
  const pick = (key) => {
    const counts = new Map();
    for (const p of pupils || []) {
      for (const f of (p.fields && p.fields[key]) || []) {
        const v = String(f.value || '').replace(/\s+/g, ' ').trim();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  return { classCode: pick('class'), teacherName: pick('teacher') };
}

function rebuildDataset() {
  state.dataset = buildClassDataset(state.parsedPupils, { includePastoral: state.settings.includePastoral });
  const ds = state.dataset;
  const meta = classMetaFromPupils(state.parsedPupils);
  ds.classCode = meta.classCode;
  ds.teacherName = meta.teacherName;
  const subj = new Map();
  for (const p of state.parsedPupils) for (const s of p.subjectHints || []) subj.set(s, (subj.get(s) || 0) + 1);
  const bestSubject = [...subj.entries()].sort((a, b) => b[1] - a[1])[0];
  if (bestSubject) $('subject').value = bestSubject[0];
  const years = state.parsedPupils.map((p) => p.yearGroup).filter(Boolean);
  if (years.length) {
    const best = years.sort((a, b) => years.filter((v) => v === b).length - years.filter((v) => v === a).length)[0];
    $('year-group').value = String(best).replace(/^year\s*/i, '');
  }
  renderKeyTable(ds);
  renderGrid(ds);
  const bad = state.files.filter((f) => f.status === 'bad').length;
  $('parse-status').textContent = `${ds.pupils.length} pupils and ${ds.assessments.filter((a) => !a.excluded).length} assessments were read. Year ${$('year-group').value || 'is not yet set'}.${bad ? ` ${bad} file(s) could not be read.` : ''}`;
  refreshPayload();
}

function drawerIsOpen(el) {
  const drawer = el && el.closest('details');
  return !drawer || drawer.open;
}

function renderKeyTable(ds) {
  const wrap = $('name-key');
  if (!ds || !drawerIsOpen(wrap)) {
    if (wrap && !drawerIsOpen(wrap)) wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `<table class="data"><thead><tr><th>Code</th><th>Pupil</th><th>Source file</th></tr></thead><tbody>${
    ds.pupils.map((p) => `<tr><td>${escapeHtml(p.code)}</td><td>${escapeHtml(p.displayName)}</td><td>${escapeHtml(p.sourceFile || '')}</td></tr>`).join('')
  }</tbody></table>`;
}

function columnNums(ds, a, m) {
  const nums = [];
  for (const p of ds.pupils) {
    const rec = p.results.get(a.key);
    const v = rec ? rec[m.key] : '';
    const c = classifyValue(v);
    if (c && typeof c.numeric === 'number') nums.push(c.numeric);
  }
  return nums;
}

function toneStyle(value, nums) {
  const c = classifyValue(value);
  if (!c || typeof c.numeric !== 'number') return '';
  let t;
  if (c.kind === 'percent' || c.kind === 'fraction') t = Math.max(0, Math.min(1, c.numeric / 100));
  else if (c.kind === 'gcse') t = Math.max(0, Math.min(1, (c.numeric - 1) / 8));
  else if (c.kind === 'letter') t = Math.max(0, Math.min(1, c.numeric / 8));
  else if (nums.length >= 2) {
    const min = Math.min(...nums); const max = Math.max(...nums);
    t = max === min ? 0.6 : (c.numeric - min) / (max - min);
  } else t = 0.55;
  const hue = Math.round(t * 118);
  return `background:hsl(${hue} 70% 62%)`;
}

let gradeGridSeq = 0;

function showGradeSpinner(on) {
  const load = $('grade-table-load');
  if (load) load.hidden = !on;
}

async function fillGradeTable() {
  const wrap = $('grade-table');
  const seq = ++gradeGridSeq;
  if (!state.dataset || !drawerIsOpen(wrap)) {
    showGradeSpinner(false);
    if (wrap) wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '';
  showGradeSpinner(true);
  await frame();
  if (seq !== gradeGridSeq) return;
  renderGrid(state.dataset);
  if (seq !== gradeGridSeq) return;
  showGradeSpinner(false);
}

function renderGrid(ds) {
  const wrap = $('grade-table');
  if (!ds || !drawerIsOpen(wrap)) {
    showGradeSpinner(false);
    if (wrap && !drawerIsOpen(wrap)) wrap.innerHTML = '';
    return;
  }
  const measures = ds.measures.filter((m) => !m.excluded);
  const cols = [];
  for (const a of ds.assessments) for (const m of measures) if (a.measures.has(m.key)) cols.push({ a, m, nums: columnNums(ds, a, m) });
  let head = '<table class="data"><thead><tr><th class="sticky-col">Pupil</th>';
  for (const c of cols) {
    head += `<th>${escapeHtml(c.a.name)}<div>${escapeHtml(c.m.name)}</div></th>`;
  }
  head += '</tr></thead><tbody>';
  let body = '';
  for (const p of ds.pupils) {
    body += `<tr><td class="sticky-col"><strong>${escapeHtml(p.code)}</strong> ${escapeHtml(p.displayName)}</td>`;
    for (const c of cols) {
      const rec = p.results.get(c.a.key);
      const v = rec ? rec[c.m.key] ?? '' : '';
      const tone = v ? toneStyle(v, c.nums) : '';
      body += `<td class="${tone ? 'cell-tone' : ''}" style="${tone}"><input type="text" value="${escapeHtml(v)}" data-code="${escapeHtml(p.code)}" data-akey="${escapeHtml(c.a.key)}" data-mkey="${escapeHtml(c.m.key)}"></td>`;
    }
    body += '</tr>';
  }
  $('grade-table').innerHTML = `${head}${body}</tbody></table>`;
  $('grade-table').querySelectorAll('tbody input').forEach((inp) => inp.addEventListener('change', () => {
    const p = ds.pupils.find((x) => x.code === inp.dataset.code);
    if (!p) return;
    let rec = p.results.get(inp.dataset.akey);
    if (!rec) { rec = {}; p.results.set(inp.dataset.akey, rec); }
    const cleaned = ds.scrub(inp.value, null, 'value');
    if (cleaned) rec[inp.dataset.mkey] = cleaned; else delete rec[inp.dataset.mkey];
    inp.value = cleaned;
    refreshPayload();
  }));
}

let payloadTimer = null;
function refreshPayload() {
  clearTimeout(payloadTimer);
  payloadTimer = setTimeout(doRefreshPayload, 80);
}

function doRefreshPayload() {
  const ds = state.dataset;
  if (!ds) return;
  const context = {
    subject: ds.scrub($('subject').value, null, 'subject'),
    yearGroup: ds.scrub($('year-group').value, null, 'year group'),
    notes: $('extra-context').value,
    templateTopics: state.templateTopics.map((t) => ds.scrub(t, null, 'template')),
  };
  state.payload = buildPayload(ds, context);
  const activeMeasures = ds.measures.filter((m) => !m.excluded);
  state.outgoing = buildOutgoing({
    payload: state.payload,
    subject: context.subject,
    hasTargets: activeMeasures.some((m) => m.flags.includes('target')),
    hasEffort: activeMeasures.some((m) => m.flags.includes('effort') || /atl|homework|classwork|handwriting/i.test(m.name)),
    rowsAreSubjects: ds.pupils.some((p) => p.rowsAreSubjects),
  });
  state.guard = guardPayload(state.outgoing.combined, ds);
  const pre = $('payload-preview');
  if (drawerIsOpen(pre)) pre.textContent = state.outgoing.combined;
  else pre.textContent = '';
  renderGuard();
}

function renderGuard() {
  const box = $('guard-banner');
  const g = state.guard; const ds = state.dataset;
  if (!g || !ds) { box.textContent = ''; box.hidden = true; return; }
  const blocks = g.findings.filter((f) => f.severity === 'block');
  if (blocks.length) {
    box.hidden = false;
    box.className = 'guard bad';
    box.innerHTML = `<strong>This will not be sent.</strong> Something identifying is still in the message: ${blocks.slice(0, 8).map((f) => `${escapeHtml(f.type)} (${escapeHtml(f.match)})`).join('; ')}.`;
  } else {
    box.className = 'guard';
    box.textContent = '';
    box.hidden = true;
  }
}

async function loadTemplate(file) {
  try {
    const structure = await extractPdfStructure(pdfjsLib, new Uint8Array(await file.arrayBuffer()));
    const parsed = parseReport(structure, { filename: file.name });
    const names = [];
    for (const p of parsed.pupils) for (const a of p.assessments) if (a.name) names.push(a.name);
    state.templateTopics = [...new Set(names)];
    $('empty-assessment-status').textContent = `${state.templateTopics.length} course items were read from the empty sheet.`;
    refreshPayload();
  } catch (err) {
    $('empty-assessment-status').textContent = `That PDF could not be read (${err.message}).`;
  }
}

async function loadModels() {
  if (!isOpenRouter()) { populateModelSelect(); return; }
  $('model-status').textContent = 'Loading the list of free models…';
  try {
    state.models = await fetchModels(OPENROUTER_BASE, currentKey());
    state.ranked = rankFreeReasoningModels(state.models, { requireReasoning: true });
    state.rankedAll = rankFreeReasoningModels(state.models, { requireReasoning: false });
  } catch (err) {
    state.models = []; state.ranked = []; state.rankedAll = [];
    $('model-status').textContent = `The model list could not be loaded (${err.message}).`;
  }
  populateModelSelect();
}

function populateModelSelect() {
  const sel = $('model-select');
  const prev = state.settings.model || 'auto';
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  const best = state.ranked[0];
  auto.textContent = best ? `Automatic – ${best.name}` : 'Automatic';
  sel.appendChild(auto);
  for (const m of state.ranked.slice(0, 20)) {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; sel.appendChild(o);
  }
  const fr = document.createElement('option'); fr.value = FREE_ROUTER_ID; fr.textContent = 'OpenRouter free router';
  sel.appendChild(fr);
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'auto';
  $('model-status').textContent = best
    ? `${state.ranked.length} free reasoning models are available. First pick: ${best.name}.`
    : 'Using the free router.';
  updateModelCard();
}

function candidateModels() {
  if (!isOpenRouter()) return [state.settings.customModel || $('model-select').value].filter(Boolean);
  const chosen = $('model-select').value || 'auto';
  const top = state.ranked.slice(0, 5);
  if (chosen === 'auto') return [...top, FREE_ROUTER_ID];
  const rest = top.filter((m) => m.id !== chosen);
  const chosenMeta = state.rankedAll.find((m) => m.id === chosen) || chosen;
  return [chosenMeta, ...rest, FREE_ROUTER_ID].filter((m, i, arr) => arr.findIndex((x) => (x.id || x) === (m.id || m)) === i);
}

function formatReleased(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function updateModelCard() {
  const id = $('model-select').value === 'auto' ? (state.ranked[0] && state.ranked[0].id) : $('model-select').value;
  const meta = state.rankedAll.find((m) => m.id === id) || state.ranked[0];
  const raw = state.models.find((m) => m.id === id);
  $('metric-tps').textContent = '…';
  $('metric-reason').textContent = '…';
  $('metric-released').textContent = formatReleased((meta && meta.created) || (raw && raw.created));
  try {
    const card = await fetchModelCard(id, currentKey());
    if (!card) return;
    $('metric-tps').textContent = card.wordsPerSec != null ? String(card.wordsPerSec) : '—';
    const top = card.intelligenceTop != null ? Math.round(card.intelligenceTop) : '—';
    const mine = card.intelligence != null ? Math.round(card.intelligence) : '—';
    $('metric-reason').textContent = `${mine} / ${top}`;
    if (card.created) $('metric-released').textContent = formatReleased(card.created);
  } catch {
    $('metric-tps').textContent = '—';
    $('metric-reason').textContent = '—';
  }
}

function setAnalysePhase(phase) {
  state.analysePhase = phase;
  $('go-stage').hidden = phase !== 'idle';
  $('think-wrap').hidden = phase !== 'thinking';
  $('report').hidden = phase === 'thinking' || (phase === 'idle' && !state.result);
  $('extra-wrap').hidden = phase !== 'idle';
  $('model-pick-wrap').hidden = phase !== 'idle';
  $('go-wrap').hidden = phase !== 'idle' && phase !== 'error';
  $('ident-wrap').hidden = phase !== 'streaming' && phase !== 'done';
  $('run-wrap').hidden = phase !== 'thinking' && phase !== 'streaming';
  $('done-wrap').hidden = phase !== 'done' && phase !== 'error';
  $('composer').hidden = phase !== 'done';
  if (phase === 'done') fillCodeGrid();
}

function addThinkLine(text) {
  const line = String(text || '').trim();
  if (!line) return;
  const reel = $('think-reel');
  const div = document.createElement('div');
  div.className = 'think-line';
  div.textContent = line.slice(0, 280);
  reel.appendChild(div);
}

function showAnalysisError(err) {
  const friendly = explainAiError(err);
  $('run-status').textContent = friendly.headline;
  reportStream.stop();
  setAnalysePhase('error');
  $('report').hidden = false;
  $('think-wrap').hidden = true;
  $('composer').hidden = true;
  const link = friendly.link
    ? `<p><a href="${escapeHtml(friendly.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(friendly.link.label)}</a></p>`
    : '';
  $('report').innerHTML = `<div class="notice notice-error"><strong>${escapeHtml(friendly.headline)}</strong><p>${escapeHtml(friendly.body)}</p>${link}${friendly.detail ? `<pre class="payload">${escapeHtml(friendly.detail)}</pre>` : ''}</div>`;
  $('analyse-main').scrollTop = 0;
}

function updateThinkReel(text) {
  const reel = $('think-reel');
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const have = reel.querySelectorAll('.think-line').length;
  if (have > lines.length) reel.innerHTML = '';
  const start = reel.querySelectorAll('.think-line').length;
  for (let i = start; i < lines.length; i++) {
    const div = document.createElement('div');
    div.className = 'think-line';
    div.textContent = lines[i].slice(0, 280);
    reel.appendChild(div);
  }
}

function assistantHtml(md) {
  if (!state.showNames || !state.dataset) return renderMarkdown(md);
  const named = reidentify(md, state.dataset);
  const marks = [];
  let marked = named;
  const pupils = [...state.dataset.pupils]
    .filter((p) => p.displayName)
    .sort((a, b) => b.displayName.length - a.displayName.length);
  for (const p of pupils) {
    const re = new RegExp(`(^|[^\\p{L}])(${p.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'gu');
    marked = marked.replace(re, (_, pre, name) => {
      const id = marks.length;
      marks.push({ name, code: p.code });
      return `${pre}\uE000${id}\uE001`;
    });
  }
  return renderMarkdown(marked).replace(/\uE000(\d+)\uE001/g, (all, id) => {
    const mark = marks[Number(id)];
    if (!mark) return all;
    return `<span class="name" title="${escapeHtml(mark.code)}">${escapeHtml(mark.name)}</span>`;
  });
}

const reportStream = attachReportStream({
  mount: () => $('report'),
  toHtml: assistantHtml,
});

function renderAssistant(streaming) {
  reportStream.stop();
  let html = assistantHtml(state.result ? state.result.markdown : '');
  if (streaming) html += '<span class="cursor" aria-hidden="true"></span>';
  $('report').innerHTML = html;
}

function applyNameMode(on) {
  state.showNames = on;
  if (!state.result) return;
  if (state.analysePhase === 'streaming') {
    reportStream.reset({ seed: state.result.markdown || '' });
    return;
  }
  renderAssistant(false);
}

async function runAnalysis({ followUp = false } = {}) {
  if (!state.dataset) {
    $('run-status').textContent = 'There is no class data to send yet.';
    return;
  }
  try {
    doRefreshPayload();
  } catch (err) {
    showAnalysisError(err);
    return;
  }
  if (!state.guard || !state.guard.ok) {
    $('run-status').textContent = 'Blocked by the privacy check.';
    return;
  }
  if (!followUp) {
    state.messages = [
      { role: 'system', content: state.outgoing.system },
      { role: 'user', content: state.outgoing.user },
    ];
    state.result = { markdown: '', model: '', reasoning: '' };
    $('report').innerHTML = '';
  }
  state.abort = new AbortController();
  const prior = followUp && state.result && state.result.markdown ? state.result.markdown : '';
  reportStream.reset({ seed: prior ? `${prior}\n\n---\n\n` : '' });
  $('think-reel').innerHTML = '';
  setAnalysePhase('thinking');
  $('run-status').textContent = 'Starting…';
  addThinkLine('Contacting OpenRouter…');
  let sawAnswer = false;
  try {
    const res = await runWithFallback({
      candidates: candidateModels(),
      baseUrl: baseUrl(),
      apiKey: currentKey(),
      messages: state.messages,
      isOpenRouter: isOpenRouter(),
      dataCollection: state.settings.dataCollection,
      signal: state.abort.signal,
      onModelChange: (model) => {
        state.result.model = model;
        const s = `Trying ${model}…`;
        $('run-status').textContent = s;
        if (!sawAnswer) addThinkLine(s);
      },
      onStatus: (s) => {
        $('run-status').textContent = s;
        if (!sawAnswer) addThinkLine(s);
      },
      onReasoning: (chunk, all) => {
        state.result.reasoning = all;
        if (!sawAnswer) {
          setAnalysePhase('thinking');
          updateThinkReel(all);
        }
      },
      onDelta: (chunk, all) => {
        state.result.markdown = prior ? `${prior}\n\n---\n\n${all}` : all;
        if (!sawAnswer) {
          sawAnswer = true;
          setAnalysePhase('streaming');
        }
        $('report').hidden = false;
        $('think-wrap').hidden = true;
        reportStream.push(state.result.markdown);
      },
    });
    state.result.markdown = prior ? `${prior}\n\n---\n\n${res.content}` : res.content;
    state.result.model = res.model;
    state.result.reasoning = res.reasoning || '';
    state.messages.push({ role: 'assistant', content: res.content });
    reportStream.push(state.result.markdown);
    await reportStream.finish();
    setAnalysePhase('done');
    $('run-status').textContent = res.usedStoringProvider
      ? `${res.model}. A provider that may store the anonymised prompt was used.`
      : `${res.model}.`;
    saveCurrentReport();
    $('analyse-main').scrollTop = 0;
  } catch (err) {
    if (state.abort && state.abort.signal.aborted) {
      $('run-status').textContent = 'Stopped.';
      if (state.result && state.result.markdown) {
        await reportStream.finish();
        setAnalysePhase('done');
      } else {
        reportStream.stop();
        setAnalysePhase('idle');
      }
    } else {
      showAnalysisError(err);
    }
  } finally {
    state.abort = null;
  }
}

function saveReportRecord(rec) {
  const all = loadReports().filter((r) => r.id !== rec.id);
  all.unshift(rec);
  try { localStorage.setItem(REPORTS_KEY, JSON.stringify(all.slice(0, 30))); } catch { /* quota */ }
}

function saveCurrentReport() {
  if (!state.result || !state.dataset) return;
  const meta = classMetaFromPupils(state.parsedPupils.length ? state.parsedPupils : state.dataset.pupils);
  saveReportRecord({
    id: `${Date.now()}`,
    savedAt: new Date().toISOString(),
    subject: $('subject').value,
    yearGroup: $('year-group').value,
    classCode: state.dataset.classCode || meta.classCode || '',
    teacherName: state.dataset.teacherName || meta.teacherName || '',
    model: state.result.model,
    markdown: state.result.markdown,
    reasoning: state.result.reasoning,
    messages: state.messages,
    pupilKey: state.dataset.pupils.map((p) => ({ code: p.code, name: p.displayName })),
    codePrefix: state.dataset.codePrefix,
  });
}

function snapshotOutgoingPrompt() {
  if (!state.outgoing || !state.dataset) return null;
  const rec = {
    savedAt: new Date().toISOString(),
    subject: $('subject').value,
    yearGroup: $('year-group').value,
    system: state.outgoing.system,
    user: state.outgoing.user,
    prompt: state.outgoing.combined,
    pupilKey: state.dataset.pupils.map((p) => ({ code: p.code, name: p.displayName })),
    codePrefix: state.dataset.codePrefix,
  };
  try { localStorage.setItem(PROMPT_KEY, JSON.stringify(rec)); } catch { /* quota */ }
  return rec;
}

function loadPromptSnapshot() {
  try { return JSON.parse(localStorage.getItem(PROMPT_KEY) || 'null'); } catch { return null; }
}

function livePromptContext() {
  if (!state.dataset || !state.dataset.pupils.length) return null;
  return {
    subject: $('subject').value,
    yearGroup: $('year-group').value,
    system: state.outgoing && state.outgoing.system,
    user: state.outgoing && state.outgoing.user,
    prompt: state.outgoing && state.outgoing.combined,
    pupilKey: state.dataset.pupils.map((p) => ({ code: p.code, name: p.displayName })),
    codePrefix: state.dataset.codePrefix,
  };
}

function promptContextForPaste() {
  return loadPromptSnapshot() || livePromptContext();
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function copyPromptFile() {
  if (!state.outgoing || !state.outgoing.combined) {
    $('parse-status').textContent = 'There is no message to copy yet.';
    return;
  }
  if (state.guard && !state.guard.ok) {
    $('parse-status').textContent = 'This will not be copied. Something identifying is still in the message.';
    return;
  }
  snapshotOutgoingPrompt();
  downloadTextFile('prompt.txt', state.outgoing.combined);
  $('parse-status').textContent = 'Saved as prompt.txt.';
}

function unwrapPastedMarkdown(text) {
  let s = String(text || '').replace(/^\uFEFF/, '').trim();
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) s = fence[1].trim();
  return s;
}

function showPasteStatus(text) {
  const el = $('paste-status');
  el.hidden = !text;
  el.textContent = text || '';
}

async function importPastedReply(raw) {
  const markdown = unwrapPastedMarkdown(raw);
  if (!markdown) {
    showPasteStatus('There is no reply to save.');
    return;
  }
  const ctx = promptContextForPaste() || {};
  const rec = {
    id: `${Date.now()}`,
    savedAt: new Date().toISOString(),
    subject: ctx.subject || '',
    yearGroup: ctx.yearGroup || '',
    model: 'Pasted',
    markdown,
    reasoning: '',
    messages: [
      ...(ctx.system ? [{ role: 'system', content: ctx.system }] : []),
      ...(ctx.user || ctx.prompt ? [{ role: 'user', content: ctx.user || ctx.prompt }] : []),
      { role: 'assistant', content: markdown },
    ],
    pupilKey: ctx.pupilKey || [],
    codePrefix: ctx.codePrefix || '',
    classCode: (state.dataset && state.dataset.classCode) || '',
    teacherName: (state.dataset && state.dataset.teacherName) || '',
  };
  saveReportRecord(rec);
  $('paste-box').hidden = true;
  $('paste-text').value = '';
  showPasteStatus('');
  await openReport(rec.id);
  $('run-status').textContent = rec.pupilKey && rec.pupilKey.length
    ? 'Pasted from another AI.'
    : 'Pasted. Download prompt.txt from Check the class so names can be restored next time.';
}

async function useClipboardReply() {
  showPasteStatus('');
  try {
    const text = await navigator.clipboard.readText();
    await importPastedReply(text);
  } catch {
    $('paste-box').hidden = false;
    showPasteStatus('This browser would not read the clipboard. Paste the reply in the box.');
    $('paste-text').focus();
  }
}

function reportCreatedAt(r) {
  const t = Date.parse(r && r.savedAt);
  if (Number.isFinite(t)) return t;
  const id = Number(r && r.id);
  return Number.isFinite(id) ? id : 0;
}

function loadReports() {
  try {
    const all = JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]');
    return all.sort((a, b) => reportCreatedAt(b) - reportCreatedAt(a));
  } catch { return []; }
}

function deleteReport(id) {
  const all = loadReports().filter((r) => r.id !== id);
  try { localStorage.setItem(REPORTS_KEY, JSON.stringify(all)); } catch { /* quota */ }
  renderReportList();
}

function wireHoldDelete(btn) {
  const holdMs = 3000;
  let start = 0;
  let raf = 0;
  const clear = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    start = 0;
    btn.style.setProperty('--hold', '0%');
    btn.classList.remove('is-holding');
    try { btn.releasePointerCapture(btn._holdPtr); } catch { /* ignore */ }
    btn._holdPtr = null;
  };
  const tick = (now) => {
    if (!start) return;
    const p = Math.min(1, (now - start) / holdMs);
    btn.style.setProperty('--hold', `${Math.round(p * 1000) / 10}%`);
    if (p >= 1) {
      const id = btn.dataset.id;
      clear();
      deleteReport(id);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    start = performance.now();
    btn.classList.add('is-holding');
    btn.style.setProperty('--hold', '0%');
    if (e.pointerId != null) {
      btn._holdPtr = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    raf = requestAnimationFrame(tick);
  };
  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', clear);
  btn.addEventListener('pointercancel', clear);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function renderReportList() {
  const list = $('report-list');
  const all = loadReports();
  if (!all.length) { list.innerHTML = '<p>No reports are saved in this browser yet.</p>'; return; }
  list.innerHTML = all.map((r) => {
    const cls = r.classCode || 'Class code not saved';
    const teacher = r.teacherName || 'Teacher not saved';
    return `<article class="report-card">
      <button type="button" class="report-open" data-id="${escapeHtml(r.id)}">
        <strong>${escapeHtml(cls)} · ${escapeHtml(teacher)}</strong>
        <span>${escapeHtml(r.subject || 'Class')} · Year ${escapeHtml(r.yearGroup || '?')}</span>
        <span>${new Date(r.savedAt).toLocaleString('en-GB')} · ${escapeHtml(r.model || '')}</span>
      </button>
      <button type="button" class="report-del" data-id="${escapeHtml(r.id)}" aria-label="Hold for 3 seconds to delete">Delete</button>
    </article>`;
  }).join('');
  list.querySelectorAll('.report-open').forEach((b) => b.addEventListener('click', () => openReport(b.dataset.id)));
  list.querySelectorAll('.report-del').forEach((b) => wireHoldDelete(b));
}

async function openReport(id) {
  const rec = loadReports().find((r) => r.id === id);
  if (!rec) return;
  state.result = { markdown: rec.markdown, model: rec.model, reasoning: rec.reasoning || '' };
  state.messages = rec.messages || [];
  const restored = pupilsFromKey(rec.pupilKey, rec.codePrefix || '');
  if (restored.pupils.length) {
    const liveByCode = new Map((state.dataset && state.dataset.pupils ? state.dataset.pupils : []).map((p) => [p.code, p]));
    state.dataset = {
      assessments: [],
      measures: [],
      nameTokens: new Set(),
      fullNames: new Set(),
      identifierStrings: new Set(),
      contextStrings: new Set(),
      scrub: (s) => s,
      ...(state.dataset || {}),
      codePrefix: restored.codePrefix,
      pupils: restored.pupils.map((p) => ({ ...(liveByCode.get(p.code) || {}), ...p })),
    };
  } else if (!state.dataset) {
    state.dataset = {
      pupils: [],
      assessments: [],
      measures: [],
      nameTokens: new Set(),
      fullNames: new Set(),
      identifierStrings: new Set(),
      contextStrings: new Set(),
      codePrefix: rec.codePrefix || 'P',
      scrub: (s) => s,
    };
  }
  await goTo('analyse');
  setAnalysePhase('done');
  $('report').hidden = false;
  renderAssistant(false);
  $('run-status').textContent = rec.model || '';
}

function fillCodeGrid() {
  const pop = $('code-pop');
  if (!pop) return;
  const pupils = state.dataset && state.dataset.pupils ? state.dataset.pupils : [];
  pop.innerHTML = pupils.map((p) => `<button type="button" data-code="${escapeHtml(p.code)}">${escapeHtml(p.code)} · ${escapeHtml(p.displayName)}</button>`).join('');
  pop.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => insertAtCursor(b.dataset.code)));
}

function insertAtCursor(text) {
  const el = $('followup');
  const start = el.selectionStart || el.value.length;
  el.value = `${el.value.slice(0, start)}${text}${el.value.slice(el.selectionEnd || start)}`;
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
}

async function sendFollowUp() {
  if (!state.dataset || state.abort) return;
  let text = $('followup').value.trim();
  if (!text) return;
  text = state.dataset.scrub(text, null, 'follow-up');
  const g = guardPayload(text, state.dataset);
  if (!g.ok) { $('run-status').textContent = 'That follow-up still looks identifying. Use codes, not names.'; return; }
  $('followup').value = '';
  state.messages.push({ role: 'user', content: text });
  await runAnalysis({ followUp: true });
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function reportMarkdown(withNames) {
  if (!state.result) return '';
  const body = withNames && state.dataset ? reidentify(state.result.markdown, state.dataset) : state.result.markdown;
  return `# Class analysis${$('subject').value ? ` – ${$('subject').value}` : ''}\n\n_Generated ${new Date().toLocaleString('en-GB')} by ${state.result.model}. ${withNames ? 'Contains pupil names.' : 'Codes only.'}_\n\n${body}\n`;
}

function resetClass() {
  state.files = [];
  state.parsedPupils = [];
  state.dataset = null;
  state.payload = '';
  state.outgoing = null;
  state.guard = null;
  state.result = null;
  state.messages = [];
  state.templateTopics = [];
  setAnalysePhase('idle');
  reportStream.reset();
  $('report').innerHTML = '';
  $('year-group').value = '';
  $('subject').value = '';
  $('extra-context').value = '';
}

function init() {
  loadSettings();
  wireChrome();
  wireSettings();
  wireUpload();
  ['subject', 'year-group', 'extra-context'].forEach((id) => $(id).addEventListener('input', refreshPayload));
  $('empty-assessment').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) loadTemplate(f); });
  $('grade-table').closest('details').addEventListener('toggle', () => fillGradeTable());
  $('name-key').closest('details').addEventListener('toggle', () => {
    if (state.dataset) renderKeyTable(state.dataset);
  });
  $('payload-preview').closest('details').addEventListener('toggle', () => {
    const pre = $('payload-preview');
    if (pre.closest('details').open && state.outgoing) pre.textContent = state.outgoing.combined;
    else pre.textContent = '';
  });
  $('jump-payload').addEventListener('click', () => {
    const pre = $('payload-preview');
    const idx = pre.textContent.indexOf('--- DATA START ---');
    if (idx >= 0) {
      const ratio = idx / Math.max(1, pre.textContent.length);
      pre.scrollTop = ratio * pre.scrollHeight;
    }
  });
  $('copy-prompt').addEventListener('click', () => copyPromptFile());
  document.querySelectorAll('.js-paste-reply').forEach((btn) => {
    btn.addEventListener('click', () => useClipboardReply());
  });
  $('paste-save').addEventListener('click', () => importPastedReply($('paste-text').value));
  $('go').addEventListener('click', () => runAnalysis());
  $('stop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  $('model-select').addEventListener('change', () => { state.settings.model = $('model-select').value; saveSettings(); updateModelCard(); });
  $('show-names').addEventListener('click', () => applyNameMode(true));
  $('show-codes').addEventListener('click', () => applyNameMode(false));
  $('print-report').addEventListener('click', () => window.print());
  $('copy-report').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportMarkdown(true)); $('run-status').textContent = 'Copied.'; }
    catch { $('run-status').textContent = 'Copy failed.'; }
  });
  $('send-followup').addEventListener('click', sendFollowUp);
  $('followup').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFollowUp();
    }
  });
  setAnalysePhase('idle');
  loadModels();
  goInitial();
}

init();
