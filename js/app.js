import * as pdfjsLib from '../vendor/pdf.min.js';
import { extractPdfStructure } from './pdf-extract.js';
import { parseReport, classifyValue } from './parse-report.js';
import { buildClassDataset, buildPayload, guardPayload, reidentify, pupilsFromKey, anonymiseText, verifyAllMessagesSafe } from './anonymise.js?v=7';
import { wordsAround } from './common-names.js?v=4';
import { listModelsForProvider, runWithFallback, fetchModelCard, explainAiError, OPENROUTER_BASE, FREE_ROUTER_ID, estimateTextTokens, reportCostFromRates, reportUsageEstimate, looksReasoningModel, usageCost, usageSplit, formatGbp, USD_TO_GBP, setSecurityDataset } from './ai-client.js?v=14';
import { buildOutgoing, parseOutgoingCombined, CORE_SECTIONS, EXTRA_SECTIONS, OTHER_EXAMPLE } from './prompt.js?v=5';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { attachReportStream } from './report-stream.js?v=4';
import { AI_PROVIDERS, emptyApiKeys, providerLabel, providersWithKeys } from './ai-providers.js?v=4';
import { mountProviderKeyGuide } from './provider-key-guide.js?v=4';

window.__appBooted = true;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).toString();

const SETTINGS_KEY = 'cga.settings.v1';
const REPORTS_KEY = 'cga.reports.v1';
const PROMPT_KEY = 'cga.prompt.v1';
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  settings: {
    apiKey: '', apiKeys: emptyApiKeys(), rememberKey: true, provider: 'openrouter',
    customUrl: '', customModel: '', dataCollection: 'deny', includePastoral: false, model: 'auto',
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
  outgoingTouched: false,
  usage: emptyUsage(),
  reportId: null,
  nameScanConfirmed: null,
  nameScanPending: null,
  combineClasses: [],
  combineActive: null,
  combineQuery: '',
  combineBusy: false,
};

let transitioning = false;
let thinkTimer = { start: 0, raf: 0, words: 0 };

function emptyUsage() {
  return {
    prompt: 0, completion: 0, reasoning: 0,
    livePrompt: 0, liveCompletion: 0, liveReasoning: 0,
    rates: null, modelId: '',
  };
}

function resetUsage() {
  state.usage = emptyUsage();
  paintUsage();
}

function ratesForModel(id) {
  if (id === FREE_ROUTER_ID) return { prompt: 0, completion: 0, reasoning: 0 };
  const hit = state.rankedAll.find((m) => m.id === id)
    || state.ranked.find((m) => m.id === id)
    || state.models.find((m) => m.id === id);
  if (hit && hit.rates) return hit.rates;
  if (!id || id === 'auto') return (state.ranked[0] && state.ranked[0].rates) || null;
  return null;
}

function currentOutgoingText() {
  const ta = $('outgoing-edit');
  if (ta && ta.value.trim()) return ta.value;
  return (state.outgoing && state.outgoing.combined) || '';
}

function optionLabel(name, rates, model) {
  const reasoning = !!(model && (model.reasoning || looksReasoningModel(model.id)));
  const cost = reportCostFromRates(rates, reportUsageEstimate({
    inputText: currentOutgoingText(),
    reasoning,
  }));
  return `${name} · ${formatGbp(cost)} per report`;
}

function displayedUsage() {
  const u = state.usage || emptyUsage();
  return {
    prompt: u.prompt + u.livePrompt,
    completion: u.completion + u.liveCompletion,
    reasoning: u.reasoning + u.liveReasoning,
  };
}

function roundMoney(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 1e6) / 1e6;
}

function usagePartsFromSnap(snap) {
  if (!snap || typeof snap !== 'object') return { prompt: 0, completion: 0, reasoning: 0 };
  const hasParts = snap.prompt != null || snap.completion != null || snap.reasoning != null;
  if (hasParts) {
    return {
      prompt: Number(snap.prompt) || 0,
      completion: Number(snap.completion) || 0,
      reasoning: Number(snap.reasoning) || 0,
    };
  }
  return {
    prompt: Number(snap.inputTokens) || 0,
    completion: Number(snap.outputTokens) || Number(snap.tokens) || 0,
    reasoning: 0,
  };
}

function formatSplitCostHtml(usd, rates) {
  if (rates && !(Number(rates.prompt) || Number(rates.completion))) return 'free';
  if (usd == null || !Number.isFinite(Number(usd))) return '—';
  return formatChatCostHtml(usd);
}

function splitView(usage, rates, snap) {
  const split = usageSplit(rates, usage);
  let inUsd = split.inputUsd;
  let outUsd = split.outputUsd;
  if (inUsd == null && snap && Number.isFinite(Number(snap.inputUsd))) inUsd = Number(snap.inputUsd);
  if (outUsd == null && snap && Number.isFinite(Number(snap.outputUsd))) outUsd = Number(snap.outputUsd);
  let totalUsd = split.totalUsd;
  if (totalUsd == null && inUsd != null && outUsd != null) totalUsd = inUsd + outUsd;
  if (totalUsd == null && snap && Number.isFinite(Number(snap.usd))) totalUsd = Number(snap.usd);
  return {
    inputTokens: split.inputTokens,
    outputTokens: split.outputTokens,
    inputHtml: formatSplitCostHtml(inUsd, rates),
    outputHtml: formatSplitCostHtml(outUsd, rates),
    totalHtml: formatSplitCostHtml(totalUsd, rates),
  };
}

function paintUsage() {
  const tokIn = $('metric-tokens-in');
  const tokOut = $('metric-tokens-out');
  const costIn = $('metric-cost-in');
  const costOut = $('metric-cost-out');
  const costTotal = $('metric-cost-total');
  if (!tokIn || !tokOut || !costIn || !costOut || !costTotal) return;
  const view = splitView(displayedUsage(), state.usage.rates);
  tokIn.textContent = view.inputTokens.toLocaleString('en-GB');
  tokOut.textContent = view.outputTokens.toLocaleString('en-GB');
  costIn.innerHTML = view.inputHtml;
  costOut.innerHTML = view.outputHtml;
  costTotal.innerHTML = view.totalHtml;
}

function formatChatCostHtml(usdAmount) {
  const gbp = Math.max(0, Number(usdAmount) * USD_TO_GBP);
  if (!Number.isFinite(gbp)) return '—';
  const millipence = Math.round(gbp * 100000);
  const pounds = Math.floor(millipence / 100000);
  const rest = millipence % 100000;
  const pence = Math.floor(rest / 1000);
  const frac = rest % 1000;
  return `£${pounds.toLocaleString('en-GB')}.${String(pence).padStart(2, '0')}<small class="pence-frac">${String(frac).padStart(3, '0')}</small>`;
}

function usageBreakdownHtml(snap) {
  const usage = usagePartsFromSnap(snap);
  const rates = (snap && snap.rates) || null;
  const view = splitView(usage, rates, snap);
  return `<div class="report-usage">
    <div class="usage-row" data-kind="input"><span class="usage-kind">input</span><span class="usage-tokens">${view.inputTokens.toLocaleString('en-GB')}</span><span class="usage-cost">${view.inputHtml}</span></div>
    <div class="usage-row" data-kind="output"><span class="usage-kind">output</span><span class="usage-tokens">${view.outputTokens.toLocaleString('en-GB')}</span><span class="usage-cost">${view.outputHtml}</span></div>
    <div class="usage-row" data-kind="total"><span class="usage-kind">total</span><span class="usage-tokens"></span><span class="usage-cost">${view.totalHtml}</span></div>
  </div>`;
}

