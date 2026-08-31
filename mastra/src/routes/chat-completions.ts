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
import { runRagCore } from '../mastra/pipeline/orchestrate.js';
import { verifyForwardedUserToken } from '../lib/chat-auth.js';
import { extractGroups, resolveAllowedCollections } from '../lib/collection-scope.js';
import type { AppConfig } from '../lib/config.js';
import type { RagChunk } from '../lib/db.js';
import { getDocumentFilesByFilename, getDocumentFileByAlbertId, insertRagRun } from '../lib/db.js';
import { pickDocumentFile } from '../lib/source-resolve.js';
import { buildSourcesBlock, injectSourceLinks, createSourcesStreamSplitter, SOURCES_MARKER, type SignFn } from '../lib/sources-linker.js';
import { isRefusal } from '../mastra/scorers/refusal.js';
import { signSourceToken } from '../lib/source-token.js';

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
      const { messages = [], stream = false, temperature, top_p, max_tokens } = body as {
        messages: OpenAIMessage[];
        stream?: boolean;
        temperature?: number;
        top_p?: number;
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

      const modelOptions: { temperature?: number; topP?: number; maxOutputTokens?: number } = {};
      if (temperature !== undefined) {
        const parsed = Number(temperature);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) modelOptions.temperature = parsed;
      }
      if (top_p !== undefined) {
        const parsed = Number(top_p);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) modelOptions.topP = parsed;
      }
      if (max_tokens !== undefined) {
        const parsed = Number(max_tokens);
        if (Number.isFinite(parsed) && parsed > 0) {
          modelOptions.maxOutputTokens = Math.min(Math.floor(parsed), MAX_TOKENS_CAP);
        }
      }

      const config = await getConfig();
      const model = config.llmModel || 'openweight-large';
      const modelId = `albert/albert/${model}`;

      const question = lastUserText(cleanedMessages);
      const planner = c.get('mastra').getAgent('plannerAgent');
      const writer = c.get('mastra').getAgent('writerAgent');

      // Température : forcée à la valeur basse par défaut si le client n'en fournit pas.
      const writerSettings = {
        temperature: modelOptions.temperature ?? config.temperature,
        topP: modelOptions.topP ?? (config.topP < 1 ? config.topP : undefined),
        // Le client peut demander une sortie plus courte, mais jamais dépasser
        // le plafond choisi par l'administrateur.
        maxOutputTokens: modelOptions.maxOutputTokens === undefined
          ? config.maxOutputTokens
          : Math.min(modelOptions.maxOutputTokens, config.maxOutputTokens),
      };

      // ───────────── Mode streaming ─────────────
      if (stream) {
        const sseStream = pipelineSSE({ question, planner, writer, writerSettings, config, model, allowedCollections });
        return new Response(sseStream, { headers: SSE_HEADERS });
      }

      // ───────────── Mode non-streaming ─────────────
      // Cœur du pipeline mutualisé avec le banc de test admin (voir pipeline/orchestrate.ts).
      const run = await runRagCore({ question, planner, writer, writerSettings, allowedCollections, config });

      // Cas direct (salutation / conversationnel) : réponse immédiate, pas de recherche, pas de notation.
      if (run.plan.type === 'direct') {
        return c.json(buildCompletion(modelId, model, run.answer, 'stop', undefined));
      }

      const chunks = run.chunks;
      await remapDocumentIds(chunks, allowedCollections);
      const clean = run.answer; // déjà nettoyée des marqueurs 【】 par runRagCore.
      // Journalisation séparée de la notation : même avec evalSamplingRate=0, le
      // run reste disponible dans Mastra Admin pour un jugement manuel ultérieur.
      // Notation : sur la version SANS liens (format Sources préservé pour le scorer).
      await logLiveRunAndMaybeScore(question, chunks, clean, config, model, allowedCollections);
      const sign = sourceSigner();
      // Pas de bloc Sources si la réponse n'est pas fondée sur des documents (rien trouvé / refus).
      const display = shouldSuppressSources(clean, chunks) ? stripSourcesBlock(clean) : clean;
      const answer = sign ? injectSourceLinks(display, chunks, sign) : display;
      return c.json(buildCompletion(modelId, model, answer, run.finishReason, run.usage));
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

// Résout l'`albert_document_id` SERVABLE (et autorisé) d'un chunk, ou null.
// Deux voies, dans l'ordre :
//  1. par l'ID du chunk : `document_id` renvoyé par la recherche Albert EST
//     l'albert_document_id stocké → résolution directe (cas standard) ;
//  2. par le NOM : repli pour les cas où l'ID de recherche ≠ ID d'upload, ou
//     quand Albert ne renvoie pas de nom (copies homonymes).
// Dans les DEUX cas, `pickDocumentFile` impose le cloisonnement : on ne retient
// que si la collection du document est autorisée (admin = null → tout). Donc le
// lien pointe TOUJOURS vers une copie visible par l'utilisateur, jamais un 403.
async function resolveServableId(
  ch: RagChunk,
  allowedCollections: number[] | null,
): Promise<string | null> {
  try {
    // 1. Voie directe : l'id du chunk = albert_document_id.
    if (ch.documentId) {
      const byId = await getDocumentFileByAlbertId(ch.documentId);
      if (byId) {
        const picked = pickDocumentFile([byId], allowedCollections, ch.collectionId);
        if (picked) return picked.albert_document_id;
      }
    }
    // 2. Repli par nom (cloisonné aux collections autorisées).
    if (ch.name) {
      const byName = await getDocumentFilesByFilename(ch.name);
      const picked = pickDocumentFile(byName, allowedCollections, ch.collectionId);
      if (picked) return picked.albert_document_id;
    }
    return null;
  } catch (err) {
    console.error('[sources] remap ID échoué:', (err as Error).message);
    return null;
  }
}

