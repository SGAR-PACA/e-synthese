// mastra/public/source/viewer.js
import * as pdfjsLib from '/v1/source/assets/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/v1/source/assets/pdf.worker.mjs';

const path = location.pathname; // /v1/source/{documentId}
const search = location.search; // ?used=..&exp=..&sig=..
const fileUrl = `${path}/file${search}`;
const highlightsUrl = `${path}/highlights${search}`;

async function main() {
  const pagesEl = document.getElementById('pages');
  let highlights = { pages: [], citedText: [], highlightStatus: 'unavailable' };
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
    if (ph && ph.coordinateSpace === 'pdf-user' && Array.isArray(ph.pdfBounds)) {
      for (const r of ph.rects) {
        // Les ancres sont en PDF user space. PDF.js connaît la CropBox, le
        // UserUnit et la rotation de la page : sa conversion évite les
        // hypothèses fragiles de simple mise à l'échelle/flip vertical.
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
          r.x,
          r.y,
          r.x + r.w,
          r.y + r.h,
        ]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
        const div = document.createElement('div');
        div.className = 'hl';
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
        wrap.appendChild(div);
        if (!firstTarget) { div.classList.add('target'); firstTarget = div; }
      }
    }
  }

  pagesEl.removeAttribute('aria-busy');

  const notice = document.getElementById('notice');
  if (highlights.highlightStatus === 'partial') {
    notice.hidden = false;
    notice.appendChild(document.createTextNode('Surlignage partiel : certains passages n’ont pas pu être localisés avec certitude.'));
  } else if (highlights.highlightStatus === 'unavailable') {
    notice.hidden = false;
    notice.appendChild(document.createTextNode('Surlignage indisponible pour ce document : le PDF reste consultable sans zone approximative.'));
  }

  // Repli : aucun surlignage localisé -> afficher les passages cités en clair.
  if (!firstTarget && (highlights.citedText || []).length) {
    notice.hidden = false;
    const intro = document.createTextNode('Passages cités non localisés automatiquement :');
    notice.appendChild(intro);
    const ul = document.createElement('ul');
    for (const t of highlights.citedText) {
      const li = document.createElement('li');
      li.textContent = t.slice(0, 300);
      ul.appendChild(li);
    }
    notice.appendChild(ul);
  } else if (firstTarget) {
    firstTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

main().catch((err) => {
  document.getElementById('pages').textContent = 'Impossible d\'afficher le document.';
  console.error(err);
});
