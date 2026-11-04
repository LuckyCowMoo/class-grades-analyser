// Talks to OpenRouter and other AI providers.
//
//  * fetchModels()                 - lists models (no key needed on OpenRouter)
//  * listModelsForProvider()       - live list (or fallback) for one provider
//  * rankFreeReasoningModels()     - picks the best free reasoning models
//  * runWithFallback()             - streams a chat completion, trying the next
//                                    candidate model when one is rate limited
//                                    or unavailable (common with free models).

import { AI_PROVIDERS, FALLBACK_MODELS } from './ai-providers.js?v=4';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const APP_TITLE = 'Class Grades Analyser';
export const FREE_ROUTER_ID = 'openrouter/free';
export const REPORT_TOKEN_ESTIMATE = 2000;
export const REPORT_REASONING_OUTPUT = 6000;
export const REPORT_INPUT_FALLBACK = 16000;

export async function fetchModels(baseUrl = OPENROUTER_BASE, apiKey = '') {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });
  if (!res.ok) throw new Error(`Could not load the model list (HTTP ${res.status}).`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

const EXCLUDE_RE = /(safety|guard|moderat|lyria|clip|tts|whisper|speech|embed|rerank|ocr|audio|music|image-gen|imagen|diffusion|video-gen|coder?\b|code\b|-code-|legal|medical|roleplay|uncensored|nsfw|router|auto\b)/i;

export function ratesFromPricing(pricing) {
  if (!pricing) return null;
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  const reasoning = pricing.internal_reasoning != null ? Number(pricing.internal_reasoning) : NaN;
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
    reasoning: Number.isFinite(reasoning) ? reasoning : null,
  };
}

export function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.round(s.length / 4));
}

export function looksReasoningModel(id) {
  return /(reason|think|r1\b|qwq|o1|o3|o4|sonnet|pro\b|argon)/i.test(String(id || ''));
}

export function reportUsageEstimate({ inputText = '', reasoning = false } = {}) {
  const fromText = estimateTextTokens(inputText);
  return {
    prompt: fromText > 0 ? fromText : REPORT_INPUT_FALLBACK,
    completion: REPORT_TOKEN_ESTIMATE + (reasoning ? REPORT_REASONING_OUTPUT : 0),
    reasoning: 0,
  };
}

export function reportCostFromRates(rates, tokensOrUsage = REPORT_TOKEN_ESTIMATE) {
  if (!rates) return null;
  const usage = tokensOrUsage && typeof tokensOrUsage === 'object'
    ? {
      prompt: Number(tokensOrUsage.prompt) || 0,
      completion: Number(tokensOrUsage.completion) || 0,
      reasoning: Number(tokensOrUsage.reasoning) || 0,
    }
    : {
      prompt: REPORT_INPUT_FALLBACK,
      completion: Number(tokensOrUsage) || REPORT_TOKEN_ESTIMATE,
      reasoning: 0,
    };
  return usageCost(rates, usage);
}

export function usageSplit(rates, usage) {
  const prompt = Number(usage && usage.prompt) || 0;
  const completion = Number(usage && usage.completion) || 0;
  const reasoning = Number(usage && usage.reasoning) || 0;
  const p = Number(rates && rates.prompt) || 0;
  const c = Number(rates && rates.completion) || 0;
  const r = rates && rates.reasoning != null && Number.isFinite(Number(rates.reasoning))
    ? Number(rates.reasoning)
    : c;
  const sameRate = (a, b) => Math.abs(a - b) <= 1e-18;
  const reasoningOnInput = reasoning > 0 && sameRate(r, p) && !sameRate(p, c);
  const inputTokens = prompt + (reasoningOnInput ? reasoning : 0);
  const outputTokens = completion + (reasoningOnInput ? 0 : reasoning);
  if (!rates) {
    return { inputTokens, outputTokens, inputUsd: null, outputUsd: null, totalUsd: null };
  }
  const inputUsd = prompt * p + (reasoningOnInput ? reasoning * r : 0);
  const outputUsd = completion * c + (reasoningOnInput ? 0 : reasoning * r);
  return { inputTokens, outputTokens, inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

export function usageCost(rates, usage) {
  if (!rates || !usage) return null;
  return usageSplit(rates, usage).totalUsd;
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokenCount ?? 0) || 0;
  let completion = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.candidatesTokenCount ?? 0) || 0;
  const reasoning = Number(
    (raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens)
    ?? raw.reasoning_tokens
    ?? raw.thoughtsTokenCount
    ?? 0,
  ) || 0;
  if (reasoning && completion >= reasoning) completion -= reasoning;
  const total = Number(raw.total_tokens ?? raw.totalTokenCount ?? (prompt + completion + reasoning)) || (prompt + completion + reasoning);
  if (!prompt && !completion && !reasoning && !total) return null;
  return { prompt, completion, reasoning, total };
}

export const USD_TO_GBP = 0.76;

export function formatGbp(usdAmount) {
  if (usdAmount == null || !Number.isFinite(usdAmount)) return '—';
  if (usdAmount <= 0) return 'free';
  const gbp = usdAmount * USD_TO_GBP;
  if (gbp < 0.001) return '< £0.001';
  if (gbp < 0.01) return `£${gbp.toFixed(4)}`;
  if (gbp < 1) return `£${gbp.toFixed(3)}`;
  return `£${gbp.toFixed(2)}`;
}