function usageSnapshot() {
  const shown = displayedUsage();
  const rates = state.usage.rates || null;
  const split = usageSplit(rates, shown);
  const usd = usageCost(rates, shown);
  return {
    tokens: split.inputTokens + split.outputTokens,
    prompt: shown.prompt,
    completion: shown.completion,
    reasoning: shown.reasoning,
    inputTokens: split.inputTokens,
    outputTokens: split.outputTokens,
    usd: roundMoney(usd),
    gbp: roundMoney(usd == null ? null : usd * USD_TO_GBP),
    inputUsd: roundMoney(split.inputUsd),
    outputUsd: roundMoney(split.outputUsd),
    inputGbp: roundMoney(split.inputUsd == null ? null : split.inputUsd * USD_TO_GBP),
    outputGbp: roundMoney(split.outputUsd == null ? null : split.outputUsd * USD_TO_GBP),
    cost: formatGbp(usd),
    inputCost: formatGbp(split.inputUsd),
    outputCost: formatGbp(split.outputUsd),
    model: (state.result && state.result.model) || state.usage.modelId || '',
    provider: activeProvider(),
    rates,
  };
}

function usageHiddenComment(snap) {
  const json = JSON.stringify(snap || usageSnapshot()).replace(/--/g, '\\u002d\\u002d');
  return `<!--cga-usage:${json}-->`;
}

function parseUsageComment(text) {
  const m = String(text || '').match(/<!--cga-usage:([\s\S]*?)-->/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\u002d\\u002d/g, '--')); } catch { return null; }
}

function stripUsageComment(text) {
  return String(text || '').replace(/\n*<!--cga-usage:[\s\S]*?-->\s*$/g, '').replace(/\s+$/, '');
}

function applyUsageSnapshot(snap) {
  if (!snap) { resetUsage(); return; }
  const parts = usagePartsFromSnap(snap);
  state.usage = {
    ...emptyUsage(),
    prompt: parts.prompt,
    completion: parts.completion,
    reasoning: parts.reasoning,
    rates: snap.rates || null,
    modelId: snap.model || '',
  };
  paintUsage();
}

function countThinkWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function formatThinkTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function paintThinkStats() {
  const timeEl = $('think-time');
  const wordEl = $('think-words');
  if (!timeEl || !wordEl) return;
  const ms = thinkTimer.start ? performance.now() - thinkTimer.start : 0;
  timeEl.textContent = formatThinkTime(ms);
  const n = thinkTimer.words;
  wordEl.textContent = `${n} word${n === 1 ? '' : 's'}`;
}

function tickThinkStats() {
  paintThinkStats();
  if (state.analysePhase === 'thinking') thinkTimer.raf = requestAnimationFrame(tickThinkStats);
}

function startThinkStats() {
  if (thinkTimer.raf) cancelAnimationFrame(thinkTimer.raf);
  thinkTimer.start = performance.now();
  thinkTimer.words = 0;
  paintThinkStats();
  thinkTimer.raf = requestAnimationFrame(tickThinkStats);
}

function stopThinkStats() {
  if (thinkTimer.raf) cancelAnimationFrame(thinkTimer.raf);
  thinkTimer.raf = 0;
}

function activeProvider() { return state.settings.provider || 'openrouter'; }
function currentKey() {
  const keys = state.settings.apiKeys || {};
  return (keys[activeProvider()] || state.settings.apiKey || state.sessionKey || '').trim();
}
function isOpenRouter() { return activeProvider() === 'openrouter'; }
function baseUrl() {
  const info = AI_PROVIDERS[activeProvider()];
  return (info && info.openaiBaseUrl) || OPENROUTER_BASE;
}
function hasAnyKey() {
  return providersWithKeys(state.settings.apiKeys).length > 0 || !!(state.settings.apiKey || state.sessionKey);
}

function showScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('on', s.id === `screen-${name}`);
  });
  if (name === 'reports') renderReportList();
  if (name === 'analyse') {
    updateModelCard();
    paintUsage();
    renderGuard();
  }
  if (name === 'combine') renderCombine();
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

function bloomPartners(origin) {
  if (!origin) return [];
  if (origin.classList.contains('upload-disc') || origin.classList.contains('upload-orb')) return [...document.querySelectorAll('#screen-home .upload-disc, #screen-home .upload-orb')];
  if (origin.classList.contains('combine-start-disc') || origin.classList.contains('combine-start')) return [...document.querySelectorAll('#screen-combine .combine-start-disc, #screen-combine .combine-start')];
  if (origin.classList.contains('combine-disc') || origin.classList.contains('combine-open')) return [...document.querySelectorAll('#screen-home .combine-disc, #screen-home .combine-open')];
  if (origin.classList.contains('combine-back-disc') || origin.classList.contains('combine-back')) return [...document.querySelectorAll('#screen-combine .combine-back-disc, #screen-combine .combine-back')];
  return [origin];
}

async function bloomReveal(to, source) {
  const fx = $('fx');
  const blob = fx.querySelector('.fx-blob');
  const full = fx.querySelector('.fx-full');
  const dest = $(`screen-${to}`);
  const origin = source || document.querySelector('.upload-disc');
  const host = origin && origin.closest('.screen');
  const partners = bloomPartners(origin);
  if (reduceMotion()) {
    showScreen(to);
    return;
  }
  const from = origin.getBoundingClientRect();
  const size = from.width;
  const cx = from.left + size / 2;
  const cy = from.top + from.height / 2;
  const grow = coverScale(from);
  const easeCover = 'cubic-bezier(.22, .72, .14, 1)';
  const easeSettle = 'cubic-bezier(.16, .84, .18, 1)';

  placeBloomCircle(blob, cx, cy, size, 1, 1);
  placeBloomCircle(full, cx, cy, size, 1, 0);
  if (host) host.classList.add('bloom-leave');
  partners.forEach((el) => el.classList.add('bloom-source'));
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

    const landEl = dest.querySelector('.combine-start-disc') ||
                   dest.querySelector('.combine-start') ||
                   dest.querySelector('.back-orb') ||
                   dest.querySelector('.upload-disc') ||
                   dest;
    const land = (landEl && landEl.getBoundingClientRect()) || from;
    const tx = land.left + land.width / 2;
    const ty = land.top + land.height / 2;
    const end = (land.width || size) / size;

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
    if (host) host.classList.remove('bloom-leave');
    partners.forEach((el) => el.classList.remove('bloom-source'));
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
  if (from === 'home' && to === 'review') return bloomReveal(to, document.querySelector('.upload-disc'));
  if (from === 'home' && to === 'combine') return bloomReveal(to, document.querySelector('.combine-disc') || document.querySelector('.combine-open'));
  if (from === 'combine' && to === 'review') return bloomReveal(to, document.querySelector('.combine-start-disc'));
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
  showScreen(hasAnyKey() ? 'home' : 'key');
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { /* ignore */ }
  state.settings.apiKeys = { ...emptyApiKeys(), ...(state.settings.apiKeys || {}) };
  if (state.settings.apiKey && !state.settings.apiKeys.openrouter) {
    state.settings.apiKeys.openrouter = state.settings.apiKey;
  }
  if (state.settings.provider === 'custom') state.settings.provider = 'openrouter';
}

function saveSettings() {
  const s = state.settings;
  const apiKeys = s.rememberKey ? s.apiKeys : emptyApiKeys();
  const apiKey = s.rememberKey ? (apiKeys.openrouter || '') : '';
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, apiKeys, apiKey })); } catch { /* ignore */ }
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
    state.settings.rememberKey = true;
    state.settings.apiKey = (state.settings.apiKeys.openrouter || '').trim();
    const have = providersWithKeys(state.settings.apiKeys);
    if (!have.length) return;
    if (!have.includes(state.settings.provider)) state.settings.provider = have[0];
    state.sessionKey = '';
    saveSettings();
    goTo('home');
    populateProviderSelect();
    loadModels();
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

