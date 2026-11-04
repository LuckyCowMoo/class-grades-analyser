export const AI_PROVIDER_ORDER = [
  'openrouter', 'claude', 'gemini', 'openai', 'xai', 'groq',
  'deepseek', 'mistral', 'together', 'fireworks',
];

export const AI_PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    keyPrefix: 'sk-ant-',
    auth: 'anthropic',
    docsUrl: 'https://platform.claude.com/settings/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    keyPrefix: 'AIza',
    auth: 'gemini',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyPrefix: 'sk- / sk-proj-',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  xai: {
    id: 'xai',
    label: 'Grok (xAI)',
    keyPrefix: 'xai-',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://console.x.ai/',
  },
  groq: {
    id: 'groq',
    label: 'Groq (Llama & others)',
    keyPrefix: 'gsk_',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyPrefix: 'sk-or-',
    auth: 'bearer',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    keyPrefix: 'sk-…',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    keyPrefix: '(no fixed prefix)',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  together: {
    id: 'together',
    label: 'Together AI',
    keyPrefix: '(no fixed prefix)',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.ai/settings/api-keys',
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks',
    keyPrefix: 'fw_',
    auth: 'bearer',
    openaiBaseUrl: 'https://api.fireworks.ai/inference/v1',
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
};

export const PROVIDER_BRANDS = {
  claude: {
    accent: '#c15f3c', panel: '#2a211c', ink: '#f6efe9', muted: 'rgba(246, 239, 233, 0.72)',
    company: 'Anthropic', shortName: 'Claude', keyService: 'Anthropic',
  },
  gemini: {
    accent: '#4285f4', panel: '#1a2333', ink: '#eef3ff', muted: 'rgba(238, 243, 255, 0.72)',
    company: 'Google', shortName: 'Gemini', keyService: 'Google',
  },
  openai: {
    accent: '#10a37f', panel: '#10241d', ink: '#e8fff6', muted: 'rgba(232, 255, 246, 0.72)',
    company: 'OpenAI', shortName: 'ChatGPT', keyService: 'OpenAI',
  },
  xai: {
    accent: '#e8e8e8', panel: '#111111', ink: '#f5f5f5', muted: 'rgba(245, 245, 245, 0.7)',
    company: 'xAI', shortName: 'Grok', keyService: 'xAI',
  },
  groq: {
    accent: '#0668e1', panel: '#0f1a2e', ink: '#eaf2ff', muted: 'rgba(234, 242, 255, 0.72)',
    company: 'Meta', shortName: 'Llama', keyService: 'Groq',
  },
  openrouter: {
    accent: '#6566f1', panel: '#1a1b33', ink: '#eef0ff', muted: 'rgba(238, 240, 255, 0.72)',
    company: 'OpenRouter', shortName: 'Many models', keyService: 'OpenRouter',
  },
  deepseek: {
    accent: '#4d6bfe', panel: '#121a33', ink: '#eef2ff', muted: 'rgba(238, 242, 255, 0.72)',
    company: 'DeepSeek', shortName: 'DeepSeek', keyService: 'DeepSeek',
  },
  mistral: {
    accent: '#ff7000', panel: '#2a180c', ink: '#fff4eb', muted: 'rgba(255, 244, 235, 0.72)',
    company: 'Mistral', shortName: 'Mistral', keyService: 'Mistral',
  },
  together: {
    accent: '#0f6fff', panel: '#0f1a2e', ink: '#eaf2ff', muted: 'rgba(234, 242, 255, 0.72)',
    company: 'Together AI', shortName: 'Open models', keyService: 'Together',
  },
  fireworks: {
    accent: '#7c3aed', panel: '#1a1230', ink: '#f3ecff', muted: 'rgba(243, 236, 255, 0.72)',
    company: 'Fireworks', shortName: 'Open models', keyService: 'Fireworks',
  },
};

export const OVERVIEW_BRAND = {
  accent: '#f4a184', panel: '#2f3868', ink: '#fff8f2', muted: 'rgba(255, 248, 242, 0.72)',
};

export const PROVIDER_LOGOS = {
  claude: 'img/provider-logos/claude.svg',
  gemini: 'img/provider-logos/gemini.svg',
  openai: 'img/provider-logos/openai.svg',
  xai: 'img/provider-logos/xai.svg',
  groq: 'img/provider-logos/llama.svg',
  openrouter: 'img/provider-logos/openrouter.svg',
  deepseek: 'img/provider-logos/deepseek.svg',
  mistral: 'img/provider-logos/mistral.svg',
  together: 'img/provider-logos/together.svg',
  fireworks: 'img/provider-logos/fireworks.svg',
};

export const SPARKLES_LOGO = 'img/provider-logos/sparkles.svg';

const PASTE = 'Paste the key in the box on this tab. It stays on this computer and is only sent to that provider when you press Go.';

function linkStep(before, href, linkLabel, after = '.') {
  return { text: before, href, linkLabel, afterLink: after };
}

export const PROVIDER_GUIDE = {
  claude: {
    whyChoose: 'Choose Claude if you want careful British-English writing that stays close to the grades and is less likely to invent scores.',
    steps: [
      linkStep('Sign in (or create an account) at ', 'https://platform.claude.com/', 'platform.claude.com'),
      linkStep('Open ', AI_PROVIDERS.claude.docsUrl, 'Settings → API keys'),
      { text: 'Click Create key, give it a name such as Class analyser, and copy it immediately. It starts with sk-ant-.' },
      { text: 'Add billing if prompted. A new key often will not run until payment is set up.' },
      { text: PASTE },
    ],
  },
  gemini: {
    whyChoose: 'Choose Gemini if you want a Google account, a usable free tier for trying this page, and generally fast replies.',
    steps: [
      linkStep('Sign in with a Google account at ', AI_PROVIDERS.gemini.docsUrl, 'aistudio.google.com/app/apikey'),
      { text: 'Click Create API key and choose (or create) a Google Cloud project when asked.' },
      { text: 'Copy the key (often starts with AIza) and keep it on this computer only.' },
      { text: PASTE },
    ],
  },
  openai: {
    whyChoose: 'Choose OpenAI if you already buy ChatGPT API credit and want a widely supported writer for the class report.',
    steps: [
      linkStep('Sign in at ', 'https://platform.openai.com/', 'platform.openai.com'),
      linkStep('Open ', AI_PROVIDERS.openai.docsUrl, 'API keys'),
      { text: 'Create a new secret key (often sk-proj-… or sk-…). Copy it immediately.' },
      { text: 'Add billing credits if prompted. Many new accounts need a payment method before a model will run.' },
      { text: PASTE },
    ],
    note: 'Some browsers block OpenAI from a web page (CORS). If that happens, use OpenRouter, Gemini, or Claude instead.',
  },
  xai: {
    whyChoose: 'Choose xAI if you specifically want Grok models and already have a console key.',
    steps: [
      linkStep('Sign in at ', 'https://console.x.ai/', 'console.x.ai'),
      { text: 'Open API keys, create a key (it starts with xai-), and copy it immediately.' },
      { text: 'Check that the account has Grok API access and credit.' },
      { text: PASTE },
    ],
  },
  groq: {
    whyChoose: 'Choose Groq if you care most about speed: it hosts Llama and similar open models with very fast replies.',
    steps: [
      linkStep('Sign in at ', 'https://console.groq.com/', 'console.groq.com'),
      linkStep('Open ', AI_PROVIDERS.groq.docsUrl, 'API Keys'),
      { text: 'Create a key (starts with gsk_) and copy it. Groq will not show the full secret again.' },
      { text: PASTE },
    ],
  },
  openrouter: {
    whyChoose: 'Choose OpenRouter if you want one key that can reach many labs, including free models. You can sign in with a school Google account.',
    steps: [
      linkStep('Go to ', 'https://openrouter.ai/', 'openrouter.ai', ' and sign in. You can do this with your school Google account.'),
      linkStep('Open ', 'https://openrouter.ai/settings/keys', 'Settings, then Keys'),
      { text: 'Click Create a new key. Give it a name such as Class analyser. Copy the key (it starts with sk-or-).' },
      { text: 'OpenRouter has free and paid models. The free ones are often comparable to free ChatGPT or Gemini plans, though they respond more slowly.' },
      { text: PASTE },
    ],
  },
  deepseek: {
    whyChoose: 'Choose DeepSeek if you want capable models at a low cost. Keys look like OpenAI keys, so pick this tab after pasting.',
    steps: [
      linkStep('Sign in at ', 'https://platform.deepseek.com/', 'platform.deepseek.com'),
      linkStep('Open ', AI_PROVIDERS.deepseek.docsUrl, 'API keys'),
      { text: 'Create a key. DeepSeek uses an OpenAI-style sk-… prefix, so it can look like an OpenAI key.' },
      { text: PASTE },
    ],
  },
  mistral: {
    whyChoose: 'Choose Mistral if you prefer European hosting. Keys have no fixed prefix, so you must paste them on this tab.',
    steps: [
      linkStep('Sign in at ', 'https://console.mistral.ai/', 'console.mistral.ai'),
      linkStep('Open ', AI_PROVIDERS.mistral.docsUrl, 'API keys'),
      { text: 'Create a key and copy it. There is no unique prefix, so paste it here rather than on the OpenAI tab.' },
      { text: PASTE },
    ],
  },
  together: {
    whyChoose: 'Choose Together AI if you want a wide catalogue of open models (Llama and others) from one OpenAI-style endpoint.',
    steps: [
      linkStep('Sign in at ', 'https://api.together.ai/', 'api.together.ai'),
      linkStep('Open ', AI_PROVIDERS.together.docsUrl, 'API keys'),
      { text: 'Create a key and copy it. Together does not use a unique prefix, so paste it on this tab.' },
      { text: PASTE },
    ],
  },
  fireworks: {
    whyChoose: 'Choose Fireworks if you want fast hosted open models and already use their console. Keys start with fw_.',
    steps: [
      linkStep('Sign in at ', 'https://fireworks.ai/', 'fireworks.ai'),
      linkStep('Open ', AI_PROVIDERS.fireworks.docsUrl, 'API keys'),
      { text: 'Create a key (starts with fw_) and copy it.' },
      { text: PASTE },
    ],
  },
};

export const GUIDE_SLIDER_PROVIDERS = AI_PROVIDER_ORDER;

export function guideProviderAtNotch(notch) {
  if (notch <= 0) return null;
  return GUIDE_SLIDER_PROVIDERS[notch - 1] || null;
}

export function guideNotchCount() {
  return GUIDE_SLIDER_PROVIDERS.length + 1;
}

export function notchForProvider(id) {
  const i = GUIDE_SLIDER_PROVIDERS.indexOf(id);
  return i < 0 ? 0 : i + 1;
}

export function providerLabel(id) {
  return (AI_PROVIDERS[id] && AI_PROVIDERS[id].label) || id;
}

export function providersWithKeys(apiKeys) {
  const keys = apiKeys || {};
  return AI_PROVIDER_ORDER.filter((id) => String(keys[id] || '').trim());
}

export const FALLBACK_MODELS = {
  claude: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ],
  gemini: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
  ],
  openai: [
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'o4-mini', name: 'o4-mini' },
  ],
  xai: [
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
    { id: 'grok-3', name: 'Grok 3' },
  ],
  groq: [
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout (Groq)' },
  ],
  openrouter: [],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
  mistral: [
    { id: 'mistral-small-latest', name: 'Mistral Small' },
    { id: 'mistral-medium-latest', name: 'Mistral Medium' },
  ],
  together: [
    { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama4-scout-instruct-basic', name: 'Llama 4 Scout' },
  ],
};

export function emptyApiKeys() {
  const out = {};
  for (const id of AI_PROVIDER_ORDER) out[id] = '';
  return out;
}
