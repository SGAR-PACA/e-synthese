import { Agent } from '@mastra/core/agent';
import { searchTool } from '../tools/search.js';
import { rerankTool } from '../tools/rerank.js';
import { getConfig } from '../../lib/config.js';
import { resolveRagSystemPrompt } from '../pipeline/system-prompt.js';

// Agent historique conservé pour Mastra Studio. Il partage exactement le même
// prompt configurable que le rédacteur du pipeline : aucune instruction cachée
// n'est ajoutée au texte enregistré depuis l'admin.
export const ragAgent = new Agent({
  id: 'rag-agent',
  name: 'E-Synthèse RAG Agent',
  instructions: resolveRagSystemPrompt,
  model: async () => {
    const model = (await getConfig()).llmModel || 'openweight-large';
    return `albert/albert/${model}` as any;
  },
  tools: { searchTool, rerankTool },
});