async function expandUploads(files) {
  const pdfs = [];
  const errors = [];
  for (const f of files) {
    const name = f.name || 'file';
    if (/\.zip$/i.test(name)) {
      try {
        const zip = await JSZip.loadAsync(await f.arrayBuffer());
        const entries = Object.values(zip.files).filter((z) => !z.dir && /\.pdf$/i.test(z.name) && !/(^|\/)(__MACOSX|\.)/.test(z.name));
        for (const z of entries) pdfs.push({ name: z.name.split('/').pop(), data: await z.async('uint8array') });
      } catch (err) {
        errors.push(`Could not open ${name}: ${err.message}`);
      }
    } else if (/\.pdf$/i.test(name)) {
      pdfs.push({ name, data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return { pdfs, errors };
}

async function parsePdfs(pdfs, onItem) {
  const parsed = [];
  const fileItems = [];
  let done = 0;
  for (const pdf of pdfs) {
    if (onItem) onItem(pdf, done, pdfs.length);
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
    fileItems.push(item);
    done++;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { pupils: parsed, files: fileItems };
}

async function handleFiles(files, { followUp = false } = {}) {
  const { pdfs, errors } = await expandUploads(files);
  if (errors.length && !pdfs.length) showProgress(true, errors[0], 0);
  if (!pdfs.length) { showProgress(false); return []; }
  if (!followUp) { state.files = []; state.parsedPupils = []; }
  const { pupils, files: items } = await parsePdfs(pdfs, (pdf, done, total) => {
    showProgress(true, `${pdf.name}  ·  ${done + 1} of ${total}`, done / total);
  });
  showProgress(false, 'Done.', 1);
  if (followUp) return pupils;
  state.files = items;
  rebuildFromFiles();
  await wait(700);
  showProgress(false);
  await goTo('review');
  return pupils;
}

const CLASS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function combineLabel(index, meta) {
  const letter = index < CLASS_LETTERS.length ? CLASS_LETTERS[index] : String(index + 1);
  const code = (meta && meta.classCode || '').trim();
  return code ? `Class ${letter} · ${code}` : `Class ${letter}`;
}

function combineRows(pupils) {
  const byName = new Map();
  const rows = [];
  for (const p of pupils) {
    const named = p.displayName && !/^unknown pupil/i.test(p.displayName);
    const key = named ? p.displayName.toLowerCase() : '';
    if (key && byName.has(key)) {
      const existing = byName.get(key);
      existing.pupil.assessments = existing.pupil.assessments.concat(p.assessments || []);
      continue;
    }
    const row = {
      id: `p${Date.now().toString(36)}${rows.length}`,
      name: p.displayName || 'Unknown pupil',
      picked: false,
      pupil: { ...p, assessments: [...(p.assessments || [])] },
    };
    if (key) byName.set(key, row);
    rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
  return rows;
}

function tickedCombineCount() {
  return state.combineClasses.reduce((n, cls) => n + cls.rows.filter((r) => r.picked).length, 0);
}

function renderCombineCount() {
  const el = $('combine-count');
  const word = $('combine-count-word');
  if (!el) return;
  const n = tickedCombineCount();
  const text = String(n);
  if (word) word.textContent = n === 1 ? 'pupil' : 'pupils';
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function layoutCombineColumns() {
  const board = $('combine-board');
  if (!board || state.screen !== 'combine') return;
  const cols = [...board.querySelectorAll('.combine-col')];
  if (!cols.length) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const gap = 20;
  const marginL = Math.max(28, w * 0.04);
  const go = Math.min(w * 0.30, 340);
  const reserveR = w * 0.02 + go * 1.15 + 24;
  board.style.right = `${reserveR}px`;
  const n = cols.length;
  const avail = Math.max(160, w - marginL - reserveR);
  let colW = Math.min(275, (avail - gap * Math.max(0, n - 1)) / n);
  if (colW < 200) colW = 200;
  const total = marginL + n * colW + (n - 1) * gap + 24;
  board.style.setProperty('--board-w', `${Math.max(total, board.clientWidth)}px`);

  // Seam slopes downwards to the right (top section moved up)
  const seamY1 = h * 0.18;
  const seamY2 = h * 0.30;
  const seamAngle = Math.atan2(seamY2 - seamY1, w) * (180 / Math.PI);
  board.style.setProperty('--seam-angle', `${seamAngle.toFixed(2)}deg`);

  let maxBottom = h;
  cols.forEach((col, i) => {
    const left = marginL + i * (colW + gap);
    col.style.left = `${left}px`;
    col.style.width = `${colW}px`;
    const cx = left - board.scrollLeft + colW / 2;
    const seam = seamY1 + (seamY2 - seamY1) * (cx / w);
    const head = col.querySelector('.combine-col-head');
    const headH = head ? head.offsetHeight : 44;
    const top = Math.max(10, seam - headH / 2);
    col.style.top = `${top}px`;
    col.style.height = 'auto';
    if (head) {
      head.style.transform = `rotate(${seamAngle.toFixed(2)}deg)`;
      head.style.transformOrigin = 'center center';
    }
    const b = top + col.offsetHeight;
    if (b > maxBottom) maxBottom = b;
  });
  board.style.minHeight = `${maxBottom + 80}px`;
}

function appendPupilsLive(cls, newRows) {
  const board = $('combine-board');
  if (!board) return;
  const col = board.querySelector(`.combine-col[data-class-id="${cls.id}"]`);
  if (!col) {
    renderCombine();
    return;
  }
  const title = col.querySelector('.combine-class-pill span');
  if (title) title.textContent = cls.label;
  const pupilsDiv = col.querySelector('.combine-col-pupils');
  if (!pupilsDiv) return;
  const q = state.combineQuery.trim().toLowerCase();
  for (const row of newRows) {
    if (q && !row.name.toLowerCase().includes(q)) continue;
    const label = document.createElement('label');
    label.className = 'combine-pupil pop-in';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.picked;
    box.dataset.pupil = row.id;
    const pupil = document.createElement('span');
    pupil.textContent = row.name;
    label.append(box, pupil);
    pupilsDiv.appendChild(label);
  }
  layoutCombineColumns();
}

function renderCombine() {
  const board = $('combine-board');
  if (!board) return;
  const status = $('combine-status');
  const q = state.combineQuery.trim().toLowerCase();
  board.innerHTML = '';
  let shown = 0;
  for (const cls of state.combineClasses) {
    const col = document.createElement('div');
    col.className = 'combine-col';
    col.dataset.classId = cls.id;
    const head = document.createElement('div');
    head.className = 'combine-col-head';
    const pill = document.createElement('div');
    pill.className = 'pill combine-class-pill';
    const name = document.createElement('span');
    name.textContent = cls.label;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'combine-remove';
    rm.dataset.removeClass = cls.id;
    rm.setAttribute('aria-label', `Remove ${cls.label}`);
    rm.textContent = '×';
    pill.append(name, rm);
    head.appendChild(pill);
    const pupils = document.createElement('div');
    pupils.className = 'combine-col-pupils';
    const rows = cls.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
    shown += rows.length;
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'combine-pupil';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = row.picked;
      box.dataset.pupil = row.id;
      const pupil = document.createElement('span');
      pupil.textContent = row.name;
      label.append(box, pupil);
      pupils.appendChild(label);
    }
    col.append(head, pupils);
    board.appendChild(col);
  }
  const addCol = document.createElement('div');
  addCol.className = 'combine-col combine-col-add';
  const addHead = document.createElement('div');
  addHead.className = 'combine-col-head';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pill';
  add.id = 'combine-add';
  add.textContent = 'Add class';
  add.disabled = state.combineBusy;
  addHead.appendChild(add);
  addCol.appendChild(addHead);
  board.appendChild(addCol);
  if (status && !state.combineBusy) {
    status.textContent = (q && state.combineClasses.length && !shown) ? 'No pupil matches that search.' : '';
  }
  renderCombineCount();
  layoutCombineColumns();
}

function removeCombineClass(id) {
  state.combineClasses = state.combineClasses.filter((c) => c.id !== id);
  if (state.combineActive === id) state.combineActive = (state.combineClasses[0] && state.combineClasses[0].id) || null;
  renderCombine();
}

async function addCombineClass(files) {
  if (state.combineBusy) return;
  state.combineBusy = true;
  const addBtn = $('combine-add');
  if (addBtn) addBtn.disabled = true;
  const status = $('combine-status');
  let holdStatus = '';
  try {
    const { pdfs, errors } = await expandUploads(files);
    if (!pdfs.length) {
      holdStatus = errors[0] || 'That was not a zip or PDF of pupil reports.';
      return;
    }

    const classIdx = state.combineClasses.length;
    const clsId = `c${Date.now().toString(36)}`;
    const cls = {
      id: clsId,
      label: combineLabel(classIdx, {}),
      rows: [],
      files: [],
      loading: true,
    };
    state.combineClasses.push(cls);
    state.combineActive = cls.id;
    renderCombine();

    let done = 0;
    const seenNames = new Set();
    for (const pdf of pdfs) {
      if (status) status.textContent = `Reading ${pdf.name} · ${done + 1} of ${pdfs.length}`;
      const item = { name: pdf.name, status: 'ok', pupils: [], warnings: [] };
      try {
        const structure = await extractPdfStructure(pdfjsLib, pdf.data);
        const totalRows = structure.pages.reduce((s, p) => s + p.rows.length, 0);
        if (!totalRows) {
          item.status = 'bad';
          item.warnings.push('No selectable text.');
        } else {
          const report = parseReport(structure, { filename: pdf.name });
          item.pupils = report.pupils;
          const addedRows = [];
          for (const p of report.pupils) {
            const key = p.displayName ? p.displayName.trim().toLowerCase() : '';
            if (key && seenNames.has(key)) {
              const existing = cls.rows.find((r) => r.name.toLowerCase() === key);
              if (existing) {
                existing.pupil.assessments = existing.pupil.assessments.concat(p.assessments || []);
              }
              continue;
            }
            if (key) seenNames.add(key);
            const row = {
              id: `p${Date.now().toString(36)}_${cls.rows.length}_${Math.random().toString(36).slice(2, 6)}`,
              name: p.displayName || 'Unknown pupil',
              picked: false,
              pupil: { ...p, assessments: [...(p.assessments || [])] },
            };
            cls.rows.push(row);
            addedRows.push(row);
          }
          if (addedRows.length) {
            const meta = classMetaFromPupils(cls.rows.map((r) => r.pupil));
            cls.label = combineLabel(classIdx, meta);
            appendPupilsLive(cls, addedRows);
            renderCombineCount();
          }
        }
      } catch (err) {
        item.status = 'bad';
        item.warnings.push(err.message);
      }
      cls.files.push(item);
      done++;
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!cls.rows.length) {
      state.combineClasses = state.combineClasses.filter((c) => c.id !== clsId);
      holdStatus = 'No pupil names were found in that file.';
    } else {
      cls.rows.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
      cls.loading = false;
      holdStatus = `${cls.rows.length} pupils loaded into ${cls.label}.`;
    }
  } finally {
    state.combineBusy = false;
    renderCombine();
    if (holdStatus && status) status.textContent = holdStatus;
  }
}

function startCombinedClass() {
  const picked = [];
  let classesUsed = 0;
  for (const cls of state.combineClasses) {
    const chosen = cls.rows.filter((r) => r.picked);
    if (!chosen.length) continue;
    classesUsed += 1;
    picked.push(...chosen.map((r) => r.pupil));
  }
  if (!picked.length) {
    const start = $('combine-start');
    if (start) {
      start.classList.remove('need-picks');
      void start.offsetWidth;
      start.classList.add('need-picks');
    }
    return;
  }
  const byName = new Map();
  const pupils = [];
  for (const p of picked) {
    const named = p.displayName && !/^unknown pupil/i.test(p.displayName);
    const key = named ? p.displayName.toLowerCase() : '';
    if (key && byName.has(key)) {
      const existing = byName.get(key);
      existing.assessments = existing.assessments.concat(p.assessments || []);
      continue;
    }
    const copy = { ...p, assessments: [...(p.assessments || [])] };
    if (key) byName.set(key, copy);
    pupils.push(copy);
  }
  state.files = [{ name: 'Intervention group', status: 'ok', pupils, warnings: [] }];
  state.parsedPupils = [];
  rebuildFromFiles();
  const note = $('parse-status');
  if (note) note.textContent = `Intervention group from ${classesUsed} class${classesUsed === 1 ? '' : 'es'}. ${note.textContent}`;
  goTo('review');
}

function wireCombine() {
  const search = $('combine-search');
  if (search) {
    search.addEventListener('input', () => {
      state.combineQuery = search.value;
      renderCombine();
    });
  }
  const board = $('combine-board');
  if (board) {
    board.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-class]');
      if (rm) { removeCombineClass(rm.dataset.removeClass); return; }
      if (e.target.closest('#combine-add')) $('combine-file').click();
    });
    board.addEventListener('change', (e) => {
      const id = e.target && e.target.dataset && e.target.dataset.pupil;
      if (!id) return;
      for (const cls of state.combineClasses) {
        const row = cls.rows.find((r) => r.id === id);
        if (row) row.picked = !!e.target.checked;
      }
      renderCombineCount();
    });
    board.addEventListener('scroll', () => layoutCombineColumns());
  }
  window.addEventListener('resize', () => layoutCombineColumns());
  const file = $('combine-file');
  if (file) {
    file.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) addCombineClass(files);
    });
  }
  const screen = $('screen-combine');
  if (screen) {
    ['dragenter', 'dragover'].forEach((ev) => screen.addEventListener(ev, (e) => e.preventDefault()));
    screen.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) addCombineClass(files);
    });
  }
  const start = $('combine-start');
  if (start) start.addEventListener('click', () => startCombinedClass());
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
  if (state.combineClasses && state.combineClasses.length) {
    for (const cls of state.combineClasses) {
      for (const row of cls.rows || []) {
        const p = row.pupil;
        if (p) {
          if (p.displayName) ds.fullNames.add(p.displayName.toLowerCase());
          (p.nameTokens || []).forEach((t) => ds.nameTokens.add(t));
          (p.identifiers || []).forEach((id) => ds.identifierStrings.add(id));
        }
      }
    }
  }
  setSecurityDataset(ds);
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