export function likelyTokensPerSec(id, provider = '') {
  const n = String(id || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (p === 'groq' || n.includes('groq')) return 850;
  if (p === 'fireworks') {
    if (/lite|mini|small|flash|scout/.test(n)) return 220;
    return 150;
  }
  if (p === 'together') {
    if (/lite|mini|small|flash|scout/.test(n)) return 180;
    return 120;
  }
  if (p === 'gemini' || n.includes('gemini') || n.includes('google/')) {
    if (n.includes('flash-lite')) return 380;
    if (n.includes('flash')) return 280;
    if (n.includes('argon')) return 110;
    if (n.includes('pro')) return 120;
    return 180;
  }
  if (p === 'claude' || n.includes('claude') || n.includes('anthropic/')) {
    if (n.includes('haiku')) return 170;
    if (n.includes('opus')) return 55;
    if (n.includes('sonnet')) return 90;
    return 80;
  }
  if (p === 'openai' || n.includes('openai/') || n.startsWith('gpt') || /(^|\/)o[1-9]/.test(n)) {
    if (/nano/.test(n)) return 220;
    if (/mini/.test(n)) return 180;
    if (/pro/.test(n)) return 50;
    if (/gpt-5|o3|o4/.test(n)) return 75;
    return 95;
  }
  if (p === 'xai' || n.includes('grok') || n.includes('x-ai/')) {
    if (/mini|fast|lite/.test(n)) return 190;
    return 95;
  }
  if (p === 'deepseek' || n.includes('deepseek')) {
    if (/reason/.test(n)) return 55;
    return 95;
  }
  if (p === 'mistral' || n.includes('mistral') || n.includes('mixtral') || n.includes('magistral')) {
    if (/small|8b|mini/.test(n)) return 170;
    if (/large|pixtral/.test(n)) return 75;
    return 110;
  }
  if (/llama|scout|maverick|nemotron/.test(n)) return 140;
  return 100;
}

export function isFreeModel(m) {
  const p = m.pricing || {};
  const zero = (v) => v == null || parseFloat(v) === 0;
  return (zero(p.prompt) && zero(p.completion) && zero(p.request) && zero(p.image)) || /:free$/.test(m.id);
}

export function supportsReasoning(m) {
  const sp = m.supported_parameters || [];
  return sp.includes('reasoning') || sp.includes('include_reasoning') || sp.includes('reasoning_effort') || !!m.reasoning;
}

function parseParams(id) {
  // "nvidia/nemotron-3-ultra-550b-a55b:free" -> 550 (total), "qwen3-30b-a3b" -> 30
  const matches = [...String(id).toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => parseFloat(m[1]));
  return matches.length ? Math.max(...matches) : null;
}

const FAMILY_BONUS = [
  [/deepseek/i, 8], [/qwen|qwq/i, 7], [/glm|z-ai/i, 7], [/kimi|moonshot/i, 7], [/gemini|gemma|google/i, 6],
  [/nemotron|nvidia/i, 5], [/llama|meta/i, 5], [/mistral|magistral|devstral/i, 5], [/gpt-oss|openai/i, 7], [/minimax/i, 5],
  [/inkling|thinkingmachines/i, 4], [/grok|xai/i, 6], [/hunyuan|tencent/i, 3], [/step|stepfun/i, 3], [/ernie|baidu/i, 3],
];

export function rankFreeReasoningModels(models, { requireReasoning = true } = {}) {
  const now = Date.now() / 1000;
  const scored = [];
  for (const m of models) {
    if (!m || !m.id) continue;
    if (!isFreeModel(m)) continue;
    if (m.id === FREE_ROUTER_ID) continue;
    const arch = m.architecture || {};
    const inMods = arch.input_modalities || []; const outMods = arch.output_modalities || [];
    if (inMods.length && !inMods.includes('text')) continue;
    if (outMods.length && !outMods.includes('text')) continue;
    if (arch.modality && !/->\s*text/.test(arch.modality)) continue;
    if (EXCLUDE_RE.test(`${m.id} ${m.name || ''}`)) continue;
    const reasoning = supportsReasoning(m);
    if (requireReasoning && !reasoning) continue;
    const ctx = m.context_length || (m.top_provider && m.top_provider.context_length) || 0;
    if (ctx && ctx < 16000) continue;
    let score = 0;
    if (reasoning) score += 100;
    if (ctx >= 32000) score += 10;
    if (ctx >= 128000) score += 5;
    const params = parseParams(m.id);
    if (params) score += Math.log(params) * 8;
    else score += 20; // unknown size: assume a mid-sized model
    if (/(nano|tiny|mini|lightning|small|lite|micro)/i.test(m.id)) score -= 10;
    if (/(preview|exp|experimental|beta|alpha)/i.test(m.id)) score -= 3;
    for (const [re, bonus] of FAMILY_BONUS) if (re.test(m.id)) { score += bonus; break; }
    if (m.created) {
      const ageDays = Math.max(0, (now - m.created) / 86400);
      score -= Math.min(20, ageDays / 30);
    }
    const maxOut = m.top_provider && m.top_provider.max_completion_tokens;
    if (maxOut && maxOut < 4000) score -= 15;
    scored.push({
      id: m.id, name: m.name || m.id, context: ctx, created: m.created || null, reasoning, params,
      score: Math.round(score * 10) / 10, maxCompletionTokens: maxOut || null,
      supportedEfforts: (m.reasoning && m.reasoning.supported_efforts) || null,
      mandatoryReasoning: !!(m.reasoning && m.reasoning.mandatory),
      rates: ratesFromPricing(m.pricing),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function isTextChatId(id) {
  const n = String(id || '').toLowerCase();
  if (!n) return false;
  if (EXCLUDE_RE.test(n)) return false;
  return !/(embedding|dall-e|whisper|tts-|realtime|moderation|transcribe|imagen|veo\b|speech|audio|banana|-image\b|image-gen|native-audio)/i.test(n);
}

const GEMINI_NOT_TEXT_RE = /(banana|imagen|-image(?:-|$)|image-gen|veo\b|omni|video|tts|asr|audio|speech|native-audio|\blive\b|transcribe|embed|aqa|robotics|computer-use|lyria|music)/i;

function geminiVersion(id) {
  const m = String(id || '').toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}

function geminiRole(id) {
  const n = String(id || '').toLowerCase();
  if (n.includes('flash-lite')) return 'flash-lite';
  if (n.includes('flash')) return 'flash';
  if (n.includes('pro')) return 'pro';
  const named = n.match(/^gemini-\d+(?:\.\d+)?-([a-z][a-z0-9-]*?)(?:-preview|-exp)?$/);
  if (named && named[1] && !/^(preview|exp)$/.test(named[1])) return named[1];
  return 'other';
}

function cmpGeminiVersion(a, b) {
  return (a[0] - b[0]) || (a[1] - b[1]);
}

function isGeminiSnapshotId(id) {
  const n = String(id || '').toLowerCase();
  if (n.endsWith('-latest')) return true;
  if (/-\d{3}$/.test(n)) return true;
  if (/-(?:preview|exp)-\d/.test(n)) return true;
  if (/-\d{2}-\d{4}$/.test(n) || /-\d{2}-\d{2}(?:-\d{4})?$/.test(n)) return true;
  return false;
}

function isGeminiTextChatId(id, displayName = '') {
  const n = String(id || '').toLowerCase().replace(/^models\//, '');
  const hay = `${n} ${String(displayName || '').toLowerCase()}`;
  if (!n.startsWith('gemini-')) return false;
  if (!geminiVersion(n)) return false;
  if (isGeminiSnapshotId(n)) return false;
  if (GEMINI_NOT_TEXT_RE.test(hay)) return false;
  if (!isTextChatId(n)) return false;
  return true;
}

function preferGemini(a, b) {
  const va = geminiVersion(a.id);
  const vb = geminiVersion(b.id);
  const cmp = cmpGeminiVersion(va, vb);
  if (cmp) return cmp > 0;
  const pa = /preview|exp/.test(a.id);
  const pb = /preview|exp/.test(b.id);
  if (pa !== pb) return !pa;
  return a.id.length <= b.id.length;
}

function pickCurrentGeminiTextModels(rawList) {
  const candidates = [];
  for (const m of rawList || []) {
    if (typeof m.outputTokenLimit === 'number' && m.outputTokenLimit <= 0) continue;
    const id = String(m.name || m.id || '').replace(/^models\//, '');
    const name = m.displayName || id;
    if (!isGeminiTextChatId(id, name)) continue;
    candidates.push(asNamed(id, name));
  }
  let maxMajor = 0;
  for (const m of candidates) {
    const ver = geminiVersion(m.id);
    if (ver && ver[0] > maxMajor) maxMajor = ver[0];
  }
  const current = maxMajor
    ? candidates.filter((m) => (geminiVersion(m.id) || [0])[0] >= maxMajor - 1)
    : candidates;
  const byRole = new Map();
  for (const m of current) {
    const role = geminiRole(m.id);
    const prev = byRole.get(role);
    if (!prev || preferGemini(m, prev)) byRole.set(role, m);
  }
  return [...byRole.values()];
}

function asNamed(id, name) {
  return { id, name: name || id };
}

async function listClaudeModels(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!res.ok) throw new Error(`Claude models list failed (${res.status})`);
  const json = await res.json();
  return (json.data || [])
    .filter((m) => m && m.id && isTextChatId(m.id))
    .map((m) => {
      const named = asNamed(m.id, m.display_name);
      const created = unixSeconds(m.created_at);
      return created ? { ...named, created } : named;
    });
}

async function listGeminiModels(apiKey) {
  const all = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ pageSize: '100', key: apiKey });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params}`);
    if (!res.ok) throw new Error(`Gemini models list failed (${res.status})`);
    const json = await res.json();
    all.push(...(json.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return pickCurrentGeminiTextModels(all);
}

function providerModelScore(m) {
  const id = String(m.id || '');
  let score = looksReasoningModel(id) ? 20 : 0;
  const ver = geminiVersion(id);
  if (ver) {
    score += ver[0] * 1000 + ver[1] * 10;
    const role = geminiRole(id);
    if (role === 'argon') score += 80;
    else if (role === 'pro') score += 50;
    else if (role === 'flash') score += 20;
    else if (role === 'flash-lite') score += 10;
    else score += 30;
  }
  if (/preview|exp|experimental|beta|alpha/i.test(id)) score -= 40;
  return score;
}

export function rankProviderModels(list) {
  const scored = list.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    reasoning: looksReasoningModel(m.id),
    created: m.created || null,
    rates: m.rates || null,
    score: providerModelScore(m),
  }));
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

export async function listModelsForProvider(provider, apiKey) {
  const id = provider || 'openrouter';
  const key = String(apiKey || '').trim();
  const fallback = (FALLBACK_MODELS[id] || []).map((m) => asNamed(m.id, m.name));
  if (id === 'openrouter') {
    const models = await fetchModels(OPENROUTER_BASE, key);
    const ranked = rankFreeReasoningModels(models, { requireReasoning: true });
    const rankedAll = rankFreeReasoningModels(models, { requireReasoning: false });
    return { models, ranked, rankedAll, live: true };
  }
  const info = AI_PROVIDERS[id];
  try {
    let live = [];
    if (info && info.auth === 'anthropic') live = await listClaudeModels(key);
    else if (info && info.auth === 'gemini') live = await listGeminiModels(key);
    else {
      const base = (info && info.openaiBaseUrl) || OPENROUTER_BASE;
      const raw = await fetchModels(base, key);
      live = raw.filter((m) => m && m.id && isTextChatId(m.id)).map((m) => {
        const named = asNamed(m.id, m.name);
        const created = unixSeconds(m.created);
        return created ? { ...named, created } : named;
      });
    }
    const source = (id === 'gemini' && live.length) ? live : [...live, ...fallback];
    const merged = [];
    const seen = new Set();
    for (const m of source) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    let catalog = [];
    try { catalog = await openRouterCatalog(); } catch { catalog = []; }
    const withMeta = withOpenRouterMeta(merged, catalog, id);
    const ranked = rankProviderModels(withMeta);
    return { models: withMeta, ranked, rankedAll: ranked, live: true };
  } catch (err) {
    let catalog = [];
    try { catalog = await openRouterCatalog(); } catch { catalog = []; }
    const withMeta = withOpenRouterMeta(fallback, catalog, id);
    const ranked = rankProviderModels(withMeta);
    return { models: withMeta, ranked, rankedAll: ranked, live: false, error: err.message };
  }
}

const OR_ORG = {
  gemini: 'google',
  claude: 'anthropic',
  openai: 'openai',
  xai: 'x-ai',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistralai',
  together: 'together',
  fireworks: 'fireworks',
  openrouter: '',
};

function unixSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.round(value / 1000) : value;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : Math.round(n / 1000);
}

function bareModelId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/^~/, '')
    .replace(/^models\//, '')
    .replace(/:free$/g, '')
    .replace(/:batch$/g, '')
    .replace(/:online$/g, '')
    .replace(/_/g, '-');
}

function modelTail(id) {
  const n = bareModelId(id);
  const slash = n.lastIndexOf('/');
  return slash >= 0 ? n.slice(slash + 1) : n;
}

function dottedVersionTail(tail) {
  return String(tail || '').replace(/-\d{8}$/, '').replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2');
}

function openRouterIdVariants(nativeId, provider) {
  const bare = bareModelId(nativeId);
  const tail = modelTail(bare).replace(/-\d{8}$/, '');
  const dotted = dottedVersionTail(tail);
  const org = OR_ORG[provider] || '';
  const out = new Set();
  const add = (s) => { if (s) out.add(bareModelId(s)); };
  add(bare);
  add(tail);
  add(dotted);
  if (org) {
    add(`${org}/${tail}`);
    add(`${org}/${dotted}`);
  }
  return [...out];
}

function matchOpenRouterModel(catalog, nativeId, provider) {
  const wants = new Set(openRouterIdVariants(nativeId, provider));
  const org = OR_ORG[provider] || '';
  let best = null;
  let bestScore = 0;
  for (const m of catalog || []) {
    if (!m || !m.id) continue;
    const nid = bareModelId(m.id);
    if (String(m.id).startsWith('~') || nid.includes(':batch')) continue;
    const canon = bareModelId(m.canonical_slug || '');
    const tail = modelTail(nid);
    let score = 0;
    if (wants.has(nid) || (canon && wants.has(canon))) score = 100;
    else if (wants.has(tail) || wants.has(dottedVersionTail(tail))) {
      score = org && nid.startsWith(`${org}/`) ? 90 : 70;
    }
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= 70 ? best : null;
}

function aaIntelligence(model) {
  const aa = model && model.benchmarks && model.benchmarks.artificial_analysis;
  return aa && typeof aa.intelligence_index === 'number' ? aa.intelligence_index : null;
}

function endpointThroughput(end) {
  const t = end && end.throughput_last_30m;
  if (typeof t === 'number') return t;
  if (t && typeof t.p50 === 'number') return t.p50;
  return null;
}

function endpointsPath(id) {
  const cleaned = String(id || '').replace(/:free$/, '');
  const slash = cleaned.indexOf('/');
  if (slash < 0) return encodeURIComponent(cleaned);
  return `${encodeURIComponent(cleaned.slice(0, slash))}/${encodeURIComponent(cleaned.slice(slash + 1))}`;
}

let orCatalogCache = null;
let orCatalogAt = 0;

async function openRouterCatalog() {
  const now = Date.now();
  if (orCatalogCache && now - orCatalogAt < 10 * 60 * 1000) return orCatalogCache;
  try {
    orCatalogCache = await fetchModels(OPENROUTER_BASE, '');
    orCatalogAt = now;
  } catch {
    orCatalogCache = orCatalogCache || [];
  }
  return orCatalogCache;
}

function withOpenRouterMeta(list, catalog, provider) {
  return (list || []).map((m) => {
    const hit = matchOpenRouterModel(catalog, m.id, provider);
    if (!hit) return m;
    return {
      ...m,
      created: m.created || hit.created || null,
      name: m.name || hit.name,
      rates: m.rates || ratesFromPricing(hit.pricing),
    };
  });
}

let benchCache = null;

async function fetchBenchmarks(headers) {
  if (benchCache) return benchCache;
  const res = await fetch(`${OPENROUTER_BASE}/benchmarks?source=artificial-analysis&max_results=200`, { headers });
  if (!res.ok) return [];
  const json = await res.json();
  benchCache = json.data || [];
  return benchCache;
}

function looksOpenRouterKey(key) {
  return /^sk-or-/.test(String(key || '').trim());
}

export async function fetchModelCard(modelId, apiKey = '', provider = 'openrouter') {
  const id = String(modelId || '');
  if (!id || id === 'auto' || id === FREE_ROUTER_ID) {
    return { id, name: id === FREE_ROUTER_ID ? 'OpenRouter free router' : 'Automatic pick', note: 'The live model is chosen when you press Go.' };
  }
  const card = {
    id, name: id, context: null, reasoning: null,
    tokensPerSec: likelyTokensPerSec(id, provider), wordsPerSec: null, created: null, intelligence: null, intelligenceTop: null,
    coding: null, params: parseParams(id),
  };
  card.wordsPerSec = Math.round(card.tokensPerSec * 0.75);
  const catalog = await openRouterCatalog();
  const orModel = matchOpenRouterModel(catalog, id, provider) || (provider === 'openrouter' ? catalog.find((m) => m.id === id) : null);
  const orId = orModel ? orModel.id : (id.includes('/') ? id : null);
  const aaScores = catalog.map(aaIntelligence).filter((n) => n != null);
  if (aaScores.length) card.intelligenceTop = Math.max(...aaScores);
  if (orModel) {
    card.name = orModel.name || card.name;
    if (orModel.created) card.created = orModel.created;
    const aa = orModel.benchmarks && orModel.benchmarks.artificial_analysis;
    if (aa) {
      if (typeof aa.intelligence_index === 'number') card.intelligence = aa.intelligence_index;
      if (typeof aa.coding_index === 'number') card.coding = aa.coding_index;
      if (typeof aa.agentic_index === 'number') card.agentic = aa.agentic_index;
    }
  }
  const headers = { Accept: 'application/json' };
  if (looksOpenRouterKey(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  if (orId) {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/models/${endpointsPath(orId)}/endpoints`, { headers });
      if (res.ok) {
        const json = await res.json();
        const data = json.data || json;
        card.name = data.name || card.name;
        if (data.created) card.created = data.created;
      }
    } catch { /* optional */ }
  }
  if (looksOpenRouterKey(apiKey)) {
    try {
      const rows = await fetchBenchmarks(headers);
      const scores = rows.map((r) => r.intelligence_index).filter((n) => typeof n === 'number');
      if (scores.length) card.intelligenceTop = Math.max(...scores);
      if (card.intelligence == null && orId) {
        const variants = new Set(openRouterIdVariants(orId, 'openrouter').concat(openRouterIdVariants(id, provider)));
        const hit = rows.find((r) => r.model_permaslug && variants.has(bareModelId(r.model_permaslug)));
        if (hit) {
          card.intelligence = hit.intelligence_index;
          card.coding = hit.coding_index;
          card.agentic = hit.agentic_index;
        }
      }
    } catch { /* optional */ }
  }
  return card;
}

