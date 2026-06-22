import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { requireApiKey } from '../lib/middleware.js';
import { getProxyApiKey } from '../lib/api-key.js';
import { scoreRun } from '../mastra/scorers/run.js';
import { contentToText } from '../lib/openai-content.js';
import { planifier } from '../mastra/pipeline/planner.js';
import { rechercherMultiple } from '../mastra/pipeline/retrieval.js';
import { construirePromptRedaction } from '../mastra/pipeline/writer.js';
import type { AppConfig } from '../lib/config.js';
import type { RagChunk } from '../lib/db.js';

const MAX_TOKENS_CAP = 4096;

getProxyApiKey();

// Union discriminée (un membre par rôle) pour rester assignable au type de
// messages attendu par l'agent Mastra (`MessageListInput`), sans cast `as any`.
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

// SSE : `X-Accel-Buffering: no` demande aux proxies (nginx) de NE PAS mettre le
// flux en mémoire tampon — sinon la réponse arrive d'un bloc à la fin.
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export const chatCompletionsRoute = [
  registerApiRoute('/v1/chat/completions', {
    method: 'POST',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;
      const body = await c.req.json();
      const { messages = [], stream = false, temperature, max_tokens } = body as {
        messages: OpenAIMessage[];
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        return c.json({ error: 'messages is required and must be a non-empty array' }, 400);
      }

      // Filtrer les messages placeholder envoyés par certains clients (Albert
      // Conversation envoie un { role: "assistant", content: null } final qu'il
      // compte remplir au fil du streaming). Mastra refuse ces messages comme
      // invalides — on les retire avant de les transmettre à l'agent.
      const cleanedMessages = messages.filter((m) => {
        if (m.role !== 'assistant') return true;
        const ct = m.content;
        return ct !== null && ct !== undefined && ct !== '';
      });

      if (cleanedMessages.length === 0) {
        return c.json({ error: 'messages is required and must contain at least one non-placeholder message' }, 400);
      }

      const modelOptions: { temperature?: number; maxOutputTokens?: number } = {};
      if (temperature !== undefined) modelOptions.temperature = temperature;
      if (max_tokens !== undefined) {
        const parsed = Number(max_tokens);
        if (Number.isFinite(parsed) && parsed > 0) {
          modelOptions.maxOutputTokens = Math.min(Math.floor(parsed), MAX_TOKENS_CAP);
        }
      }

      const config = await getConfig();
      const model = config.llmModel || 'albert-large';
      const modelId = `albert/albert/${model}`;

      const question = lastUserText(cleanedMessages);
      const planner = c.get('mastra').getAgent('plannerAgent');
      const writer = c.get('mastra').getAgent('writerAgent');

      // Température : forcée à la valeur basse par défaut si le client n'en fournit pas.
      const writerSettings = {
        temperature: modelOptions.temperature ?? config.temperature,
        maxOutputTokens: modelOptions.maxOutputTokens,
      };

      // ───────────── Mode streaming ─────────────
      if (stream) {
        const sseStream = pipelineSSE({ question, planner, writer, writerSettings, config, model });
        return new Response(sseStream, { headers: SSE_HEADERS });
      }

      // ───────────── Mode non-streaming ─────────────
      const plan = await planifier(question, planner);

      // Cas direct (salutation / conversationnel) : réponse immédiate, pas de recherche, pas de notation.
      if (plan.type === 'direct') {
        return c.json(buildCompletion(modelId, model, plan.reponseDirecte, 'stop', undefined));
      }

      const { chunks } = await rechercherMultiple(plan.requetes, question);
      const result: any = await writer.generate(
        [{ role: 'user', content: construirePromptRedaction(question, chunks) }],
        { modelSettings: writerSettings },
      );
      const answer = stripCitationBrackets(result.text ?? '');
      maybeScoreLive(question, chunks, answer, config, model);
      return c.json(buildCompletion(modelId, model, answer, result.finishReason || 'stop', result.usage));
    },
  }),
];

