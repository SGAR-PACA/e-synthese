import { DEFAULT_RAG_SYSTEM_PROMPT, getConfig } from '../../lib/config.js';

// Unique source du prompt système utilisé pour rédiger les réponses RAG.
// Son contenu est persisté dans la configuration et modifiable depuis Mastra Admin.
export async function resolveRagSystemPrompt(): Promise<string> {
  const config = await getConfig();
  return config.ragPromptTemplate.trim() || DEFAULT_RAG_SYSTEM_PROMPT;
}
