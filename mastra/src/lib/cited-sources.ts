import { verifySourceToken } from './source-token.js';

export interface CitedSource {
  documentId: string;
  chunkIds: string[];
  href: string;
}

// Repère les liens de sources : /v1/source/{documentId}?{query} (s'arrête à ) ou espace).
const LINK_RE = /\/v1\/source\/([^?\s)]+)\?([^)\s]+)/g;

// Extrait les sources citées d'une réponse stockée, en ne gardant que les liens
// dont la signature Mastra est valide (donc réellement émis lors de la génération).
export function parseCitedSources(answer: string, key: string, now: number): CitedSource[] {
  const out: CitedSource[] = [];
  const seen = new Set<string>();
  if (!answer) return out;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(answer)) !== null) {
    const rawDoc = m[1];
    const rawQuery = m[2].replace(/&amp;/g, '&');
    const documentId = decodeURIComponent(rawDoc);
    const qs = new URLSearchParams(rawQuery);
    const used = qs.get('used') ?? '';
    const exp = qs.get('exp') ?? '';
    const sig = qs.get('sig') ?? '';
    if (!verifySourceToken(documentId, used, exp, sig, key, now)) continue;
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    const chunkIds = used ? used.split(',').map((s) => s.trim()).filter(Boolean) : [];
    out.push({ documentId, chunkIds, href: `/v1/source/${rawDoc}?${rawQuery}` });
  }
  return out;
}
