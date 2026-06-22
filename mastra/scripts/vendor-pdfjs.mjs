// Copie les fichiers pdf.js nécessaires dans public/source (servis en asset local, souverain).
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dest = join(root, '..', 'public', 'source');
mkdirSync(dest, { recursive: true });
const base = join(root, '..', 'node_modules', 'pdfjs-dist', 'build');
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
  const src = join(base, f);
  if (existsSync(src)) copyFileSync(src, join(dest, f));
  else console.warn('[vendor-pdfjs] introuvable:', src);
}
console.log('[vendor-pdfjs] pdf.js copié dans public/source');