// ---------------------------------------------------------------------------
// Streaming chat completion
// ---------------------------------------------------------------------------

export class AiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, body = null } = {}) {
    super(message);
    this.status = status; this.code = code; this.retryable = retryable; this.body = body;
  }
}

const QUOTA_RE = /insufficient credits|add \d+ credits|purchase credits|payment required|free-models-per-day|free models per day|daily (request )?limit|quota exceeded|usage limit|reached its limit|out of credits|credit balance|requires more credits/i;

function errorBodyMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const err = body.error;
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.message) parts.push(err.message);
  const reasons = err.metadata && err.metadata.ineligibility_reasons;
  if (Array.isArray(reasons)) {
    for (const r of reasons) {
      if (!r) continue;
      const bit = [r.reason, r.configure_url].filter(Boolean).join(' ');
      if (bit) parts.push(bit);
    }
  }
  if (err.metadata && err.metadata.raw) parts.push(String(err.metadata.raw).slice(0, 220));
  return parts.join(' ') || (err.metadata && err.metadata.message) || '';
}

function privacyConfigureUrl(body, msg) {
  const reasons = body && body.error && body.error.metadata && body.error.metadata.ineligibility_reasons;
  if (Array.isArray(reasons)) {
    const hit = reasons.find((r) => r && r.configure_url);
    if (hit) return hit.configure_url;
  }
  const m = String(msg || '').match(/https:\/\/openrouter\.ai\/[^\s)]+/);
  return m ? m[0] : 'https://openrouter.ai/settings/privacy';
}

