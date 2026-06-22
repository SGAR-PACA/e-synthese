// mastra/src/routes/sources.ts
import { registerApiRoute } from '@mastra/core/server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireSourceSession } from './sources-auth.js';
import { verifySourceToken } from '../lib/source-token.js';
import { getDocumentFileByAlbertId, logAudit, type DocumentFile } from '../lib/db.js';
import { getPdfStream } from '../lib/storage.js';
import { getDocumentChunks } from '../lib/albert-client.js';
import { computeHighlights } from '../lib/highlight.js';
import { parseUsedParam, splitIntoSearchPhrases } from '../lib/highlight-text.js';
import { getClientIp } from '../lib/middleware.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkKey(): string {
  const k = process.env.MASTRA_SOURCE_LINK_KEY;
  if (!k) throw new Error('MASTRA_SOURCE_LINK_KEY manquant');
  return k;
}

// Double garde : identité (session OIDC) + capability (jeton signé) + résolution du fichier.
// Retourne soit { sub, file }, soit une Response (302/403/404/page d'attente).
async function verifyAccess(c: any): Promise<{ sub: string; file: DocumentFile } | Response> {
  const session = await requireSourceSession(c);
  if (session instanceof Response) return session;

  const documentId = c.req.param('documentId');
  const used = c.req.query('used') ?? '';
  const exp = c.req.query('exp') ?? '';
  const sig = c.req.query('sig') ?? '';
  if (!verifySourceToken(documentId, used, exp, sig, linkKey(), Date.now())) {
    return c.text('Lien invalide ou expiré.', 403);
  }

  const file = await getDocumentFileByAlbertId(documentId);
  if (!file) return c.text('Document introuvable.', 404);
  if (file.status === 'processing') return c.html(waitingPage(), 200);
  if (file.status === 'failed' || !file.s3_key_searchable) return c.text('Document indisponible.', 404);

  return { sub: session.sub, file };
}

function waitingPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Document en cours</title>
<body style="font-family:system-ui;padding:2rem">Document en cours de traitement, réessayez dans un instant.</body>`;
}

export const sourcesRoute = [
  // Page visionneuse (HTML statique générique + assets locaux).
  registerApiRoute('/v1/source/:documentId', {
    method: 'GET',
    handler: async (c) => {
      const acc = await verifyAccess(c);
      if (acc instanceof Response) return acc;
      // Audit RGPD (R4), détaché et non bloquant — jamais de contenu de document.
      void logAudit(getClientIp(c), 'SOURCE_VIEWED', undefined, `sub=${acc.sub} doc=${c.req.param('documentId')}`)
        .catch((err) => console.error('[sources] audit échec:', (err as Error).message));
      const file = join(viewerDir(), 'viewer.html');
      if (!existsSync(file)) {
        // Assets visionneuse non déployés -> 503 contrôlée (pas de crash 500).
        return new Response('Visionneuse indisponible.', { status: 503 });
      }
      const html = readFileSync(file, 'utf8').replaceAll('{{TITLE}}', escapeHtml(acc.file.filename));
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...VIEWER_CSP } });
    },
  }),

  // Proxy du PDF depuis Scaleway, avec relais des Range requests (pdf.js charge par page).
  registerApiRoute('/v1/source/:documentId/file', {
    method: 'GET',
    handler: async (c) => {
      const acc = await verifyAccess(c);
      if (acc instanceof Response) return acc;
      const range = c.req.header('range');
      const s3 = await getPdfStream(acc.file.s3_key_searchable!, range);
      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      };
      if (s3.contentLength != null) headers['Content-Length'] = String(s3.contentLength);
      if (s3.contentRange) headers['Content-Range'] = s3.contentRange;
      return new Response(s3.body, { status: s3.contentRange ? 206 : 200, headers });
    },
  }),

  // Zones de surlignage (JSON) : texte des chunks cités -> phrases -> quads via mupdf.
  registerApiRoute('/v1/source/:documentId/highlights', {
    method: 'GET',
    handler: async (c) => {
      const acc = await verifyAccess(c);
      if (acc instanceof Response) return acc;
      const documentId = c.req.param('documentId');
      const usedIds = new Set(parseUsedParam(c.req.query('used')));
      try {
        const allChunks = await getDocumentChunks(documentId);
        const cited = allChunks.filter((ch) => usedIds.has(ch.id));
        const phrases = cited.flatMap((ch) => splitIntoSearchPhrases(ch.content));
        const citedText = cited.map((ch) => ch.content);
        if (phrases.length === 0) return c.json({ pages: [], citedText });
        const s3 = await getPdfStream(acc.file.s3_key_searchable!);
        const bytes = new Uint8Array(await new Response(s3.body).arrayBuffer());
        const pages = computeHighlights(bytes, phrases);
        return c.json({ pages, citedText });
      } catch (err) {
        console.error('[sources] highlights échec:', (err as Error).message);
        return c.json({ pages: [], citedText: [] });
      }
    },
  }),
];

// --- Service des assets de la visionneuse (allowlist, anti path-traversal) ---
const VIEWER_FILES: Record<string, string> = {
  'viewer.html': 'text/html; charset=utf-8',
  'viewer.js': 'application/javascript',
  'viewer.css': 'text/css',
  'pdf.mjs': 'application/javascript',
  'pdf.worker.mjs': 'application/javascript',
};

function viewerDir(): string {
  const candidates = [
    join(process.cwd(), 'public', 'source'),
    join(process.cwd(), '..', '..', '..', 'public', 'source'),
    join(process.cwd(), '..', '..', 'public', 'source'),
  ];
  for (const d of candidates) if (existsSync(join(d, 'viewer.html'))) return d;
  return candidates[0];
}

// CSP stricte : tout en self ; wasm pour mupdf n'est pas chargé côté client (mupdf est serveur),
// mais pdf.js a besoin de 'wasm-unsafe-eval' pour son moteur.
const VIEWER_CSP = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

export const sourcesAssetsRoute = Object.keys(VIEWER_FILES).map((name) =>
  registerApiRoute(`/v1/source/assets/${name}`, {
    method: 'GET',
    handler: async () => {
      const full = join(viewerDir(), name);
      if (!existsSync(full)) return new Response('Not Found', { status: 404 });
      return new Response(readFileSync(full, 'utf8'), {
        headers: { 'Content-Type': VIEWER_FILES[name], ...VIEWER_CSP },
      });
    },
  }),
);
