import { Agent } from '@mastra/core/agent';
import { getConfig } from '../../lib/config.js';
import type { RagChunk } from '../../lib/db.js';
import { resolveRagSystemPrompt } from './system-prompt.js';

export const writerAgent = new Agent({
  id: 'rag-writer',
  name: 'E-Synthèse Writer',
  instructions: resolveRagSystemPrompt,
  model: async () => {
    const model = (await getConfig()).llmModel || 'openweight-large';
    return `albert/albert/${model}` as any;
  },
});

// Construit le message utilisateur : question + passages numérotés (ou consigne "rien trouvé").
export function construirePromptRedaction(question: string, chunks: RagChunk[]): string {
  if (chunks.length === 0) {
    return `QUESTION : ${question}\n\nAucun passage pertinent n'a été trouvé dans la base documentaire. Réponds honnêtement que tu n'as pas trouvé d'information sur ce point dans les documents disponibles, sans inventer.`;
  }
  const passages = chunks
    .map((c, i) => `--- Passage ${i + 1} (source : ${c.name}) ---\n${c.content}`)
    .join('\n\n');
  return `QUESTION : ${question}\n\nPASSAGES :\n${passages}`;
}
