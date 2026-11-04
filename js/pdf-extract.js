// Turns a PDF into a simple, layout-aware structure:
//   pages[] -> rows[] -> cells[] (text + x position)
// Rows are reconstructed from the y coordinate of each text fragment and
// cells are split wherever there is a horizontal gap wider than a few
// characters. This is deliberately format-agnostic so that reports from
// different school systems (SIMS, Arbor, Bromcom, Go4Schools, ...) all end
// up as "rows of cells" that the report parser can reason about.

export async function extractPdfStructure(pdfjsLib, data, { maxPages = 60 } = {}) {
  const loadingTask = pdfjsLib.getDocument({
    data,
    // Reports are plain text PDFs; we never render them, so disable
    // everything that could reach out to the network or fonts.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages = [];
  const numPages = doc.numPages;
  const pageCount = Math.min(numPages, maxPages);
  try {
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      pages.push(buildPage(content.items, viewport, p));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { numPages, pages };
}

function buildPage(items, viewport, pageNumber) {
  const frags = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const text = it.str.replace(/\s+/g, ' ');
    if (!text.trim()) continue;
    const [a, b, , d, e, f] = it.transform;
    // Font size is encoded in the scale part of the transform.
    const fontSize = Math.hypot(a, b) || Math.abs(d) || 10;
    frags.push({
      text,
      x: e,
      y: f,
      w: it.width || text.length * fontSize * 0.5,
      h: it.height || fontSize,
      fontSize,
    });
  }

  // PDF y grows upwards, so sort top-to-bottom (descending y) then left-to-right.
  frags.sort((p, q) => (q.y - p.y) || (p.x - q.x));

  const rows = [];
  for (const frag of frags) {
    const last = rows[rows.length - 1];
    const tol = Math.max(2, frag.fontSize * 0.45);
    if (last && Math.abs(last.y - frag.y) <= tol) {
      last.frags.push(frag);
      // Keep a running average so slightly offset super/subscripts don't drift the row.
      last.y = (last.y * (last.frags.length - 1) + frag.y) / last.frags.length;
    } else {
      rows.push({ y: frag.y, frags: [frag] });
    }
  }

  const outRows = rows.map((row) => {
    row.frags.sort((p, q) => p.x - q.x);
    const cells = [];
    let cur = null;
    for (const frag of row.frags) {
      const charW = Math.max(2, frag.w / Math.max(1, frag.text.length));
      if (cur) {
        const gap = frag.x - cur.end;
        const refCharW = Math.max(2, (cur.charW + charW) / 2);
        if (gap <= refCharW * 2.2) {
          // Same cell. Insert a space only if the PDF did not already include one.
          // A clearly negative gap means two fragments were drawn on top of each
          // other (e.g. a wrapped line squeezed between rows): keep them apart.
          const needsSpace = (gap > refCharW * 0.25 || gap < -refCharW * 0.6) && !cur.text.endsWith(' ') && !frag.text.startsWith(' ');
          cur.text += (needsSpace ? ' ' : '') + frag.text;
          cur.end = Math.max(cur.end, frag.x + frag.w);
          cur.charW = refCharW;
          cur.fontSize = Math.max(cur.fontSize, frag.fontSize);
          continue;
        }
      }
      cur = { text: frag.text, x: frag.x, end: frag.x + frag.w, charW, fontSize: frag.fontSize };
      cells.push(cur);
    }
    const cleaned = cells
      .map((c) => ({ text: c.text.replace(/\s+/g, ' ').trim(), x: round(c.x), end: round(c.end), fontSize: round(c.fontSize) }))
      .filter((c) => c.text.length > 0);
    return {
      y: round(row.y),
      cells: cleaned,
      text: cleaned.map((c) => c.text).join(' | '),
    };
  });

  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    rows: outRows.filter((r) => r.cells.length > 0),
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

// Convenience: flat list of rows across pages, each tagged with its page number.
export function flattenRows(structure) {
  const out = [];
  for (const page of structure.pages) {
    for (const row of page.rows) out.push({ ...row, page: page.pageNumber });
  }
  return out;
}