// Construit une réponse OpenAI `chat.completion` (mode non-stream).
function buildCompletion(modelId: string, _model: string, content: string, finishReason: string, usage: any) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    },
  };
}

// Filet de sécurité : supprime les marqueurs de citation 【...】 que GPT-style
// models continuent parfois à émettre malgré l'interdiction explicite dans le
// prompt système. Le format `Source N : nom` est imposé en bloc final.
function stripCitationBrackets(text: string): string {
  return text.replace(/【[^】]*】/g, '');
}

// Variante streaming : machine à états char-par-char pour gérer le cas où
// `【` et `】` arrivent dans des deltas SSE différents.
function createBracketStripper(): (delta: string) => string {
  let suppressing = false;
  return (delta: string) => {
    let out = '';
    for (const ch of delta) {
      if (suppressing) {
        if (ch === '】') suppressing = false;
        continue;
      }
      if (ch === '【') {
        suppressing = true;
        continue;
      }
      out += ch;
    }
    return out;
  };
}

// Dernier message utilisateur (la question à traiter / noter).
function lastUserText(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return contentToText(messages[i].content);
  }
  return '';
}

// Notation LIVE : échantillonnée, détachée, JAMAIS bloquante ni propagatrice d'erreur.
// Reçoit directement les chunks utilisés (le pipeline déterministe les connaît).
function maybeScoreLive(question: string, usedChunks: RagChunk[], answer: string, config: AppConfig, genModel: string): void {
  if (Math.random() >= (config.evalSamplingRate ?? 0)) return;
  const cleanAnswer = stripCitationBrackets(answer);
  if (!question || !cleanAnswer) return;
  void scoreRun({ question, answer: cleanAnswer, usedChunks, source: 'live', genModel })
    .catch((err) => console.error('[eval] scoring live échoué:', err?.message || err));
}

interface PipelineSSEArgs {
  question: string;
  planner: any;
  writer: any;
  writerSettings: { temperature: number; maxOutputTokens?: number };
  config: AppConfig;
  model: string;
}

// Orchestre les 3 étapes À L'INTÉRIEUR du flux SSE : chaque étape émet son
// libellé de progression (compartiment "réflexion") juste avant l'opération
// lente, puis le rédacteur streame la réponse mot à mot.
function pipelineSSE(args: PipelineSSEArgs): ReadableStream<Uint8Array> {
  const { question, planner, writer, writerSettings, config, model } = args;
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, delta: any, finishReason: string | null = null) => {
    const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };
  const etape = (controller: ReadableStreamDefaultController<Uint8Array>, label: string) => {
    // Étape nommée dans le compartiment "réflexion" (convention reasoning_content).
    // L'affichage dépend du front (à vérifier en réel) ; au minimum, maintient le flux vivant.
    send(controller, { reasoning_content: `${label}\n` });
  };

  return new ReadableStream({
    async start(controller) {
      try {
        send(controller, { role: 'assistant' });

        etape(controller, 'Analyse de la question…');
        const plan = await planifier(question, planner);

        // Cas direct : réponse immédiate, pas de recherche.
        if (plan.type === 'direct') {
          send(controller, { content: plan.reponseDirecte });
          send(controller, {}, 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }

        etape(controller, 'Recherche dans les documents…');
        const { chunks } = await rechercherMultiple(plan.requetes, question);

        etape(controller, 'Rédaction de la réponse…');
        const result: any = await writer.stream(
          [{ role: 'user', content: construirePromptRedaction(question, chunks) }],
          { modelSettings: writerSettings },
        );

        const stripper = createBracketStripper();
        let fullText = '';
        for await (const delta of result.textStream) {
          const cleaned = stripper(delta);
          fullText += cleaned;
          if (cleaned.length === 0) continue;
          send(controller, { content: cleaned });
        }

        send(controller, {}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        // Notation live après coup (texte complet connu), détachée et non bloquante.
        maybeScoreLive(question, chunks, fullText, config, model);
      } catch (err: any) {
        send(controller, { content: `[error: ${err?.message || 'stream failed'}]` }, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
      }
    },
  });
}
