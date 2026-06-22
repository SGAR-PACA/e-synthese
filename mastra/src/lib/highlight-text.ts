export function parseUsedParam(used: string | null | undefined): string[] {
  if (!used) return [];
  return used
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]{1,128}$/.test(s))
    .slice(0, 64);
}

// Découpe le contenu d'un chunk en phrases recherchables (fin de phrase ou saut de ligne).
export function splitIntoSearchPhrases(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12)
    .slice(0, 40);
}

// QuadPoint mupdf = [ulx,uly,urx,ury,llx,lly,lrx,lry] -> rectangle englobant.
export function rectFromQuad(quad: number[]): { x: number; y: number; w: number; h: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
