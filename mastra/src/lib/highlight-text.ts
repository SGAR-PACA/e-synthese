export function parseUsedParam(used: string | null | undefined): string[] {
  if (!used) return [];
  return used
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]{1,128}$/.test(s))
    .slice(0, 64);
}

// Découpe le contenu d'un chunk en phrases recherchables dans le PDF.
//
// Point clé (constaté sur données réelles) : le contenu des chunks Albert est du
// MARKDOWN (titres `#`, `**gras**`, `[liens](url)`, tableaux `|`), alors que la
// couche texte du PDF est du texte BRUT. Chercher tel quel « **Tom GOURDON** »
// échoue car les `*`/`#` n'existent pas dans le PDF -> ~40 % des phrases perdues.
// On normalise donc vers le texte brut avant la recherche.
export function splitIntoSearchPhrases(content: string): string[] {
  const out: string[] = [];
  for (let line of content.split(/\n+/)) {
    // 1. marqueurs de bloc en tête de ligne : titres, citations, puces, listes num.
    line = line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/, '');
    // 2. inline : [texte](url) / ![alt](url) -> texte ; retirer emphase et code.
    line = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]+/g, '');
    // 3. colonnes / cellules de tableau (| ou espaces multiples) : dans le PDF ce
    //    sont des blocs visuels séparés, non contigus -> les chercher séparément.
    for (const cell of line.split(/\s*\|\s*|\s{2,}/)) {
      // 4. découper la cellule en phrases.
      for (let sent of cell.split(/(?<=[.!?])\s+/)) {
        sent = sent.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
        const words = sent.split(' ').filter(Boolean).length;
        // ≥12 caractères ET (≥2 mots OU ≥20 caractères) : évite les mots isolés
        // génériques (ex. « expérimentation ») qui matchent plusieurs endroits.
        if (sent.length >= 12 && (words >= 2 || sent.length >= 20)) out.push(sent);
      }
    }
  }
  return [...new Set(out)].slice(0, 60);
}

// QuadPoint mupdf = [ulx,uly,urx,ury,llx,lly,lrx,lry] -> rectangle englobant.
export function rectFromQuad(quad: number[]): { x: number; y: number; w: number; h: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