function isAccountPrivacyMessage(msg) {
  return /free model training|free-model-training|free model publication|free-model-publication|guardrail restrictions|free-model-training-violation|free-model-publication-violation/i.test(String(msg || ''));
}

function isQuotaMessage(status, msg) {
  if (status === 402) return true;
  return QUOTA_RE.test(String(msg || ''));
}

export function explainAiError(err) {
  const raw = err && err.message ? String(err.message) : String(err || 'Unknown error');
  const extra = Array.isArray(err && err.errors)
    ? err.errors.map((e) => `${e.model || 'model'}: ${e.message || ''}`).join('\n')
    : '';
  const blob = `${raw}\n${extra}`;
  if ((err && err.code === 'quota') || isQuotaMessage(err && err.status, blob)) {
    return {
      headline: 'The free OpenRouter allowance on this key has been used up.',
      body: 'Free models have a daily limit. Wait until it resets (usually the next day), or add a small amount of credit at openrouter.ai — that also raises the free daily limit. Pupil names were not included in the request.',
      detail: blob.trim(),
    };
  }
  if ((err && err.code === 'account_privacy') || isAccountPrivacyMessage(blob)) {
    const href = err && err.configureUrl ? err.configureUrl : 'https://openrouter.ai/settings/privacy';
    return {
      headline: 'OpenRouter is blocking free models on this account.',
      body: 'Free models usually need “Free model training” switched on. The table we send is pupil codes, not names. Allow free endpoints that train on requests, then press Go again.',
      link: { href, label: 'Open OpenRouter privacy settings' },
      detail: blob.trim(),
    };
  }
  if (err && err.status === 401) {
    return {
      headline: 'The API key was rejected.',
      body: 'Open the API key page, slide to that provider, and paste the key again.',
      detail: raw,
    };
  }
  return {
    headline: 'The analysis could not be completed.',
    body: 'The model did not return a report. The note below is what the provider sent back.',
    detail: blob.trim() || raw,
  };
}

