// mastra/src/lib/sources-linker.ts
import type { RagChunk } from './db.js';

export type SignFn = (documentId: string, chunkIds: string[]) => string;

// Ligne « - Source N : *nom* » (forme italique) OU « - Source N : [nom](url) » (URL Albert réelle).
// Les deux formes sont maintenant réécrites en lien signé pour empêcher tout contournement
// du dispositif anti-énumération.
const SOURCE_LINE = /^(\s*-\s*Source\s+\d+\s*:\s*)(?:\*(.+?)\*|\[(.+?)\]\([^)]*\))\s*$/;

// Échappe les caractères qui casseraient le texte d'un lien Markdown.
function escapeLinkText(name: string): string {
  return name
    .replace(/[\\`*_{}\[\]]/g, (ch) => '\\' + ch) // échappe les métacaractères Markdown
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'); // neutralise le HTML inline
}

interface NameEntry { documentId: string; chunkIds: string[] }

function indexByName(usedChunks: RagChunk[]): Map<string, NameEntry> {
  const byName = new Map<string, NameEntry>();
  for (const ch of usedChunks) {
    if (!ch.documentId) continue;
    const entry = byName.get(ch.name) ?? { documentId: ch.documentId, chunkIds: [] };
    if (entry.documentId !== ch.documentId) continue; // homonyme d'un autre document -> on n'agrège pas (évite un lien corrompu)
    if (ch.chunkId && !entry.chunkIds.includes(ch.chunkId)) entry.chunkIds.push(ch.chunkId);
    byName.set(ch.name, entry);
  }
  return byName;
}

export function injectSourceLinks(
  answer: string,
  usedChunks: RagChunk[],
  sign: SignFn,
): string {
  const byName = indexByName(usedChunks);
  if (byName.size === 0) return answer;
  return answer
    .split('\n')
    .map((line) => {
      const m = line.match(SOURCE_LINE);
      if (!m) return line;
      const prefix = m[1];
      const name = m[2] ?? m[3]; // *nom* (groupe 2) OU [nom](url) (groupe 3)
      const entry = byName.get(name);
      if (!entry) return line;
      const query = sign(entry.documentId, entry.chunkIds);
      return `${prefix}[${escapeLinkText(name)}](/v1/source/${encodeURIComponent(entry.documentId)}?${query})`;
    })
    .join('\n');
}

// --- Streaming : sépare le corps (émis au fil de l'eau) du bloc Sources (réécrit en fin) ---
export const SOURCES_MARKER = '\n\n**Sources';

export function buildSourcesBlock(usedChunks: RagChunk[]): string {
  const names: string[] = [];
  for (const chunk of usedChunks) {
    const name = chunk.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return '';
  return `**Sources :**\n${names.map((name, index) => `- Source ${index + 1} : *${name}*`).join('\n')}`;
}

// Filet déterministe : le prompt demande toujours le bloc Sources, mais un LLM
// peut l'omettre. Les passages retenus par le pipeline sont connus, donc on
// ajoute un bloc minimal si nécessaire au lieu de livrer une réponse non sourcée.
export function ensureSourcesBlock(answer: string, usedChunks: RagChunk[]): string {
  if (/(?:^|\n\n)\*\*Sources\s*:\*\*(?:\n|$)/.test(answer)) return answer;
  const block = buildSourcesBlock(usedChunks);
  return block ? `${answer.trimEnd()}\n\n${block}` : answer;
}

export function createSourcesStreamSplitter(): {
  push(delta: string): string;
  finalize(rewrite: (block: string) => string): string;
  readonly sawSources: boolean;
} {
  let buffer = '';
  let found = false;
  const holdback = SOURCES_MARKER.length - 1;
  return {
    push(delta: string): string {
      buffer += delta;
      if (found) return '';
      const idx = buffer.indexOf(SOURCES_MARKER);
      if (idx >= 0) {
        found = true;
        const body = buffer.slice(0, idx);
        buffer = buffer.slice(idx); // conserve le bloc Sources pour finalize
        return body;
      }
      // Retient les derniers (holdback) caractères au cas où le marqueur soit en cours d'arrivée.
      if (buffer.length <= holdback) return '';
      const emit = buffer.slice(0, buffer.length - holdback);
      buffer = buffer.slice(buffer.length - holdback);
      return emit;
    },
    finalize(rewrite: (block: string) => string): string {
      if (found) {
        const out = rewrite(buffer);
        buffer = '';
        return out;
      }
      const out = buffer; // pas de bloc Sources : on émet le reste tel quel
      buffer = '';
      return out;
    },
    get sawSources() {
      return found;
    },
  };
}
