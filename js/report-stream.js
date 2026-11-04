const PLACEHOLDER = `<div class="table-gen" role="status" aria-label="Generating table">
  <div class="table-gen-shine" aria-hidden="true"></div>
  <div class="table-gen-copy">
    <span class="table-gen-label">Generating table</span>
    <div class="table-gen-reel" aria-live="polite"></div>
  </div>
  <aside class="table-gen-stats">
    <p>model has thought for</p>
    <b class="table-gen-time">0s</b>
    <p>model has generated</p>
    <b class="table-gen-words">0 words</b>
  </aside>
</div>`;

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparatorLine(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function looksLikeSepStart(line) {
  const t = String(line || '').trim();
  return t.includes('-') && /^\|?[\s:|-]+$/.test(t);
}

function looksLikeTableRowStart(line) {
  return /^\s*\|/.test(line);
}

function tableLines(text) {
  const raw = String(text).split('\n');
  return text.endsWith('\n') ? raw.slice(0, -1) : raw;
}

function lineStarts(text, lines) {
  const starts = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  return starts;
}

function findOpenTableStart(text) {
  const lines = tableLines(text);
  const starts = lineStarts(text, lines);
  const incompleteLast = !text.endsWith('\n');
  let i = 0;
  while (i < lines.length) {
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length) {
        const line = lines[j];
        const last = j === lines.length - 1;
        if (isTableLine(line)) { j++; continue; }
        if (last && incompleteLast && (looksLikeTableRowStart(line) || looksLikeSepStart(line) || !line.trim())) {
          j++;
          continue;
        }
        break;
      }
      if (j >= lines.length) return starts[i];
      i = j;
      continue;
    }
    if (isTableLine(lines[i])) {
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next == null) return starts[i];
      if (looksLikeSepStart(next)) return starts[i];
    }
    i++;
  }
  return -1;
}

function takeCompleteWords(s) {
  if (!s) return '';
  if (/\s$/.test(s)) return s;
  const sp = s.search(/\s\S*$/);
  if (sp < 0) return '';
  return s.slice(0, sp + 1);
}

export function splitStreamMarkdown(md, done = false) {
  const text = String(md || '').replace(/\r\n?/g, '\n');
  if (!text) return { ready: '', holdingTable: false, heldText: '', holdAt: -1 };
  if (done) return { ready: text, holdingTable: false, heldText: '', holdAt: -1 };

  const holdAt = findOpenTableStart(text);
  if (holdAt >= 0) return { ready: text.slice(0, holdAt), holdingTable: true, heldText: text.slice(holdAt), holdAt };

  if (!text.endsWith('\n')) {
    const nl = text.lastIndexOf('\n');
    const head = nl >= 0 ? text.slice(0, nl + 1) : '';
    const tail = nl >= 0 ? text.slice(nl + 1) : text;
    if (looksLikeTableRowStart(tail) || looksLikeSepStart(tail)) {
      return { ready: head, holdingTable: looksLikeTableRowStart(tail), heldText: tail, holdAt: head.length };
    }
    return { ready: head + takeCompleteWords(tail), holdingTable: false, heldText: '', holdAt: -1 };
  }
  return { ready: text, holdingTable: false, heldText: '', holdAt: -1 };
}

function wrapWords(root) {
  const skip = '.report-table, .table-gen, .table-gen-reel, pre, code, .cursor';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement && node.parentElement.closest(skip)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.nodeValue.split(/(\s+)/);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.append(part);
        continue;
      }
      const span = document.createElement('span');
      const nameEl = node.parentElement && node.parentElement.closest('.name');
      span.className = nameEl ? 'w is-name' : 'w';
      if (nameEl && nameEl.getAttribute('title')) span.title = nameEl.getAttribute('title');
      span.textContent = part;
      frag.append(span);
    }
    node.parentNode.replaceChild(frag, node);
  }
}

function collectItems(root) {
  const items = [];
  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.classList.contains('w')) { items.push({ type: 'word', el: node }); return; }
    if (node.classList.contains('report-table')) { items.push({ type: 'table', el: node }); return; }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return items;
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function bufKey(node, root) {
  const parts = [];
  for (let n = node; n && n !== root; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    const i = n.parentNode ? [...n.parentNode.childNodes].indexOf(n) : 0;
    parts.push(`${n.nodeName}:${i}`);
  }
  return parts.reverse().join('/');
}