function promptChoices() {
  return {
    sectionIds: [...document.querySelectorAll('[data-prompt-sec]:checked')].map((el) => el.dataset.promptSec),
    extraIds: [...document.querySelectorAll('[data-prompt-extra]:checked')].map((el) => el.dataset.promptExtra),
    otherText: $('prompt-other') ? $('prompt-other').value : '',
  };
}

function fillPromptPicker() {
  const core = $('prompt-core');
  const extra = $('prompt-extra');
  if (core) {
    core.innerHTML = CORE_SECTIONS.map((s) => `<label><input type="checkbox" data-prompt-sec="${escapeHtml(s.id)}"${s.defaultOn ? ' checked' : ''}> ${escapeHtml(s.label)}</label>`).join('');
  }
  if (extra) {
    extra.innerHTML = EXTRA_SECTIONS.map((s) => `<label><input type="checkbox" data-prompt-extra="${escapeHtml(s.id)}"> ${escapeHtml(s.label)}</label>`).join('');
  }
  const ex = $('prompt-other-example');
  if (ex) ex.textContent = OTHER_EXAMPLE;
}

function doRefreshPayload() {
  const ds = state.dataset;
  if (!ds) return;
  setSecurityDataset(ds);
  const context = {
    subject: ds.scrub($('subject').value, null, 'subject'),
    yearGroup: ds.scrub($('year-group').value, null, 'year group'),
    notes: ds.scrub($('extra-context').value, null, 'notes'),
    templateTopics: state.templateTopics.map((t) => ds.scrub(t, null, 'template')),
  };
  state.payload = buildPayload(ds, context);
  const activeMeasures = ds.measures.filter((m) => !m.excluded);
  const picks = promptChoices();
  const otherText = ds.scrub(picks.otherText, null, 'prompt note');
  const built = buildOutgoing({
    payload: state.payload,
    subject: context.subject,
    hasTargets: activeMeasures.some((m) => m.flags.includes('target')),
    hasEffort: activeMeasures.some((m) => m.flags.includes('effort') || /atl|homework|classwork|handwriting/i.test(m.name)),
    rowsAreSubjects: ds.pupils.some((p) => p.rowsAreSubjects),
    sectionIds: picks.sectionIds,
    extraIds: picks.extraIds,
    otherText,
  });
  const ta = $('outgoing-edit');
  if (ta && state.outgoingTouched) {
    const rawVal = ds.scrub(ta.value, null, 'outgoing-edit', { keepLayout: true });
    state.outgoing = parseOutgoingCombined(rawVal);
  } else {
    if (ta) ta.value = built.combined;
    state.outgoing = built;
  }
  state.guard = guardPayload(state.outgoing.combined, ds);
  renderGuard();
  relabelModelOptions();
}

