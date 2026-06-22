// mastra/public/source/viewer.js
import * as pdfjsLib from '/v1/source/assets/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/v1/source/assets/pdf.worker.mjs';

// Si le surlignage apparaît décalé verticalement en staging, passer FLIP_Y à true
// (convention d'axe mupdf vs pdf.js). Voir Plan 4, note d'intégration.
const FLIP_Y = false;

const path = location.pathname; // /v1/source/{documentId}
const search = location.search; // ?used=..&exp=..&sig=..
const fileUrl = `${path}/file${search}`;
const highlightsUrl = `${path}/highlights${search}`;

async function main() {
  const pagesEl = document.getElementById('pages');
  let highlights = { pages: [], citedText: [] };
  try {
    highlights = await (await fetch(highlightsUrl)).json();
  } catch { /* repli : pas de surlignage */ }

  const byPage = new Map();
  for (const p of highlights.pages || []) byPage.set(p.page, p);

  const pdf = await pdfjsLib.getDocument({ url: fileUrl }).promise;
  let firstTarget = null;

  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    const viewport = page.getViewport({ scale: 1.4 });
    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrap.appendChild(canvas);
    pagesEl.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const ph = byPage.get(num);
    if (ph) {
      const fx = viewport.width / ph.width;
      const fy = viewport.height / ph.height;
      for (const r of ph.rects) {
        const div = document.createElement('div');
        div.className = 'hl';
        const top = FLIP_Y ? (ph.height - r.y - r.h) : r.y;
        div.style.left = `${r.x * fx}px`;
        div.style.top = `${top * fy}px`;
        div.style.width = `${r.w * fx}px`;
        div.style.height = `${r.h * fy}px`;
        wrap.appendChild(div);
        if (!firstTarget) { div.classList.add('target'); firstTarget = div; }
      }
    }
  }

  pagesEl.removeAttribute('aria-busy');

  // Repli : aucun surlignage localisé -> afficher les passages cités en clair.
  if (!firstTarget && (highlights.citedText || []).length) {
    const notice = document.getElementById('notice');
    notice.hidden = false;
    const intro = document.createTextNode('Passage non localisé automatiquement. Passages cités :');
    const ul = document.createElement('ul');
    for (const t of highlights.citedText) {
      const li = document.createElement('li');
      li.textContent = t.slice(0, 300);
      ul.appendChild(li);
    }
    notice.appendChild(intro);
    notice.appendChild(ul);
  } else if (firstTarget) {
    firstTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

main().catch((err) => {
  document.getElementById('pages').textContent = 'Impossible d\'afficher le document.';
  console.error(err);
});