function describeHttpError(status, body) {
  const msg = errorBodyMessage(body);
  const m = String(msg).slice(0, 400);
  if (status === 401) return new AiError(`The API key was rejected (401). Check that it was copied correctly. ${m}`.trim(), { status, retryable: false });
  if (isQuotaMessage(status, m)) {
    return new AiError(`The free OpenRouter allowance on this API key has been used up. ${m}`.trim(), { status, code: 'quota', retryable: false });
  }
  if (status === 403) return new AiError(`Request forbidden (403). ${m}`.trim(), { status, retryable: true });
  if (status === 404) {
    if (isAccountPrivacyMessage(m)) {
      const blocked = new AiError(`OpenRouter is blocking this free model because of the account privacy setting (Free model training). ${m}`.trim(), { status, code: 'account_privacy', retryable: true });
      blocked.configureUrl = privacyConfigureUrl(body, m);
      return blocked;
    }
    if (/data policy|no endpoints/i.test(m)) return new AiError(`No provider for this model satisfies the privacy setting ("do not use providers that store prompts"). ${m}`.trim(), { status, code: 'data_policy', retryable: true });
    return new AiError(`Model not found or unavailable (404). ${m}`.trim(), { status, retryable: true });
  }
  if (status === 408 || status === 429) return new AiError(`The model is rate limited or busy (${status}). ${m}`.trim(), { status, retryable: true });
  if (status === 400 || status === 422) return new AiError(`The provider rejected the request (${status}). ${m}`.trim(), { status, code: 'bad_request', retryable: true });
  if (status >= 500) return new AiError(`The provider had an internal error (${status}). ${m}`.trim(), { status, retryable: true });
  return new AiError(`Request failed (HTTP ${status}). ${m}`.trim(), { status, retryable: true });
}