function nameScanSource(g) {
  if (g && g.source) return g.source;
  if (state.nameScanPending && state.nameScanPending.text) return state.nameScanPending.text;
  if (state.outgoing && state.outgoing.combined) return state.outgoing.combined;
  const ta = $('outgoing-edit');
  return (ta && ta.value) || '';
}

function possibleNameHits(g) {
  const hits = [];
  const seen = new Set();
  const source = nameScanSource(g);
  for (const f of (g && g.findings) || []) {
    if (f.type !== 'possible name') continue;
    const key = String(f.match || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = Number.isFinite(Number(f.index)) ? Number(f.index) : source.toLowerCase().indexOf(key);
    const around = wordsAround(source, idx < 0 ? 0 : idx, f.match);
    hits.push({
      match: f.match,
      pre: around.pre,
      post: around.post,
      morePre: around.morePre,
      morePost: around.morePost,
    });
  }
  return hits;
}

function identBlockHtml(blocks) {
  return `<strong>This will not be sent.</strong> Something identifying is still in the message: ${blocks.slice(0, 8).map((f) => `${escapeHtml(f.type)} (${escapeHtml(f.match)})`).join('; ')}.`;
}

function nameSnippetHtml(hit) {
  const pre = (hit.pre || []).map(escapeHtml).join(' ');
  const post = (hit.post || []).map(escapeHtml).join(' ');
  const left = `<span class="name-around">${hit.morePre ? '… ' : ''}${pre}</span>`;
  const right = `<span class="name-around">${post}${hit.morePost ? ' …' : ''}</span>`;
  return `${left} <b class="name-hit">${escapeHtml(hit.match)}</b> ${right}`;
}

function nameWarningHtml(names, { actions = false } = {}) {
  const rows = names.map((n) => `<li>${nameSnippetHtml(n)}</li>`).join('');
  const next = actions
    ? `<div class="name-warning-actions">
         <button type="button" class="pill name-goback">Go back and edit</button>
         <button type="button" class="pill ghost name-anyway">Send anyway</button>
       </div>`
    : `<p>If these are question text or author names, you can send anyway on the next page.</p>`;
  return `<strong>This message contains possible names.</strong>
    <p>The safeguard spotted words that look like personal names in the message:</p>
    <ul class="name-snips">${rows}</ul>
    <p>If these are pupil or staff names, please go back and replace them with codes. If they are question text or author names (e.g. in an assessment title or question such as "Alice has 3 watermelons"), you can send anyway.</p>
    ${next}`;
}

function fillGuardBox(el, blocks, names, actions) {
  if (!el) return;
  if (blocks.length) {
    el.hidden = false;
    el.className = el.classList.contains('name-banner') ? 'guard name-banner bad' : 'guard bad';
    el.innerHTML = identBlockHtml(blocks);
  } else if (names.length) {
    el.hidden = false;
    el.className = el.classList.contains('name-banner') ? 'guard name-banner names' : 'guard names';
    el.innerHTML = nameWarningHtml(names, { actions });
  } else {
    el.className = el.classList.contains('name-banner') ? 'guard name-banner' : 'guard';
    el.textContent = '';
    el.hidden = true;
  }
}

function hideReportNameWarnings() {
  document.querySelectorAll('#screen-analyse .name-banner').forEach((el) => {
    el.className = 'guard name-banner';
    el.textContent = '';
    el.hidden = true;
  });
}

function renderGuard() {
  const g = state.guard;
  const blocks = g ? g.findings.filter((f) => f.severity === 'block') : [];
  const names = possibleNameHits(g);
  fillGuardBox($('guard-banner'), blocks, names, false);
  const sending = state.analysePhase === 'thinking' || state.analysePhase === 'streaming';
  document.querySelectorAll('.name-banner').forEach((el) => {
    if (sending) {
      el.className = 'guard name-banner';
      el.textContent = '';
      el.hidden = true;
    } else {
      fillGuardBox(el, blocks, names, true);
    }
  });
}

function nameWarningGoBack() {
  state.nameScanPending = null;
  goTo('review');
}

function confirmNameScanAndSend() {
  const pending = state.nameScanPending;
  const text = (pending && pending.text)
    || (state.outgoing && state.outgoing.combined)
    || '';
  state.nameScanConfirmed = text;
  const followUp = !!(pending && pending.followUp);
  state.nameScanPending = null;
  if (followUp) sendFollowUp();
  else runAnalysis();
}

async function loadTemplate(file) {
  try {
    const structure = await extractPdfStructure(pdfjsLib, new Uint8Array(await file.arrayBuffer()));
    const parsed = parseReport(structure, { filename: file.name });
    const hasPupilData = parsed.pupils.some((p) => (p.displayName && !/^unknown pupil/i.test(p.displayName)) || (p.identifiers && p.identifiers.length));
    if (hasPupilData && state.dataset) {
      for (const p of parsed.pupils) {
        if (p.displayName) state.dataset.fullNames.add(p.displayName.toLowerCase());
        (p.nameTokens || []).forEach((t) => state.dataset.nameTokens.add(t));
        (p.identifiers || []).forEach((id) => state.dataset.identifierStrings.add(id));
      }
    }
    const names = [];
    for (const p of parsed.pupils) {
      for (const a of p.assessments) {
        if (a.name) {
          const clean = state.dataset ? state.dataset.scrub(a.name, null, 'template') : a.name;
          if (clean && !clean.includes('[removed]')) names.push(clean);
        }
      }
    }
    state.templateTopics = [...new Set(names)];
    $('empty-assessment-status').textContent = `${state.templateTopics.length} course items were read from the sheet.${hasPupilData ? ' (All pupil names/IDs stripped).' : ''}`;
    refreshPayload();
  } catch (err) {
    $('empty-assessment-status').textContent = `That PDF could not be read (${err.message}).`;
  }
}

function populateProviderSelect() {
  const sel = $('provider-select');
  if (!sel) return;
  const have = providersWithKeys(state.settings.apiKeys);
  const prev = state.settings.provider;
  sel.innerHTML = '';
  for (const id of have) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = providerLabel(id);
    sel.appendChild(o);
  }
  if (!have.length) {
    const o = document.createElement('option');
    o.value = 'openrouter';
    o.textContent = 'Add an API key first';
    sel.appendChild(o);
  }
  state.settings.provider = have.includes(prev) ? prev : (have[0] || 'openrouter');
  sel.value = state.settings.provider;
}