export function attachReportStream({ mount, toHtml }) {
  const LAG_MIN = 10;
  const LAG_MAX = 15;
  const LAG_TARGET = 12;
  const buffer = document.createElement('div');
  let received = '';
  let done = false;
  let shown = 0;
  let paintedKey = '';
  let items = [];
  let liveEls = [];
  let waiting = null;
  let lastPush = 0;
  let resolveDone = null;
  let tableHold = { start: 0, raf: 0, at: -1, thinkFrom: 0 };
  let thinkAll = '';

  function countWords(text) {
    const t = String(text || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function tableThinkLines() {
    return String(thinkAll || '').slice(tableHold.thinkFrom)
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.slice(0, 280));
  }

  function paintTableReel(gen) {
    if (!gen) return;
    const reel = gen.querySelector('.table-gen-reel');
    if (!reel) return;
    const lines = tableThinkLines();
    let nodes = reel.querySelectorAll('.think-line');
    if (nodes.length > lines.length || (nodes.length && lines.length && nodes[0].textContent !== lines[0])) {
      reel.innerHTML = '';
      nodes = reel.querySelectorAll('.think-line');
    }
    for (let i = 0; i < nodes.length; i++) {
      if (lines[i] != null && nodes[i].textContent !== lines[i]) nodes[i].textContent = lines[i];
    }
    for (let i = reel.querySelectorAll('.think-line').length; i < lines.length; i++) {
      const div = document.createElement('div');
      div.className = 'think-line';
      div.textContent = lines[i];
      reel.appendChild(div);
    }
  }

  function formatHoldTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function paintTableStats(gen, heldText) {
    if (!gen) return;
    const timeEl = gen.querySelector('.table-gen-time');
    const wordEl = gen.querySelector('.table-gen-words');
    if (!timeEl || !wordEl) return;
    timeEl.textContent = formatHoldTime(tableHold.start ? performance.now() - tableHold.start : 0);
    const n = countWords(heldText);
    wordEl.textContent = `${n} word${n === 1 ? '' : 's'}`;
    paintTableReel(gen);
  }

  function stopTableStats() {
    if (tableHold.raf) cancelAnimationFrame(tableHold.raf);
    tableHold.raf = 0;
    tableHold.at = -1;
    tableHold.start = 0;
    tableHold.thinkFrom = 0;
  }

  function tickTableStats() {
    const { holdingTable, heldText } = split();
    if (!holdingTable) {
      tableHold.raf = 0;
      return;
    }
    const gen = el().querySelector('.table-gen.is-live');
    if (gen) paintTableStats(gen, heldText);
    tableHold.raf = requestAnimationFrame(tickTableStats);
  }

  function startTableStats(holdAt, heldText) {
    if (tableHold.at !== holdAt) {
      tableHold.at = holdAt;
      tableHold.start = performance.now();
      tableHold.thinkFrom = thinkAll.length;
      const reel = el().querySelector('.table-gen-reel');
      if (reel) reel.innerHTML = '';
    }
    const gen = el().querySelector('.table-gen.is-live');
    paintTableStats(gen, heldText);
    if (!tableHold.raf) tableHold.raf = requestAnimationFrame(tickTableStats);
  }

  function el() {
    return typeof mount === 'function' ? mount() : mount;
  }

  function split() {
    return splitStreamMarkdown(received, done);
  }

  function refreshBuffer() {
    const { ready, holdingTable } = split();
    const key = `${holdingTable ? 1 : 0}:${ready}`;
    if (key === paintedKey) return holdingTable;
    paintedKey = key;
    buffer.innerHTML = toHtml(ready);
    wrapWords(buffer);
    const nextItems = collectItems(buffer);
    const limit = Math.min(shown, nextItems.length, items.length);
    const broken = limit > 0 && nextItems.slice(0, limit).some((it, i) => (
      it.type !== items[i].type || it.el.textContent !== items[i].el.textContent
    ));
    items = nextItems;
    if (shown > items.length) shown = items.length;
    if (broken) rebuildLive();
    return holdingTable;
  }

  function importWrappers(bufEl) {
    const rootLive = el();
    const chain = [];
    for (let n = bufEl.parentElement; n && n !== buffer; n = n.parentElement) chain.push(n);
    chain.reverse();
    let live = rootLive;
    for (const wrap of chain) {
      const key = bufKey(wrap, buffer);
      let next = [...live.children].find((c) => c.dataset.bufKey === key);
      if (!next) {
        next = wrap.cloneNode(false);
        next.dataset.bufKey = key;
        const prev = wrap.previousSibling;
        if (prev && prev.nodeType === 3) live.appendChild(document.createTextNode(prev.nodeValue));
        live.appendChild(next);
      }
      live = next;
    }
    return live;
  }

  function importItem(it, instant) {
    const parent = importWrappers(it.el);
    if (it.type === 'table') {
      const clone = it.el.cloneNode(true);
      clone.classList.remove('is-wait');
      if (!instant && !reduceMotion()) clone.classList.add('table-in');
      parent.appendChild(clone);
      return clone;
    }
    const prev = it.el.previousSibling;
    if (prev && prev.nodeType === 3) parent.appendChild(document.createTextNode(prev.nodeValue));
    const clone = it.el.cloneNode(true);
    clone.classList.add('in');
    clone.classList.toggle('instant', instant || reduceMotion());
    parent.appendChild(clone);
    return clone;
  }

  function rebuildLive() {
    const keep = shown;
    el().querySelectorAll('.cursor, .table-gen').forEach((n) => n.remove());
    el().innerHTML = '';
    liveEls = [];
    shown = 0;
    while (shown < keep && shown < items.length) revealNext(true);
  }

  function syncPlaceholder(holdingTable = split().holdingTable) {
    const root = el();
    const { heldText, holdAt } = split();
    const live = holdingTable && shown >= items.length;
    let gen = root.querySelector('.table-gen');
    if (holdingTable) startTableStats(holdAt, heldText);
    else stopTableStats();
    if (!live) {
      if (gen) gen.classList.remove('is-live');
      return;
    }
    if (!gen) {
      root.insertAdjacentHTML('beforeend', PLACEHOLDER);
      gen = root.querySelector('.table-gen');
    } else if (!gen.classList.contains('is-live') && gen.nextSibling) {
      root.appendChild(gen);
    }
    gen.classList.add('is-live');
    startTableStats(holdAt, heldText);
  }

  function placeCursor() {
    const root = el();
    root.querySelectorAll('.cursor').forEach((n) => n.remove());
    if (done) return;
    const holdingTable = split().holdingTable;
    const next = items[shown];
    if ((holdingTable && shown >= items.length) || (next && next.type === 'table')) return;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.setAttribute('aria-hidden', 'true');
    const last = liveEls[shown - 1];
    if (last && last.parentNode) last.after(cursor);
    else root.append(cursor);
  }

  function lag() {
    return Math.max(0, items.length - shown);
  }

  function interval() {
    if (reduceMotion()) return 0;
    const n = lag();
    const holdingTable = split().holdingTable;
    if (holdingTable && !done) return n > 0 ? 22 : 80;
    if (n <= 0) return 40;
    if (done) return Math.max(4, 12 * Math.exp(-0.1 * n));
    const over = Math.max(0, n - LAG_TARGET);
    return Math.max(4, 18 * Math.exp(-0.2 * over));
  }

  function burst(n) {
    if (done) return n > 30 ? 8 : 3;
    if (n <= LAG_MAX) return 1;
    return Math.min(8, 1 + Math.floor(Math.exp(0.14 * (n - LAG_MAX)) - 1));
  }

  function revealNext(instant = false) {
    if (shown >= items.length) return;
    liveEls[shown] = importItem(items[shown], instant);
    shown += 1;
    syncPlaceholder();
    placeCursor();
  }

  function caughtUp() {
    return done && shown >= items.length && !split().holdingTable;
  }

  function streamStalled() {
    return performance.now() - lastPush > 320;
  }

  function step() {
    const holdingTable = refreshBuffer();
    const n = lag();
    const next = items[shown];
    if (reduceMotion()) {
      while (shown < items.length) revealNext(true);
    } else if (shown < items.length) {
      const writingTable = holdingTable;
      const drain = done || writingTable || (next && next.type === 'table') || streamStalled();
      if (drain || n > LAG_MIN) {
        const count = writingTable && !done
          ? 1
          : drain && !done && next && next.type === 'table' && n <= LAG_MAX
            ? 1
            : (drain || n > LAG_MAX ? burst(n) : 1);
        for (let i = 0; i < count; i++) {
          if (shown >= items.length) break;
          if (!writingTable && !drain && !done && lag() <= LAG_MIN) break;
          revealNext(false);
        }
      }
    }
    syncPlaceholder(holdingTable);
    if (holdingTable && shown >= items.length) placeCursor();
    if (caughtUp()) {
      waiting = null;
      el().querySelectorAll('.cursor').forEach((n) => n.remove());
      if (resolveDone) {
        const fn = resolveDone;
        resolveDone = null;
        fn();
      }
      return;
    }
    schedule();
  }

  function schedule() {
    if (waiting) clearTimeout(waiting);
    waiting = setTimeout(step, interval());
  }

  function pushThink(all) {
    thinkAll = String(all || '');
    const { holdingTable, heldText } = split();
    if (!holdingTable) return;
    const gen = el().querySelector('.table-gen.is-live');
    if (gen) paintTableReel(gen);
  }

  function reset({ seed = '' } = {}) {
    thinkAll = '';
    stopTableStats();
    if (waiting) clearTimeout(waiting);
    waiting = null;
    received = seed;
    done = false;
    shown = 0;
    paintedKey = '';
    items = [];
    liveEls = [];
    resolveDone = null;
    buffer.innerHTML = '';
    el().innerHTML = '';
    if (seed) {
      refreshBuffer();
      while (shown < items.length) revealNext(true);
      placeCursor();
    }
  }

  function push(md) {
    received = String(md || '');
    lastPush = performance.now();
    refreshBuffer();
    schedule();
  }

  function finish() {
    done = true;
    return new Promise((resolve) => {
      resolveDone = resolve;
      refreshBuffer();
      if (caughtUp()) {
        resolveDone = null;
        el().querySelectorAll('.cursor').forEach((n) => n.remove());
        resolve();
        return;
      }
      schedule();
    });
  }

  function stop() {
    done = true;
    stopTableStats();
    if (waiting) clearTimeout(waiting);
    waiting = null;
    resolveDone = null;
    refreshBuffer();
    while (shown < items.length) revealNext(true);
    el().querySelectorAll('.cursor').forEach((n) => n.remove());
  }

  return { reset, push, pushThink, finish, stop };
}
