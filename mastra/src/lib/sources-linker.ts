// mastra/src/lib/sources-linker.ts
import type { RagChunk } from './db.js';

export type SignFn = (documentId: string, chunkIds: string[]) => string;

// --- Normalisation des noms de document ---
// L'IA recopie le nom du fichier et le déforme parfois de façon invisible (tiret insécable,
// espace zéro-largeur, apostrophe typographique…), et les fichiers venus de macOS sont en NFD.
// La même normalisation sert au nom montré à l'IA (writer) et à la comparaison ci-dessous.
const DASHES = /[‐-―−﹘﹣－]/g;
const APOSTROPHES = /[‘’‛ʼ′]/g;
const INVISIBLES = /\p{Cf}/gu; // espace zéro-largeur, trait d'union conditionnel, BOM…

export function normaliserNom(name: string): string {
  return name
    .normalize('NFKC') // NFD → NFC, espaces insécables → espace
    .replace(INVISIBLES, '')
    .replace(DASHES, '-')
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Échappements Markdown ajoutés par l'IA dans le nom (« 2025\_01 » → « 2025_01 »).
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
}

// Ligne « - Source N : … » ; puce -, * ou •, ou numérotation « 1. » / « 1) ».
const SOURCE_LINE = /^(\s*(?:[-*•]|\d+[.)])\s*Source\s+\d+\s*:\s*)(.*?)\s*$/;
// Formes possibles du nom, de la plus balisée à la plus brute. Le groupe 2 est le texte
// qui suit le nom (ex. « (déjà cité) »), conservé tel quel après le lien.
// Toute forme [nom](url) est réécrite en lien signé (anti-énumération).
const NAME_FORMS = [
  /^\[(.+?)\]\([^)]*\)(.*)$/,
  /^\*\*(.+?)\*\*(.*)$/,
  /^\*(.+?)\*(.*)$/,
  /^_(.+)_(.*)$/, // gourmand : les noms de fichiers contiennent souvent des underscores
  /^(.+)()$/,
  /^(.+?)(\s*\([^()]*\))$/, // nom brut + « (déjà cité) », essayé après le nom complet (« Note (V2).pdf »)
];

// Échappe les caractères qui casseraient le texte d'un lien Markdown.
function escapeLinkText(name: string): string {
  return name
    .replace(/[\\`*_{}\[\]]/g, (ch) => '\\' + ch) // échappe les métacaractères Markdown
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'); // neutralise le HTML inline
}

interface NameEntry { name: string; documentId: string; chunkIds: string[] }

function indexByName(usedChunks: RagChunk[]): Map<string, NameEntry> {
  const byName = new Map<string, NameEntry>();
  for (const ch of usedChunks) {
    if (!ch.documentId) continue;
    const key = normaliserNom(ch.name);
    const entry = byName.get(key) ?? { name: ch.name, documentId: ch.documentId, chunkIds: [] };
    if (entry.documentId !== ch.documentId) continue; // homonyme d'un autre document -> on n'agrège pas (évite un lien corrompu)
    if (ch.chunkId && !entry.chunkIds.includes(ch.chunkId)) entry.chunkIds.push(ch.chunkId);
    byName.set(key, entry);
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
      const [, prefix, rest] = m;
      for (const form of NAME_FORMS) {
        const f = rest.match(form);
        if (!f) continue;
        const entry = byName.get(normaliserNom(unescapeMarkdown(f[1])));
        if (!entry) continue;
        const query = sign(entry.documentId, entry.chunkIds);
        // Texte du lien = vrai nom du fichier, jamais la variante recopiée par l'IA.
        return `${prefix}[${escapeLinkText(entry.name)}](/v1/source/${encodeURIComponent(entry.documentId)}?${query})${f[2]}`;
      }
      return line;
    })
    .join('\n');
}

// --- En-tête du bloc Sources ---
// Seul sur sa ligne, quelle que soit la mise en forme choisie par l'IA :
// « **Sources :** », « **Sources** », « Sources : », « ### Sources »…
// « **Sources officielles** sont nombreuses » n'en est pas un.
function isSourcesHeading(line: string): boolean {
  return line.replace(/[#*:\s]/g, '').toLowerCase() === 'sources';
}

// Début de ligne partiel (streaming) qui pourrait encore devenir un en-tête Sources.
function couldBecomeSourcesHeading(partial: string): boolean {
  return 'sources'.startsWith(partial.replace(/[#*:\s]/g, '').toLowerCase());
}

// Position du début de la ligne d'en-tête du bloc Sources, ou -1.
export function findSourcesBlockStart(text: string): number {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (isSourcesHeading(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

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
  if (findSourcesBlockStart(answer) >= 0) return answer;
  const block = buildSourcesBlock(usedChunks);
  return block ? `${answer.trimEnd()}\n\n${block}` : answer;
}

// --- Streaming : sépare le corps (émis au fil de l'eau) du bloc Sources (réécrit en fin) ---
// Un en-tête ne se juge que sur une ligne complète ; un début de ligne qui pourrait encore
// en devenir un (« **Sou ») est retenu, tout le reste est émis immédiatement.
export function createSourcesStreamSplitter(): {
  push(delta: string): string;
  finalize(rewrite: (block: string) => string): string;
  readonly sawSources: boolean;
} {
  let buffer = ''; // texte pas encore émis
  let midLine = false; // buffer commence au milieu d'une ligne déjà en partie émise
  let found = false;

  // Découpe le buffer : renvoie le corps à émettre et garde le reste.
  // atEnd = fin du flux : la dernière ligne compte comme complète.
  const split = (atEnd: boolean): string => {
    const lines = buffer.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const complete = atEnd || i < lines.length - 1;
      if (!(i === 0 && midLine)) {
        if (complete && isSourcesHeading(line)) {
          found = true;
          const body = buffer.slice(0, offset);
          buffer = buffer.slice(offset); // conserve le bloc Sources pour finalize
          return body;
        }
        if (!complete && couldBecomeSourcesHeading(line)) {
          const body = buffer.slice(0, offset);
          buffer = buffer.slice(offset);
          midLine = false;
          return body;
        }
      }
      offset += line.length + 1;
    }
    const body = buffer;
    buffer = '';
    if (body) midLine = !body.endsWith('\n');
    return body;
  };

  return {
    push(delta: string): string {
      buffer += delta;
      return found ? '' : split(false);
    },
    finalize(rewrite: (block: string) => string): string {
      const body = found ? '' : split(true);
      const out = found ? body + rewrite(buffer) : body; // pas de bloc Sources : on émet le reste tel quel
      buffer = '';
      return out;
    },
    get sawSources() {
      return found;
    },
  };
}
