// Talks to OpenRouter (or any OpenAI-compatible endpoint).
//
//  * fetchModels()                 - lists models (no key needed on OpenRouter)
//  * rankFreeReasoningModels()     - picks the best free reasoning models
//  * runWithFallback()             - streams a chat completion, trying the next
//                                    candidate model when one is rate limited
//                                    or unavailable (common with free models).

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const APP_TITLE = 'Class Grades Analyser';
export const FREE_ROUTER_ID = 'openrouter/free';

export async function fetchModels(baseUrl = OPENROUTER_BASE, apiKey = '') {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });
  if (!res.ok) throw new Error(`Could not load the model list (HTTP ${res.status}).`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

const EXCLUDE_RE = /(safety|guard|moderat|lyria|clip|tts|whisper|speech|embed|rerank|ocr|audio|music|image-gen|imagen|diffusion|video-gen|coder?\b|code\b|-code-|legal|medical|roleplay|uncensored|nsfw|router|auto\b)/i;

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
    scored.push({ id: m.id, name: m.name || m.id, context: ctx, created: m.created || null, reasoning, params, score: Math.round(score * 10) / 10, maxCompletionTokens: maxOut || null, supportedEfforts: (m.reasoning && m.reasoning.supported_efforts) || null, mandatoryReasoning: !!(m.reasoning && m.reasoning.mandatory) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function slugVariants(id) {
  const raw = String(id || '');
  const noFree = raw.replace(/:free$/, '');
  return [...new Set([raw, noFree, noFree.replace(/-it$/, ''), noFree.replace(/-instruct$/, '')])];
}

function endpointsPath(id) {
  const cleaned = String(id || '').replace(/:free$/, '');
  const slash = cleaned.indexOf('/');
  if (slash < 0) return encodeURIComponent(cleaned);
  return `${encodeURIComponent(cleaned.slice(0, slash))}/${encodeURIComponent(cleaned.slice(slash + 1))}`;
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

export async function fetchModelCard(modelId, apiKey = '') {
  const id = String(modelId || '');
  if (!id || id === 'auto' || id === FREE_ROUTER_ID) {
    return { id, name: id === FREE_ROUTER_ID ? 'OpenRouter free router' : 'Automatic pick', note: 'The live model is chosen when you press Go.' };
  }
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const card = {
    id, name: id, context: null, reasoning: null,
    tokensPerSec: null, wordsPerSec: null, created: null, intelligence: null, intelligenceTop: null,
    coding: null, params: parseParams(id),
  };
  try {
    const res = await fetch(`${OPENROUTER_BASE}/models/${endpointsPath(id)}/endpoints`, { headers });
    if (res.ok) {
      const json = await res.json();
      const data = json.data || json;
      card.name = data.name || card.name;
      const ends = data.endpoints || [];
      const throughputs = ends.map((e) => e.throughput_last_30m && e.throughput_last_30m.p50).filter((n) => typeof n === 'number');
      if (throughputs.length) {
        const tps = Math.max(...throughputs);
        card.tokensPerSec = Math.round(tps * 10) / 10;
        card.wordsPerSec = Math.round(tps * 0.75);
      }
      if (data.created) card.created = data.created;
    }
  } catch { /* optional */ }
  try {
    const rows = await fetchBenchmarks(headers);
    const scores = rows.map((r) => r.intelligence_index).filter((n) => typeof n === 'number');
    if (scores.length) card.intelligenceTop = Math.max(...scores);
    const variants = slugVariants(id);
    const hit = rows.find((r) => variants.some((v) => r.model_permaslug === v || (r.model_permaslug && v.includes(r.model_permaslug)) || (r.display_name && id.toLowerCase().includes(String(r.display_name).toLowerCase().split(' ')[0]))));
    if (hit) {
      card.intelligence = hit.intelligence_index;
      card.coding = hit.coding_index;
      card.agentic = hit.agentic_index;
    }
  } catch { /* optional */ }
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
      headline: 'OpenRouter rejected the API key.',
      body: 'Open the API key page, paste the key again, and check it still starts with sk-or-.',
      detail: raw,
    };
  }
  return {
    headline: 'The analysis could not be completed.',
    body: 'The model did not return a report. The note below is what OpenRouter sent back.',
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

export async function streamChat({ baseUrl, apiKey, model, messages, reasoning = true, dataCollection = 'deny', storingFallback = false, isOpenRouter = true, maxTokens = null, signal, onDelta, onReasoning, onStatus }) {
  const body = { model, messages, stream: true, temperature: 0.3 };
  if (maxTokens) body.max_tokens = maxTokens;
  if (isOpenRouter) {
    if (reasoning) body.reasoning = { effort: 'medium' };
    body.provider = { data_collection: dataCollection, allow_fallbacks: true };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (isOpenRouter && typeof location !== 'undefined') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = APP_TITLE;
  }
  onStatus && onStatus(storingFallback
    ? `Contacting ${model}. The table is anonymised codes only.`
    : `Contacting ${model}…`);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
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
    return { content, reasoning: (msg && (msg.reasoning || msg.reasoning_content)) || '', finishReason: json.choices && json.choices[0] && json.choices[0].finish_reason };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let finishReason = null;
  let gotAnyChunk = false;
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
  return { content, reasoning: reasoningText, finishReason };
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
async function runModelAttempts({ model, policy, storingFallback = false, maxTokens, baseUrl, apiKey, messages, isOpenRouter, signal, onDelta, onReasoning, onStatus, errors }) {
  const plans = [
    { reasoning: true, maxTokens },
    { reasoning: false, maxTokens: null },
  ];
  let waited = false;
  for (let a = 0; a < plans.length; a++) {
    const opt = plans[a];
    try {
      return await streamChat({
        baseUrl, apiKey, model, messages, isOpenRouter, signal, onDelta, onReasoning, onStatus,
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
export async function runWithFallback({ candidates, baseUrl, apiKey, messages, isOpenRouter, dataCollection, signal, onDelta, onReasoning, onStatus, onModelChange }) {
  const errors = [];
  const strict = dataCollection === 'deny-strict';
  const startPolicy = dataCollection === 'allow' ? 'allow' : 'deny';
  let accountPrivacyHits = 0;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const model = typeof cand === 'string' ? cand : cand.id;
    const maxTokens = cand && cand.maxCompletionTokens ? Math.min(cand.maxCompletionTokens, 32000) : null;
    onModelChange && onModelChange(model, i, candidates.length);
    const policies = [startPolicy];
    if (isOpenRouter && startPolicy === 'deny' && !strict) policies.push('allow');
    for (const policy of policies) {
      if (policy === 'allow' && startPolicy === 'deny') {
        onStatus && onStatus(`Trying another copy of ${model}…`);
      }
      try {
        const result = await runModelAttempts({
          model, policy, storingFallback: policy === 'allow' && startPolicy === 'deny', maxTokens, baseUrl, apiKey, messages, isOpenRouter, signal, onDelta, onReasoning, onStatus, errors,
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