function splitSystem(messages) {
  const system = (messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = (messages || []).filter((m) => m.role !== 'system');
  return { system, rest };
}

async function streamClaude({ apiKey, model, messages, maxTokens, signal, onDelta, onReasoning, onStatus }) {
  const { system, rest } = splitSystem(messages);
  onStatus && onStatus(`Contacting ${model}…`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 16000,
      stream: true,
      temperature: 0.3,
      system: system || undefined,
      messages: rest.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
    signal,
  });
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { /* ignore */ }
    throw describeHttpError(res.status, parsed);
  }
  return readAnthropicStream(res, model, onDelta, onReasoning, onStatus);
}

async function readAnthropicStream(res, model, onDelta, onReasoning, onStatus) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let finishReason = null;
  let gotAnyChunk = false;
  let usage = null;
  onStatus && onStatus(`Connected to ${model}.`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      let json;
      try { json = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (json.type === 'message_start' && json.message && json.message.usage) {
        usage = normalizeUsage(json.message.usage) || usage;
      }
      if (json.type === 'message_delta' && json.usage) {
        const next = normalizeUsage(json.usage);
        if (next) {
          usage = {
            prompt: (usage && usage.prompt) || next.prompt,
            completion: next.completion,
            reasoning: next.reasoning,
            total: next.total,
          };
        }
      }
      const delta = json.delta || {};
      if (delta.thinking) {
        reasoningText += delta.thinking;
        onReasoning && onReasoning(delta.thinking, reasoningText);
      }
      if (delta.text) {
        gotAnyChunk = true;
        content += delta.text;
        onDelta && onDelta(delta.text, content);
      }
      if (json.type === 'message_stop' || delta.stop_reason) finishReason = delta.stop_reason || 'end_turn';
    }
  }
  if (!content.trim()) throw new AiError('The model returned an empty response.', { retryable: true });
  return { content, reasoning: reasoningText, finishReason, usage };
}

