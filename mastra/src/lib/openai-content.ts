// Aplatissement du `content` d'un message OpenAI en texte brut (module PUR, testable).
//
// Le front (Albert Conversation) envoie le content au format structuré
// `[{ type: 'text', text: '…' }]`, pas une simple chaîne. Sans cet aplatissement, la
// question transmise à la notation était un tableau JSON sérialisé — illisible — et
// cassait `fallbackSearch` (requête Albert = tableau → 0 chunk → court-circuit
// silencieux : les réponses du front n'étaient jamais notées dans /admin/eval).

export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}