async function loadModels() {
  populateProviderSelect();
  $('model-status').textContent = 'Loading the list of models…';
  if (!currentKey()) {
    state.models = []; state.ranked = []; state.rankedAll = [];
    $('model-status').textContent = 'Add an API key, then pick a provider.';
    populateModelSelect();
    return;
  }
  try {
    const res = await listModelsForProvider(activeProvider(), currentKey());
    state.models = res.models || [];
    state.ranked = res.ranked || [];
    state.rankedAll = res.rankedAll || [];
    if (res.error) $('model-status').textContent = `Using a short list (${res.error}).`;
  } catch (err) {
    state.models = []; state.ranked = []; state.rankedAll = [];
    $('model-status').textContent = `The model list could not be loaded (${err.message}).`;
  }
  populateModelSelect();
}

function modelForOption(id) {
  return state.rankedAll.find((m) => m.id === id) || state.ranked.find((m) => m.id === id) || { id, name: id, reasoning: looksReasoningModel(id) };
}

function relabelModelOptions() {
  const sel = $('model-select');
  if (!sel || !sel.options.length) return;
  for (const o of sel.options) {
    if (o.value === 'auto') {
      const best = state.ranked[0];
      o.textContent = best ? optionLabel(`Automatic – ${best.name}`, best.rates, best) : 'Automatic';
    } else if (o.value === FREE_ROUTER_ID) {
      o.textContent = optionLabel('OpenRouter free router', { prompt: 0, completion: 0 }, { id: FREE_ROUTER_ID });
    } else {
      const m = modelForOption(o.value);
      o.textContent = optionLabel(m.name || o.value, m.rates, m);
    }
  }
}

function populateModelSelect() {
  const sel = $('model-select');
  const prev = state.settings.model || 'auto';
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  const best = state.ranked[0];
  auto.textContent = best ? optionLabel(`Automatic – ${best.name}`, best.rates, best) : 'Automatic';
  sel.appendChild(auto);
  const list = isOpenRouter() ? state.ranked.slice(0, 20) : state.ranked.slice(0, 40);
  for (const m of list) {
    const o = document.createElement('option'); o.value = m.id; o.textContent = optionLabel(m.name, m.rates, m); sel.appendChild(o);
  }
  if (isOpenRouter()) {
    const fr = document.createElement('option'); fr.value = FREE_ROUTER_ID; fr.textContent = optionLabel('OpenRouter free router', { prompt: 0, completion: 0 }, { id: FREE_ROUTER_ID });
    sel.appendChild(fr);
  }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'auto';
  if (isOpenRouter()) {
    $('model-status').textContent = best
      ? `${state.ranked.length} free reasoning models are available. First pick: ${best.name}.`
      : 'Using the free router.';
  } else {
    $('model-status').textContent = best
      ? `${state.ranked.length} models from ${providerLabel(activeProvider())}. First pick: ${best.name}.`
      : `No models listed for ${providerLabel(activeProvider())}.`;
  }
  updateModelCard();
}

function candidateModels() {
  const chosen = $('model-select').value || 'auto';
  if (!isOpenRouter()) {
    if (chosen === 'auto') return state.ranked.slice(0, 5);
    const rest = state.ranked.filter((m) => m.id !== chosen).slice(0, 4);
    const meta = state.rankedAll.find((m) => m.id === chosen) || chosen;
    return [meta, ...rest];
  }
  const top = state.ranked.slice(0, 5);
  if (chosen === 'auto') return [...top, FREE_ROUTER_ID];
  const rest = top.filter((m) => m.id !== chosen);
  const chosenMeta = state.rankedAll.find((m) => m.id === chosen) || chosen;
  return [chosenMeta, ...rest, FREE_ROUTER_ID].filter((m, i, arr) => arr.findIndex((x) => (x.id || x) === (m.id || m)) === i);
}

