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
import { verifyForwardedUserToken } from '../lib/chat-auth.js';
import { extractGroups, resolveAllowedCollections } from '../lib/collection-scope.js';
import type { AppConfig } from '../lib/config.js';
import type { RagChunk } from '../lib/db.js';
import { getDocumentFileByFilename } from '../lib/db.js';
import { injectSourceLinks, createSourcesStreamSplitter, SOURCES_MARKER, type SignFn } from '../lib/sources-linker.js';
import { isRefusal } from '../mastra/scorers/refusal.js';
import { signSourceToken } from '../lib/source-token.js';
import { answerContentTokens } from '../lib/highlight-align.js';

// Lie un signeur seulement si la clé est configurée ; sinon pas de liens (dégradation douce).
function sourceSigner(): SignFn | undefined {
  if (!process.env.MASTRA_SOURCE_LINK_KEY) return undefined;
  return (documentId, chunkIds) => signSourceToken(documentId, chunkIds);
}

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

      // Chantier 2 — cloisonnement par groupe. Le token de l'utilisateur final
      // (transmis par Django via `X-User-Token`) détermine les collections
      // autorisées. Absent → 401 (fail-closed), SAUF mode transition explicite
      // (`MASTRA_REQUIRE_USER_TOKEN=false`) → `null` = non restreint. Invalide → 401.
      // `null` = non restreint (transition/admin) ; tableau = restreint à ces collections.
      const userToken = await verifyForwardedUserToken(c);
      if (userToken instanceof Response) return userToken;
      let allowedCollections: number[] | null = null;
      if (userToken) {
        allowedCollections = await resolveAllowedCollections(extractGroups(userToken));
      }

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
        const sseStream = pipelineSSE({ question, planner, writer, writerSettings, config, model, allowedCollections });
        return new Response(sseStream, { headers: SSE_HEADERS });
      }

      // ───────────── Mode non-streaming ─────────────
      const plan = await planifier(question, planner);

      // Cas direct (salutation / conversationnel) : réponse immédiate, pas de recherche, pas de notation.
      if (plan.type === 'direct') {
        return c.json(buildCompletion(modelId, model, plan.reponseDirecte, 'stop', undefined));
      }

      const { chunks } = await rechercherMultiple(plan.requetes, question, allowedCollections);
      await remapDocumentIds(chunks);
      const result: any = await writer.generate(
        [{ role: 'user', content: construirePromptRedaction(question, chunks) }],
        { modelSettings: writerSettings },
      );
      const clean = stripCitationBrackets(result.text ?? '');
      // Notation : sur la version SANS liens (format Sources préservé pour le scorer).
      maybeScoreLive(question, chunks, clean, config, model);
      const sign = sourceSigner();
      // Pas de bloc Sources si la réponse n'est pas fondée sur des documents (rien trouvé / refus).
      const display = shouldSuppressSources(clean, chunks) ? stripSourcesBlock(clean) : clean;
      const answer = sign ? injectSourceLinks(display, chunks, sign, answerContentTokens(display)) : display;
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

// Albert expose deux espaces d'ID : le `document_id` renvoyé par la RECHERCHE
// diffère de l'ID d'UPLOAD stocké (albert_document_id). Pour que la visionneuse
// retrouve le PDF, on remappe l'ID de chaque chunk vers l'ID stocké, via le NOM
// du document. Cache par nom (peu de documents distincts par réponse). Les docs
// sans ligne document_files (legacy) restent inchangés (non servables de toute façon).
async function remapDocumentIds(chunks: RagChunk[]): Promise<void> {
  const cache = new Map<string, string | null>();
  for (const ch of chunks) {
    if (!ch.name) continue;
    if (!cache.has(ch.name)) {
      try {
        const f = await getDocumentFileByFilename(ch.name);
        cache.set(ch.name, f?.albert_document_id ?? null);
      } catch (err) {
        console.error('[sources] remap ID échoué:', (err as Error).message);
        cache.set(ch.name, null);
      }
    }
    const mapped = cache.get(ch.name);
    if (mapped) ch.documentId = mapped;
  }
}

// Retire le bloc « Sources » final d'une réponse (tout ce qui suit le marqueur).
function stripSourcesBlock(text: string): string {
  const idx = text.indexOf(SOURCES_MARKER);
  return idx >= 0 ? text.slice(0, idx).trimEnd() : text;
}

// Faut-il masquer le bloc Sources ? Oui si aucune source réelle : rien trouvé
// (aucun chunk) OU réponse de refus/négative (« ne contiennent pas… »). Dans ces
// cas les « sources » citées ne sont que les chunks consultés, pas des références utiles.
function shouldSuppressSources(answer: string, chunks: RagChunk[]): boolean {
  return chunks.length === 0 || isRefusal(answer);
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
  allowedCollections: number[] | null;
}

// Orchestre les 3 étapes À L'INTÉRIEUR du flux SSE : chaque étape émet son
// libellé de progression (compartiment "réflexion") juste avant l'opération
// lente, puis le rédacteur streame la réponse mot à mot.
function pipelineSSE(args: PipelineSSEArgs): ReadableStream<Uint8Array> {
  const { question, planner, writer, writerSettings, config, model, allowedCollections } = args;
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
        const { chunks } = await rechercherMultiple(plan.requetes, question, allowedCollections);
        await remapDocumentIds(chunks);

        etape(controller, 'Rédaction de la réponse…');
        const result: any = await writer.stream(
          [{ role: 'user', content: construirePromptRedaction(question, chunks) }],
          { modelSettings: writerSettings },
        );

        const stripper = createBracketStripper();
        const splitter = createSourcesStreamSplitter();
        const sign = sourceSigner();
        let fullText = '';
        for await (const delta of result.textStream) {
          const cleaned = stripper(delta);
          if (cleaned.length === 0) continue;
          fullText += cleaned;
          const emit = splitter.push(cleaned);
          if (emit.length > 0) send(controller, { content: emit });
        }
        // Bloc Sources final : réécrit en liens signés (ou tel quel si pas de clé).
        // Les jetons proviennent du corps COMPLET de la réponse (fullText), pas du seul
        // bloc Sources -> le surlignage ne cible que ce que l'IA a réellement écrit.
        const answerTokens = answerContentTokens(fullText);
        // Pas de bloc Sources si la réponse n'est pas fondée sur des documents (rien trouvé / refus).
        const suppress = shouldSuppressSources(fullText, chunks);
        const tail = splitter.finalize((block) =>
          suppress ? '' : sign ? injectSourceLinks(block, chunks, sign, answerTokens) : block,
        );
        if (tail.length > 0) send(controller, { content: tail });

        send(controller, {}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        // Notation live sur le texte complet NON lié (format Sources préservé).
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
