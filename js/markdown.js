// Small, safe Markdown renderer. All text is HTML-escaped first, so output
// from the AI can never inject markup. Supports headings, paragraphs,
// bullet/numbered lists, bold/italic/code, horizontal rules and pipe tables.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return s;
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparatorLine(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); i++; continue; }

    // Fenced code block
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // Heading
    let m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) { flushPara(); const lvl = Math.min(6, m[1].length + 1); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i++; continue; }
    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    // Table
    if (isTableLine(line) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      let html = '<div class="report-table"><table><thead><tr>';
      for (const h of header) html += `<th>${inline(h)}</th>`;
      html += '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>';
        for (let k = 0; k < header.length; k++) html += `<td>${inline(r[k] ?? '')}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      out.push(html);
      continue;
    }
    // Lists (bullet or numbered), with simple nesting by indentation
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      out.push(renderList(lines, i, (next) => { i = next; }));
      continue;
    }
    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('\n');
}

function renderList(lines, start, setIndex) {
  // Collect consecutive list lines (and their continuation lines).
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
      i++;
      continue;
    }
    if (line.trim() && /^\s{2,}/.test(line) && items.length && !/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      items[items.length - 1].text += ' ' + line.trim();
      i++;
      continue;
    }
    break;
  }
  setIndex(i);
  return buildNested(items, 0, items.length, items[0] ? items[0].indent : 0);
}

function buildNested(items, from, to, baseIndent) {
  let html = '';
  let k = from;
  while (k < to) {
    if (items[k].indent < baseIndent) break;
    const ordered = items[k].ordered;
    html += ordered ? '<ol>' : '<ul>';
    // Switching between bullets and numbers at the same level starts a new list.
    while (k < to && items[k].indent >= baseIndent && items[k].ordered === ordered) {
      const it = items[k];
      let j = k + 1;
      while (j < to && items[j].indent > it.indent) j++;
      html += `<li>${inline(it.text)}${j > k + 1 ? buildNested(items, k + 1, j, items[k + 1].indent) : ''}</li>`;
      k = j;
    }
    html += ordered ? '</ol>' : '</ul>';
  }
  return html;
}