// Remappe chaque chunk vers l'albert_document_id servable (et autorisé), pour que
// le lien de la visionneuse ouvre le bon PDF. Si aucune copie autorisée : on EFFACE
// l'id (pas de lien plutôt qu'un lien voué au 403). Cache par (id + nom + collection).
async function remapDocumentIds(
  chunks: RagChunk[],
  allowedCollections: number[] | null,
): Promise<void> {
  const cache = new Map<string, string | null>();
  for (const ch of chunks) {
    const key = `${ch.documentId ?? ''}::${ch.name ?? ''}::${ch.collectionId ?? ''}`;
    if (!cache.has(key)) cache.set(key, await resolveServableId(ch, allowedCollections));
    ch.documentId = cache.get(key) ?? undefined;
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
function maybeScoreLive(
  question: string,
  usedChunks: RagChunk[],
  answer: string,
  config: AppConfig,
  genModel: string,
  allowedCollections: number[] | null,
  runId: number,
): void {
  if (Math.random() >= (config.evalSamplingRate ?? 0)) return;
  const cleanAnswer = stripCitationBrackets(answer);
  if (!question || !cleanAnswer) return;
  void scoreRun({ runId, question, answer: cleanAnswer, usedChunks, source: 'live', genModel, allowedCollections })
    .catch((err) => console.error('[eval] scoring live échoué:', err?.message || err));
}

// Tous les runs documentaires sont journalisés, indépendamment du judge live.
// La notation reste optionnelle et peut être lancée plus tard depuis /admin/eval.
async function logLiveRunAndMaybeScore(
  question: string,
  usedChunks: RagChunk[],
  answer: string,
  config: AppConfig,
  genModel: string,
  allowedCollections: number[] | null,
): Promise<void> {
  const cleanAnswer = stripCitationBrackets(answer);
  if (!question || !cleanAnswer) return;
  try {
    const runId = await insertRagRun({
      source: 'live',
      question,
      answer: cleanAnswer,
      usedChunks,
      wideK: 0,
      genModel,
      isRefusal: isRefusal(cleanAnswer),
    });
    maybeScoreLive(question, usedChunks, cleanAnswer, config, genModel, allowedCollections, runId);
  } catch (err: any) {
    // Une panne de la base d'évaluation ne doit jamais faire échouer le chat.
    console.error('[eval] journalisation live échouée:', err?.message || err);
  }
}

interface PipelineSSEArgs {
  question: string;
  planner: any;
  writer: any;
  writerSettings: { temperature: number; topP?: number; maxOutputTokens?: number };
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
        const plan = await planifier(question, planner, config.maxSearchQueries);

        // Cas direct : réponse immédiate, pas de recherche.
        if (plan.type === 'direct') {
          send(controller, { content: plan.reponseDirecte });
          send(controller, {}, 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }

        etape(controller, 'Recherche dans les documents…');
        const { chunks } = await rechercherMultiple(plan.requetes, question, allowedCollections, config);
        await remapDocumentIds(chunks, allowedCollections);

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
        // Pas de bloc Sources si la réponse n'est pas fondée sur des documents (rien trouvé / refus).
        const suppress = shouldSuppressSources(fullText, chunks);
        const tail = splitter.finalize((block) =>
          suppress ? '' : sign ? injectSourceLinks(block, chunks, sign) : block,
        );
        if (tail.length > 0) send(controller, { content: tail });

        // Si le modèle a oublié le bloc malgré le prompt, l'ajouter depuis les
        // chunks réellement retenus. En streaming il doit être émis seulement à
        // la fin, une fois que l'on sait qu'aucun bloc n'est arrivé.
        const fallbackBlock = !suppress && !splitter.sawSources
          ? buildSourcesBlock(chunks)
          : '';
        const fallbackText = fallbackBlock ? `\n\n${fallbackBlock}` : '';
        if (fallbackText) {
          send(controller, {
            content: sign ? injectSourceLinks(fallbackText, chunks, sign) : fallbackText,
          });
        }

        send(controller, {}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        // Journalisation + notation live sur le texte complet NON lié (format Sources préservé).
        // Elle est détachée après l'envoi de [DONE] pour ne pas ralentir le streaming.
        void logLiveRunAndMaybeScore(
          question,
          chunks,
          fallbackText ? `${fullText.trimEnd()}${fallbackText}` : fullText,
          config,
          model,
          allowedCollections,
        );
      } catch (err: any) {
        send(controller, { content: `[error: ${err?.message || 'stream failed'}]` }, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
      }
    },
  });
}
