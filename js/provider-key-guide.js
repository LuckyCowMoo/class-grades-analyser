import {
  AI_PROVIDERS,
  GUIDE_SLIDER_PROVIDERS,
  OVERVIEW_BRAND,
  PROVIDER_BRANDS,
  PROVIDER_GUIDE,
  PROVIDER_LOGOS,
  SPARKLES_LOGO,
  guideNotchCount,
  guideProviderAtNotch,
  notchForProvider,
} from './ai-providers.js?v=4';

const TRACK_PIP_INSET_PX = 24;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stepHtml(step) {
  if (step.href && step.linkLabel) {
    return `${escapeHtml(step.text)}<a href="${escapeHtml(step.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(step.linkLabel)}</a>${escapeHtml(step.afterLink || '')}`;
  }
  return escapeHtml(step.text);
}

function brandVars(brand) {
  return `--pk-accent:${brand.accent};--pk-panel:${brand.panel};--pk-ink:${brand.ink};--pk-muted:${brand.muted}`;
}

function pipMark(provider, active) {
  const src = PROVIDER_LOGOS[provider];
  return `<img class="provider-key-pip-mark${active ? ' is-active' : ''}" src="${src}" alt="" draggable="false" aria-hidden="true">`;
}

async function canCallOpenAiFromBrowser() {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer sk-browser-cors-probe' },
        signal: controller.signal,
      });
      return res.status > 0;
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function mountProviderKeyGuide({ el, getKeys, onKeyChange, initialProvider = null }) {
  const notchCount = guideNotchCount();
  const maxNotch = notchCount - 1;
  let notch = initialProvider ? notchForProvider(initialProvider) : 0;
  let dragValue = notch;
  let isDragging = false;
  let openAiOk = null;
  const trackRef = { current: null };

  const snapTo = (raw) => {
    const clamped = Math.max(0, Math.min(maxNotch, Math.round(raw)));
    notch = clamped;
    dragValue = clamped;
    paint();
  };

  const valueFromClientX = (clientX) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const usable = Math.max(1, rect.width - TRACK_PIP_INSET_PX * 2);
    const t = (clientX - rect.left - TRACK_PIP_INSET_PX) / usable;
    return Math.max(0, Math.min(maxNotch, t * maxNotch));
  };

  const endDrag = (clientX) => {
    isDragging = false;
    snapTo(valueFromClientX(clientX));
  };

  const onWinMove = (e) => {
    if (!isDragging) return;
    dragValue = valueFromClientX(e.clientX);
    paintFill();
  };
  const onWinUp = (e) => {
    if (!isDragging) return;
    window.removeEventListener('pointermove', onWinMove);
    window.removeEventListener('pointerup', onWinUp);
    window.removeEventListener('pointercancel', onWinUp);
    endDrag(e.clientX);
  };

  function paintFill() {
    const fill = el.querySelector('.provider-key-track-fill');
    if (!fill) return;
    const visual = (isDragging ? dragValue : notch) / maxNotch;
    fill.style.width = `calc(${TRACK_PIP_INSET_PX * 2}px + (100% - ${TRACK_PIP_INSET_PX * 2}px) * ${visual})`;
    fill.classList.toggle('is-dragging', isDragging);
  }

  function panelHtml(provider) {
    if (!provider) {
      return `
        <div class="provider-key-panel provider-key-panel-brand" data-panel="overview">
          <div class="provider-key-hero">
            <div class="provider-key-logo-wrap">
              <img class="provider-key-logo-img provider-key-logo-sparkles" src="${SPARKLES_LOGO}" alt="" width="40" height="40" draggable="false" aria-hidden="true">
            </div>
            <div class="provider-key-name-wrap">
              <p class="provider-key-company">Class Grades Analyser</p>
              <h4 class="provider-key-name">How keys work here</h4>
            </div>
          </div>
          <div class="provider-key-setup">
            <p class="provider-key-note" style="margin-top:0">This website needs an API key from an AI provider, the large AI models will run on their servers remotely, but we will strip all identifiable information before sending them anything.
            <br><br>
            You can save more than one, then pick which service to use before you press Go. Openrouter (first tab on the slider) provides adiquate free models, but they will be slow and more likley to make mistakes.
            </p>
            <p class="provider-key-note">Drag the slider onto a provider for step-by-step instructions.</p>
          </div>
        </div>`;
    }
    const info = AI_PROVIDERS[provider];
    const brand = PROVIDER_BRANDS[provider];
    const entry = PROVIDER_GUIDE[provider];
    const keys = getKeys();
    const value = escapeHtml(keys[provider] || '');
    const prefix = info.keyPrefix;
    const placeholder = prefix.includes('no fixed') ? 'Paste key here' : prefix;
    const cors = provider === 'openai' && openAiOk === false
      ? `<p class="provider-key-warning" role="alert"><strong>This browser can’t use OpenAI from the page.</strong> OpenAI blocks the request (CORS). Use OpenRouter, Gemini, or Claude instead.</p>`
      : '';
    const note = entry.note ? `<p class="provider-key-note">${escapeHtml(entry.note)}</p>` : '';
    const steps = entry.steps.map((s) => `<li>${stepHtml(s)}</li>`).join('');
    return `
      <div class="provider-key-panel provider-key-panel-brand" data-panel="${provider}">
        <div class="provider-key-hero">
          <div class="provider-key-logo-wrap">
            <img class="provider-key-logo-img" src="${PROVIDER_LOGOS[provider]}" alt="" width="40" height="40" draggable="false">
          </div>
          <div class="provider-key-name-wrap">
            <p class="provider-key-company">${escapeHtml(brand.company)}</p>
            <h4 class="provider-key-name">${escapeHtml(brand.shortName)}</h4>
            <p class="provider-key-prefix">Keys like <code>${escapeHtml(prefix)}</code></p>
          </div>
        </div>
        <div class="provider-key-setup">
          <div class="provider-key-install">
            <label class="provider-key-install-label" for="pk-key-${provider}">Paste your ${escapeHtml(brand.keyService)} API key</label>
            <div class="secret-input">
              <input id="pk-key-${provider}" type="password" value="${value}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
              <button type="button" class="secret-toggle" data-toggle-key="${provider}" aria-pressed="false">Show</button>
              <span class="save-key-slot"></span>
            </div>
          </div>
          <h4 class="provider-key-setup-title">How to get this key</h4>
          <p class="provider-key-why">${escapeHtml(entry.whyChoose)}</p>
          <ol class="guide-steps provider-key-steps">${steps}</ol>
          ${note}${cors}
        </div>
      </div>`;
  }

  function paint() {
    const provider = guideProviderAtNotch(notch);
    const brand = provider ? PROVIDER_BRANDS[provider] : OVERVIEW_BRAND;
    const visual = (isDragging ? dragValue : notch) / maxNotch;
    const notches = Array.from({ length: notchCount }, (_, i) => {
      const active = i === notch && !isDragging;
      const pipProvider = i === 0 ? null : GUIDE_SLIDER_PROVIDERS[i - 1];
      const t = i / maxNotch;
      const label = i === 0 ? 'Overview' : PROVIDER_BRANDS[pipProvider].shortName;
      const mark = pipProvider
        ? pipMark(pipProvider, active)
        : `<img class="provider-key-pip-mark provider-key-pip-sparkles${active ? ' is-active' : ''}" src="${SPARKLES_LOGO}" alt="" width="14" height="14" draggable="false" aria-hidden="true">`;
      return `<button type="button" class="provider-key-notch${active ? ' is-active' : ''}${i === 0 ? ' is-home' : ''}" data-notch="${i}" style="left: calc(${TRACK_PIP_INSET_PX}px + (100% - ${TRACK_PIP_INSET_PX * 2}px) * ${t})" tabindex="-1" aria-label="${escapeHtml(label)}">${mark}</button>`;
    }).join('');
    el.className = 'provider-key-guide is-branded';
    el.style.cssText = brandVars(brand);
    const save = document.getElementById('save-key');
    const home = document.getElementById('key-actions');
    if (save && home && save.parentElement !== home) home.appendChild(save);
    el.innerHTML = `
      <div class="provider-key-slider">
        <div class="provider-key-track" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="${maxNotch}" aria-valuenow="${notch}" aria-valuetext="${escapeHtml(provider ? PROVIDER_BRANDS[provider].shortName : 'Overview')}" aria-label="Choose an AI provider">
          <div class="provider-key-track-fill${isDragging ? ' is-dragging' : ''}" style="width: calc(${TRACK_PIP_INSET_PX * 2}px + (100% - ${TRACK_PIP_INSET_PX * 2}px) * ${visual})"></div>
          <div class="provider-key-notches">${notches}</div>
        </div>
      </div>
      ${panelHtml(provider)}`;
    trackRef.current = el.querySelector('.provider-key-track');
    const slot = el.querySelector('.save-key-slot');
    if (save && slot) slot.replaceWith(save);
    else if (save && home) home.appendChild(save);
    bind();
    if (provider === 'openai' && openAiOk == null) {
      canCallOpenAiFromBrowser().then((ok) => {
        openAiOk = ok;
        if (guideProviderAtNotch(notch) === 'openai') paint();
      });
    }
  }

  function bind() {
    const track = trackRef.current;
    if (!track) return;
    track.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.provider-key-notch')) return;
      e.preventDefault();
      isDragging = true;
      dragValue = valueFromClientX(e.clientX);
      paintFill();
      window.addEventListener('pointermove', onWinMove);
      window.addEventListener('pointerup', onWinUp);
      window.addEventListener('pointercancel', onWinUp);
    });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); snapTo(notch + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); snapTo(notch - 1); }
      else if (e.key === 'Home') { e.preventDefault(); snapTo(0); }
      else if (e.key === 'End') { e.preventDefault(); snapTo(maxNotch); }
    });
    el.querySelectorAll('[data-notch]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        isDragging = false;
        snapTo(Number(btn.getAttribute('data-notch')));
      });
    });
    const input = el.querySelector('.provider-key-install input');
    if (input) {
      input.addEventListener('input', () => {
        const id = input.id.replace(/^pk-key-/, '');
        onKeyChange(input.value, id);
      });
    }
    const toggle = el.querySelector('[data-toggle-key]');
    if (toggle && input) {
      toggle.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Hide' : 'Show';
        toggle.setAttribute('aria-pressed', String(show));
      });
    }
  }

  paint();
  return {
    showProvider(id) { snapTo(notchForProvider(id)); },
  };
}
