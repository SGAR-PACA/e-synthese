import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { requireApiKey } from '../lib/middleware.js';
import { getProxyApiKey } from '../lib/api-key.js';

const MAX_TOKENS_CAP = 4096;

getProxyApiKey();

// Union discriminée (un membre par rôle) pour rester assignable au type de
// messages attendu par l'agent Mastra (`MessageListInput`), sans cast `as any`.
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

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
        const c = m.content;
        return c !== null && c !== undefined && c !== '';
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

      const config = getConfig();
      const modelId = `albert/albert/${config.llmModel || 'albert-large'}`;

      // Résolution de l'agent via le registre de l'instance Mastra (issue #8),
      // au lieu d'un import direct du module. La route dépend ainsi de
      // l'instance — point d'entrée du storage, des traces et des scorers.
      const ragAgent = c.get('mastra').getAgent('ragAgent');

      if (stream) {
        const result = await ragAgent.stream(cleanedMessages, {
          modelSettings: modelOptions,
        });
        const sseStream = toOpenAISSE(result, config.llmModel || 'albert-large');
        return new Response(sseStream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      const result = await ragAgent.generate(cleanedMessages, {
        modelSettings: modelOptions,
      });

      const openAIResponse = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: stripCitationBrackets(result.text ?? '') },
            finish_reason: result.finishReason || 'stop',
          },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
      };
      return c.json(openAIResponse);
    },
  }),
];

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

function toOpenAISSE(agentStream: any, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return new ReadableStream({
    async start(controller) {
      const firstChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));

      try {
        const stripper = createBracketStripper();
        for await (const delta of agentStream.textStream) {
          const cleaned = stripper(delta);
          if (cleaned.length === 0) continue;
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        const finalChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err: any) {
        const errorChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            { index: 0, delta: { content: `[error: ${err?.message || 'stream failed'}]` }, finish_reason: 'stop' },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
      }
    },
  });
}