async function streamGemini({ apiKey, model, messages, maxTokens, signal, onDelta, onReasoning, onStatus }) {
  const { system, rest } = splitSystem(messages);
  const id = String(model || '').replace(/^models\//, '');
  onStatus && onStatus(`Contacting ${model}…`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: rest.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens || 8192 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { /* ignore */ }
    throw describeHttpError(res.status, parsed);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let usage = null;
  onStatus && onStatus(`Connected to ${model}.`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      let json;
      try { json = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (json.usageMetadata) usage = normalizeUsage(json.usageMetadata) || usage;
      const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
      for (const part of parts) {
        if (!part || !part.text) continue;
        if (part.thought) {
          reasoningText += part.text;
          onReasoning && onReasoning(part.text, reasoningText);
        } else {
          content += part.text;
          onDelta && onDelta(part.text, content);
        }
      }
    }
  }
  if (!content.trim()) throw new AiError('The model returned an empty response.', { retryable: true });
  return { content, reasoning: reasoningText, finishReason: 'stop', usage };
}

export async function streamChat({ provider = 'openrouter', baseUrl, apiKey, model, messages, reasoning = true, dataCollection = 'deny', storingFallback = false, isOpenRouter = true, maxTokens = null, signal, onDelta, onReasoning, onStatus }) {
  const id = provider || (isOpenRouter ? 'openrouter' : 'openai');
  const info = AI_PROVIDERS[id] || AI_PROVIDERS.openrouter;
  if (info.auth === 'anthropic') {
    return streamClaude({ apiKey, model, messages, maxTokens, signal, onDelta, onReasoning, onStatus });
  }
  if (info.auth === 'gemini') {
    return streamGemini({ apiKey, model, messages, maxTokens, signal, onDelta, onReasoning, onStatus });
  }
  const or = id === 'openrouter';
  const root = (info.openaiBaseUrl || baseUrl || OPENROUTER_BASE);
  const body = { model, messages, stream: true, temperature: 0.3, stream_options: { include_usage: true } };
  if (maxTokens) body.max_tokens = maxTokens;
  if (or) {
    if (reasoning) body.reasoning = { effort: 'medium' };
    body.provider = { data_collection: dataCollection, allow_fallbacks: true };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (or && typeof location !== 'undefined') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = APP_TITLE;
  }
  onStatus && onStatus(storingFallback
    ? `Contacting ${model}. The table is anonymised codes only.`
    : `Contacting ${model}…`);
  let res = await fetch(`${root.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok && res.status === 400 && body.stream_options) {
    try { await res.text(); } catch { /* ignore */ }
    delete body.stream_options;
    res = await fetch(`${root.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
  if (!res.ok) {
    let parsed = null; let text = '';
    try { text = await res.text(); parsed = JSON.parse(text); } catch { parsed = text; }
    throw describeHttpError(res.status, parsed);
  }
  const ctype = res.headers.get('content-type') || '';
  if (!/text\/event-stream/.test(ctype)) {
    const json = await res.json();
    if (json.error) throw describeHttpError(json.error.code || 500, json);
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    const content = (msg && msg.content) || '';
    if (onDelta && content) onDelta(content);
    return {
      content,
      reasoning: (msg && (msg.reasoning || msg.reasoning_content)) || '',
      finishReason: json.choices && json.choices[0] && json.choices[0].finish_reason,
      usage: normalizeUsage(json.usage),
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let finishReason = null;
  let gotAnyChunk = false;
  let usage = null;
  onStatus && onStatus(`Connected to ${model}.`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { buffer = ''; break; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) {
        const code = json.error.code || 500;
        throw describeHttpError(typeof code === 'number' ? code : 500, json);
      }
      if (json.usage) usage = normalizeUsage(json.usage) || usage;
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      gotAnyChunk = true;
      const delta = choice.delta || {};
      const r = delta.reasoning || delta.reasoning_content;
      if (r) { reasoningText += r; onReasoning && onReasoning(r, reasoningText); }
      if (delta.content) { content += delta.content; onDelta && onDelta(delta.content, content); }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  if (!gotAnyChunk && !content) throw new AiError('The model returned an empty response.', { retryable: true });
  if (!content.trim()) {
    if (finishReason === 'length') throw new AiError('The model spent its whole output budget on reasoning and returned no answer.', { retryable: true, code: 'length' });
    throw new AiError('The model returned an empty response.', { retryable: true });
  }
  return { content, reasoning: reasoningText, finishReason, usage };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError(signal)); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function isTransient(err) {
  return err instanceof AiError && (err.status === 408 || err.status === 429 || err.status === 503 || err.status >= 500);
}

function recordError(errors, model, err) {
  errors.push({
    model,
    message: err && err.message ? err.message : String(err),
    status: err && err.status,
    dataPolicy: !!(err && err.code === 'data_policy'),
    accountPrivacy: !!(err && err.code === 'account_privacy'),
    quota: !!(err && err.code === 'quota') || isQuotaMessage(err && err.status, err && err.message),
    configureUrl: err && err.configureUrl,
  });
}

// One model: reasoning on, one short wait if the provider is busy, then reasoning off
// if the request itself was rejected.
async function runModelAttempts({ model, policy, storingFallback = false, maxTokens, provider, baseUrl, apiKey, messages, isOpenRouter, signal, onDelta, onReasoning, onStatus, errors }) {
  const plans = [
    { reasoning: true, maxTokens },
    { reasoning: false, maxTokens: null },
  ];
  let waited = false;
  for (let a = 0; a < plans.length; a++) {
    const opt = plans[a];
    try {
      return await streamChat({
        provider, baseUrl, apiKey, model, messages, isOpenRouter, signal, onDelta, onReasoning, onStatus,
        dataCollection: policy, storingFallback, reasoning: opt.reasoning, maxTokens: opt.maxTokens,
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      recordError(errors, model, err);
      if (err instanceof AiError && (err.code === 'data_policy' || err.code === 'account_privacy')) {
        throw err;
      }
      onStatus && onStatus(`${model}: ${err.message}`);
      if (!(err instanceof AiError) || !err.retryable) throw err;
      if (!waited && isTransient(err)) {
        waited = true;
        onStatus && onStatus(`${model} is busy. Waiting a few seconds, then trying again…`);
        await sleep(2500, signal);
        a -= 1;
        continue;
      }
      if (!(err.code === 'bad_request' || err.code === 'length') || a === plans.length - 1) throw err;
      onStatus && onStatus(`Retrying ${model} with default settings…`);
    }
  }
  throw new AiError(`${model} failed.`, { retryable: true });
}

// Tries each candidate model in turn until one succeeds.
// "deny" tries a provider that does not store prompts, then the same anonymised
// table with a provider that may store it. "deny-strict" never takes that second step.
export async function runWithFallback({ candidates, provider = 'openrouter', baseUrl, apiKey, messages, isOpenRouter, dataCollection, signal, onDelta, onReasoning, onStatus, onModelChange }) {
  const errors = [];
  const or = (provider || 'openrouter') === 'openrouter' && (isOpenRouter !== false);
  const strict = dataCollection === 'deny-strict';
  const startPolicy = dataCollection === 'allow' ? 'allow' : 'deny';
  let accountPrivacyHits = 0;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const model = typeof cand === 'string' ? cand : cand.id;
    const maxTokens = cand && cand.maxCompletionTokens ? Math.min(cand.maxCompletionTokens, 32000) : null;
    onModelChange && onModelChange(model, i, candidates.length);
    const policies = [startPolicy];
    if (or && startPolicy === 'deny' && !strict) policies.push('allow');
    for (const policy of policies) {
      if (policy === 'allow' && startPolicy === 'deny') {
        onStatus && onStatus(`Trying another copy of ${model}…`);
      }
      try {
        const result = await runModelAttempts({
          model, policy, storingFallback: policy === 'allow' && startPolicy === 'deny', maxTokens, provider, baseUrl, apiKey, messages, isOpenRouter: or, signal, onDelta, onReasoning, onStatus, errors,
        });
        return { ...result, model, errors, usedStoringProvider: policy === 'allow' && startPolicy !== 'allow' };
      } catch (err) {
        if (signal && signal.aborted) throw err;
        if (err instanceof AiError && (err.code === 'quota' || !err.retryable)) throw err;
        if (err instanceof AiError && (err.code === 'data_policy' || err.code === 'account_privacy') && policy === 'deny' && policies.includes('allow')) continue;
        if (err instanceof AiError && err.code === 'account_privacy') {
          accountPrivacyHits += 1;
          if (accountPrivacyHits >= 2) throw err;
        }
        break;
      }
    }
  }
  const allDataPolicy = errors.length && errors.every((e) => e.dataPolicy);
  const anyQuota = errors.some((e) => e.quota);
  const anyPrivacy = errors.some((e) => e.accountPrivacy);
  const summary = errors.map((e) => `• ${e.model}: ${e.message}`).join('\n');
  const headline = anyQuota
    ? 'The free OpenRouter allowance on this key has been used up.'
    : anyPrivacy
      ? 'OpenRouter is blocking free models on this account.'
      : allDataPolicy
        ? 'No free model could be used with the current privacy setting.'
        : 'All candidate models failed.';
  const err = new AiError(`${headline}\n${summary}`, {
    retryable: false,
    code: anyQuota ? 'quota' : anyPrivacy ? 'account_privacy' : allDataPolicy ? 'data_policy' : 'exhausted',
  });
  err.errors = errors;
  err.triedAllow = isOpenRouter && startPolicy === 'deny' && !strict;
  const privacyHit = errors.find((e) => e.configureUrl);
  if (privacyHit) err.configureUrl = privacyHit.configureUrl;
  throw err;
}