function followUpCandidates() {
  const id = (state.result && state.result.model) || state.usage.modelId || '';
  if (!id || id === 'auto') return candidateModels();
  const meta = state.rankedAll.find((m) => m.id === id) || state.ranked.find((m) => m.id === id) || { id };
  return [meta];
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
    const card = await fetchModelCard(id, state.settings.apiKeys.openrouter || '', activeProvider());
    if (!card) return;
    $('metric-tps').textContent = card.tokensPerSec != null ? String(card.tokensPerSec) : '—';
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
  const prev = state.analysePhase;
  state.analysePhase = phase;
  const hasReport = !!(state.result && state.result.markdown);
  $('go-stage').hidden = phase !== 'idle';
  $('think-wrap').hidden = phase !== 'thinking';
  $('report').hidden = !hasReport && (phase === 'idle' || phase === 'thinking');
  $('extra-wrap').hidden = phase !== 'idle';
  $('model-pick-wrap').hidden = phase !== 'idle';
  $('provider-pick-wrap').hidden = phase !== 'idle';
  $('go-wrap').hidden = phase !== 'idle' && phase !== 'error';
  $('ident-wrap').hidden = phase !== 'streaming' && phase !== 'done';
  $('run-wrap').hidden = phase !== 'thinking' && phase !== 'streaming';
  $('done-wrap').hidden = phase !== 'done' && phase !== 'error';
  $('composer').hidden = phase !== 'done';
  if (phase === 'thinking' && prev !== 'thinking') startThinkStats();
  if (phase !== 'thinking') stopThinkStats();
  if (phase === 'done') {
    fillCodeGrid();
    sizeFollowUp();
  }
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
  thinkTimer.words = countThinkWords(text);
  paintThinkStats();
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
  md = stripUsageComment(md);
  const withComment = (html) => `${html}\n${usageHiddenComment()}`;
  if (!state.showNames || !state.dataset) return withComment(renderMarkdown(md));
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
  const html = renderMarkdown(marked).replace(/\uE000(\d+)\uE001/g, (all, id) => {
    const mark = marks[Number(id)];
    if (!mark) return all;
    return `<span class="name" title="${escapeHtml(mark.code)}">${escapeHtml(mark.name)}</span>`;
  });
  return withComment(html);
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
  setSecurityDataset(state.dataset);
  try {
    doRefreshPayload();
  } catch (err) {
    showAnalysisError(err);
    return;
  }
  if (!state.guard || !state.guard.ok) {
    $('run-status').textContent = 'Blocked by the privacy check.';
    renderGuard();
    return;
  }
  const outgoing = (state.outgoing && state.outgoing.combined) || '';
  const names = possibleNameHits(state.guard);
  if (names.length && state.nameScanConfirmed !== outgoing) {
    state.nameScanPending = { followUp: false, text: outgoing };
    renderGuard();
    $('run-status').textContent = 'Check the name warning. If it is only a question or author name, click Send anyway.';
    const banner = document.querySelector('#screen-analyse .name-banner');
    if (banner) banner.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!followUp) {
    const system = (state.outgoing.system || '').trim();
    const user = (state.outgoing.user || state.outgoing.combined || '').trim();
    state.messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ];
    state.result = { markdown: '', model: '', reasoning: '' };
    $('report').innerHTML = '';
    state.reportId = `${Date.now()}`;
    resetUsage();
  } else if (state.reportId != null && state.reportId !== '') {
    state.reportId = String(state.reportId);
  }

  // Pre-flight validation on entire conversation history
  const historyCheck = verifyAllMessagesSafe(state.messages, state.dataset);
  if (!historyCheck.ok) {
    $('run-status').textContent = 'Blocked by the privacy check: identifying pupil data detected in message history.';
    setAnalysePhase('idle');
    renderGuard();
    return;
  }

  hideReportNameWarnings();
  state.usage.livePrompt = estimateTextTokens(state.messages.map((m) => m.content).join('\n'));
  state.usage.liveCompletion = 0;
  state.usage.liveReasoning = 0;
  const candidates = followUp ? followUpCandidates() : candidateModels();
  const firstCand = candidates[0];
  state.usage.modelId = (firstCand && firstCand.id) || firstCand || '';
  state.usage.rates = ratesForModel(state.usage.modelId);
  paintUsage();
  state.abort = new AbortController();
  const prior = followUp && state.result && state.result.markdown ? state.result.markdown : '';
  reportStream.reset({ seed: prior ? `${prior}\n\n---\n\n` : '' });
  $('think-reel').innerHTML = '';
  setAnalysePhase('thinking');
  if (followUp) $('think-wrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('run-status').textContent = 'Starting…';
  addThinkLine('Contacting OpenRouter…');
  let sawAnswer = false;
  try {
    const res = await runWithFallback({
      candidates,
      provider: activeProvider(),
      baseUrl: baseUrl(),
      apiKey: currentKey(),
      messages: state.messages,
      isOpenRouter: isOpenRouter(),
      dataCollection: state.settings.dataCollection,
      signal: state.abort.signal,
      onModelChange: (model) => {
        state.result.model = model;
        state.usage.modelId = model;
        state.usage.rates = ratesForModel(model) || state.usage.rates;
        paintUsage();
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
        reportStream.pushThink(all);
        state.usage.liveReasoning = estimateTextTokens(all);
        paintUsage();
        if (!sawAnswer) {
          setAnalysePhase('thinking');
          updateThinkReel(all);
        }
      },
      onDelta: (chunk, all) => {
        state.result.markdown = prior ? `${prior}\n\n---\n\n${all}` : all;
        state.usage.liveCompletion = estimateTextTokens(all);
        paintUsage();
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
    state.usage.rates = ratesForModel(res.model) || state.usage.rates;
    if (res.usage) {
      state.usage.prompt += res.usage.prompt || 0;
      state.usage.completion += res.usage.completion || 0;
      state.usage.reasoning += res.usage.reasoning || 0;
    } else {
      state.usage.prompt += state.usage.livePrompt;
      state.usage.completion += state.usage.liveCompletion;
      state.usage.reasoning += state.usage.liveReasoning;
    }
    state.usage.livePrompt = 0;
    state.usage.liveCompletion = 0;
    state.usage.liveReasoning = 0;
    paintUsage();
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

function reportStamp(r) {
  const t = Date.parse(r && (r.updatedAt || r.savedAt || r.createdAt));
  if (Number.isFinite(t)) return t;
  const n = Number(r && r.id);
  return Number.isFinite(n) ? n : 0;
}

function dedupeReports(list) {
  const byId = new Map();
  for (const r of list) {
    if (!r || r.id == null || r.id === '') continue;
    const id = String(r.id);
    const rec = { ...r, id };
    if (!rec.createdAt) rec.createdAt = rec.savedAt || rec.updatedAt;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, rec);
      continue;
    }
    const keep = reportStamp(rec) >= reportStamp(prev) ? rec : prev;
    const drop = keep === rec ? prev : rec;
    keep.createdAt = drop.createdAt || keep.createdAt;
    byId.set(id, keep);
  }
  return [...byId.values()].sort((a, b) => reportStamp(b) - reportStamp(a));
}

function reportsNeedPersist(before, after) {
  if (!Array.isArray(before) || before.length !== after.length) return true;
  const seen = new Set();
  for (const r of before) {
    if (!r || r.id == null || typeof r.id !== 'string') return true;
    const k = String(r.id);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

function persistReports(all) {
  const next = dedupeReports(all).slice(0, 30);
  try { localStorage.setItem(REPORTS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  return next;
}

function saveReportRecord(rec) {
  const id = String(rec.id);
  if (!id || id === 'undefined' || id === 'null') return;
  rec = { ...rec, id };
  const all = loadReports();
  const existing = all.find((r) => String(r.id) === id);
  if (existing) rec.createdAt = existing.createdAt || existing.savedAt || rec.createdAt;
  else if (!rec.createdAt) rec.createdAt = rec.savedAt || rec.updatedAt || new Date().toISOString();
  rec.updatedAt = rec.savedAt || rec.updatedAt || new Date().toISOString();
  persistReports([rec, ...all.filter((r) => String(r.id) !== id)]);
}

function saveCurrentReport() {
  if (!state.result || !state.dataset) return;
  const meta = classMetaFromPupils(state.parsedPupils.length ? state.parsedPupils : state.dataset.pupils);
  if (state.reportId == null || state.reportId === '') state.reportId = `${Date.now()}`;
  state.reportId = String(state.reportId);
  const now = new Date().toISOString();
  saveReportRecord({
    id: state.reportId,
    savedAt: now,
    updatedAt: now,
    subject: $('subject').value,
    yearGroup: $('year-group').value,
    classCode: state.dataset.classCode || meta.classCode || '',
    teacherName: state.dataset.teacherName || meta.teacherName || '',
    model: state.result.model,
    markdown: stripUsageComment(state.result.markdown),
    reasoning: state.result.reasoning,
    messages: state.messages,
    pupilKey: state.dataset.pupils.map((p) => ({ code: p.code, name: p.displayName })),
    codePrefix: state.dataset.codePrefix,
    usage: usageSnapshot(),
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
  const pastedUsage = parseUsageComment(markdown);
  const ctx = promptContextForPaste() || {};
  const stripped = stripUsageComment(markdown);
  const safeMarkdown = state.dataset ? anonymiseText(stripped, state.dataset) : stripped;
  const rec = {
    id: `${Date.now()}`,
    savedAt: new Date().toISOString(),
    subject: ctx.subject || '',
    yearGroup: ctx.yearGroup || '',
    model: 'Pasted',
    markdown: safeMarkdown,
    reasoning: '',
    usage: pastedUsage || undefined,
    messages: [
      ...(ctx.system ? [{ role: 'system', content: ctx.system }] : []),
      ...(ctx.user || ctx.prompt ? [{ role: 'user', content: ctx.user || ctx.prompt }] : []),
      { role: 'assistant', content: safeMarkdown },
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

function loadReports() {
  try {
    const raw = JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]');
    const list = Array.isArray(raw) ? raw : [];
    const next = dedupeReports(list);
    if (reportsNeedPersist(list, next)) persistReports(next);
    return next;
  } catch { return []; }
}

function deleteReport(id) {
  persistReports(loadReports().filter((r) => String(r.id) !== String(id)));
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
      <button type="button" class="report-open" data-id="${escapeHtml(String(r.id))}">
        <strong>${escapeHtml(cls)} · ${escapeHtml(teacher)}</strong>
        <span>${escapeHtml(r.subject || 'Class')} · Year ${escapeHtml(r.yearGroup || '?')}</span>
        <span>${new Date(r.savedAt).toLocaleString('en-GB')} · ${escapeHtml(r.model || '')}</span>
        ${r.usage ? usageBreakdownHtml(r.usage) : ''}
      </button>
      <button type="button" class="report-del" data-id="${escapeHtml(String(r.id))}" aria-label="Hold for 3 seconds to delete">Delete</button>
    </article>`;
  }).join('');
  list.querySelectorAll('.report-open').forEach((b) => b.addEventListener('click', () => openReport(b.dataset.id)));
  list.querySelectorAll('.report-del').forEach((b) => wireHoldDelete(b));
}

async function openReport(id) {
  const rec = loadReports().find((r) => String(r.id) === String(id));
  if (!rec) return;
  state.result = { markdown: rec.markdown, model: rec.model, reasoning: rec.reasoning || '' };
  state.messages = rec.messages || [];
  state.reportId = String(rec.id);
  if (rec.usage) applyUsageSnapshot(rec.usage);
  else {
    resetUsage();
    state.usage.rates = ratesForModel(rec.model);
    paintUsage();
  }
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

function sizeFollowUp() {
  const el = $('followup');
  if (!el) return;
  const minH = 104;
  const maxH = Math.round(Math.min(window.innerHeight * 0.5, 480));
  const padX = 28;
  const padY = 20;
  el.style.overflowY = 'hidden';
  el.style.minHeight = '0px';
  el.style.height = '0px';
  el.style.padding = `0 ${padX}px`;
  const textH = el.scrollHeight;
  const inner = textH + padY * 2;
  const h = Math.min(maxH, Math.max(minH, inner));
  const extra = Math.max(0, h - inner);
  el.style.minHeight = `${minH}px`;
  el.style.paddingTop = `${padY + extra / 2}px`;
  el.style.paddingBottom = `${padY + extra / 2}px`;
  el.style.height = `${h}px`;
  el.style.overflowY = inner > maxH ? 'auto' : 'hidden';
}

function insertAtCursor(text) {
  const el = $('followup');
  const start = el.selectionStart || el.value.length;
  el.value = `${el.value.slice(0, start)}${text}${el.value.slice(el.selectionEnd || start)}`;
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
  sizeFollowUp();
}

async function sendFollowUp() {
  if (!state.dataset || state.abort) return;
  let text = $('followup').value.trim();
  if (!text) return;
  text = anonymiseText(text, state.dataset);
  const g = guardPayload(text, state.dataset);
  if (!g.ok) {
    const hits = g.findings.map((f) => f.match).slice(0, 3).join(', ');
    $('run-status').textContent = `Blocked: That follow-up mentions personal data (${hits}). Use codes like P07.`;
    return;
  }
  const names = possibleNameHits(g);
  if (names.length && state.nameScanConfirmed !== text) {
    state.guard = g;
    state.nameScanPending = { followUp: true, text };
    renderGuard();
    $('run-status').textContent = 'Check the name warning. If it is only a question or author name, click Send anyway.';
    const banner = document.querySelector('#screen-analyse .name-banner');
    if (banner) banner.scrollIntoView({ block: 'nearest' });
    return;
  }
  $('followup').value = '';
  sizeFollowUp();
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
  return `# Class analysis${$('subject').value ? ` – ${$('subject').value}` : ''}\n\n_Generated ${new Date().toLocaleString('en-GB')} by ${state.result.model}. ${withNames ? 'Contains pupil names.' : 'Codes only.'}_\n\n${stripUsageComment(body)}\n\n${usageHiddenComment()}\n`;
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
  state.reportId = null;
  state.nameScanConfirmed = null;
  state.nameScanPending = null;
  state.combineClasses = [];
  state.combineActive = null;
  state.combineQuery = '';
  state.combineBusy = false;
  const search = $('combine-search');
  if (search) search.value = '';
  resetUsage();
  setAnalysePhase('idle');
  reportStream.reset();
  $('report').innerHTML = '';
  $('year-group').value = '';
  $('subject').value = '';
  $('extra-context').value = '';
  state.outgoingTouched = false;
  if ($('prompt-other')) $('prompt-other').value = '';
  document.querySelectorAll('[data-prompt-sec]').forEach((el) => {
    const spec = CORE_SECTIONS.find((s) => s.id === el.dataset.promptSec);
    el.checked = !spec || spec.defaultOn;
  });
  document.querySelectorAll('[data-prompt-extra]').forEach((el) => { el.checked = false; });
  if ($('outgoing-edit')) $('outgoing-edit').value = '';
}

function init() {
  loadSettings();
  wireChrome();
  wireSettings();
  wireUpload();
  wireCombine();
  fillPromptPicker();
  ['subject', 'year-group', 'extra-context'].forEach((id) => $(id).addEventListener('input', refreshPayload));
  $('empty-assessment').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) loadTemplate(f); });
  $('grade-table').closest('details').addEventListener('toggle', () => fillGradeTable());
  $('name-key').closest('details').addEventListener('toggle', () => {
    if (state.dataset) renderKeyTable(state.dataset);
  });
  $('prompt-core').addEventListener('change', () => { state.outgoingTouched = false; refreshPayload(); });
  $('prompt-extra').addEventListener('change', () => { state.outgoingTouched = false; refreshPayload(); });
  $('prompt-other').addEventListener('input', () => { state.outgoingTouched = false; refreshPayload(); });
  $('outgoing-edit').addEventListener('input', () => { state.outgoingTouched = true; refreshPayload(); });
  $('jump-payload').addEventListener('click', () => {
    const ta = $('outgoing-edit');
    const idx = ta.value.indexOf('--- DATA START ---');
    if (idx >= 0) {
      ta.focus();
      ta.setSelectionRange(idx, idx);
      const ratio = idx / Math.max(1, ta.value.length);
      ta.scrollTop = ratio * ta.scrollHeight;
    }
  });
  $('copy-prompt').addEventListener('click', () => copyPromptFile());
  document.querySelectorAll('.js-paste-reply').forEach((btn) => {
    btn.addEventListener('click', () => useClipboardReply());
  });
  $('paste-save').addEventListener('click', () => importPastedReply($('paste-text').value));
  $('go').addEventListener('click', () => runAnalysis());
  document.addEventListener('click', (e) => {
    if (e.target.closest('.name-goback')) nameWarningGoBack();
    if (e.target.closest('.name-anyway')) confirmNameScanAndSend();
  });
  $('stop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  $('provider-select').addEventListener('change', () => {
    state.settings.provider = $('provider-select').value;
    state.settings.model = 'auto';
    saveSettings();
    loadModels();
  });
  $('model-select').addEventListener('change', () => { state.settings.model = $('model-select').value; saveSettings(); updateModelCard(); });
  $('show-names').addEventListener('click', () => applyNameMode(true));
  $('show-codes').addEventListener('click', () => applyNameMode(false));
  $('print-report').addEventListener('click', () => window.print());
  $('copy-report').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportMarkdown(true)); $('run-status').textContent = 'Copied.'; }
    catch { $('run-status').textContent = 'Copy failed.'; }
  });
  $('send-followup').addEventListener('click', sendFollowUp);
  $('followup').addEventListener('input', sizeFollowUp);
  window.addEventListener('resize', sizeFollowUp);
  $('followup').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFollowUp();
    }
  });
  sizeFollowUp();
  setAnalysePhase('idle');
  mountProviderKeyGuide({
    el: $('provider-key-guide'),
    getKeys: () => state.settings.apiKeys,
    onKeyChange: (value, provider) => {
      state.settings.apiKeys[provider] = value;
      if (provider === 'openrouter') state.settings.apiKey = value;
    },
  });
  loadModels();
  paintUsage();
  goInitial();
}

init();
