// mastra/src/lib/document-worker.ts
import {
  claimNextProcessingFile,
  getDocumentsNeedingHighlightBackfill,
  markFileReady,
  markFileFailed,
  replaceDocumentHighlightAnchors,
  type DocumentFile,
} from './db.js';
import { ocrToSearchablePdf } from './ocr-client.js';
import {
  putPdf,
  deletePdf,
  getPdfStream,
  searchableKey,
  originalKey,
} from './storage.js';
import * as albert from './albert-client.js';
import { computeChunkAnchors } from './highlight-align.js';
import { withPriority } from './albert-limiter.js';

export interface JobDeps {
  loadOriginal: (job: DocumentFile) => Promise<Uint8Array>;
  ocr: (bytes: Uint8Array) => Promise<{ pdf: Uint8Array; ocrApplied: boolean }>;
  storeSearchable: (job: DocumentFile, bytes: Uint8Array) => Promise<void>;
  deleteOriginal: (job: DocumentFile) => Promise<void>;
  uploadToAlbert: (job: DocumentFile, bytes: Uint8Array) => Promise<string>;
  // Facultatif pour garder les tests et les déploiements sans visualiseur
  // compatibles ; la dépendance réelle persiste les coordonnées après que
  // Albert a créé ses chunks.
  indexHighlights?: (job: DocumentFile, albertId: string, bytes: Uint8Array, servedKey: string) => Promise<boolean>;
  markReady: (job: DocumentFile, albertId: string, servedKey: string, ocrApplied: boolean) => Promise<void>;
  markFailed: (job: DocumentFile, message: string) => Promise<void>;
}

// Orchestration d'un job. Toute l'IO est injectée -> testable.
// - Idempotent : si l'id Albert et la clé du PDF servi existent déjà, on conclut.
// - Repli OCR (spec §8) : si l'OCR échoue, on indexe l'ORIGINAL chez Albert
//   (RAG préservé, ocr_applied=false) au lieu de marquer le job failed.
// - markFailed seulement sur erreur d'IO non-OCR (load/S3/Albert/DB).
export async function processJob(job: DocumentFile, deps: JobDeps): Promise<void> {
  try {
    if (job.albert_document_id && job.s3_key_searchable) {
      await deps.markReady(job, job.albert_document_id, job.s3_key_searchable, job.ocr_applied);
      return;
    }
    const original = await deps.loadOriginal(job);

    let served: Uint8Array;
    let servedKey: string;
    let ocrApplied: boolean;
    try {
      const r = await deps.ocr(original);
      await deps.storeSearchable(job, r.pdf);
      await deps.deleteOriginal(job);
      served = r.pdf;
      servedKey = searchableKey(job.id);
      ocrApplied = r.ocrApplied;
    } catch (ocrErr) {
      // Repli : on garde l'original (déjà stocké) et on l'indexe tel quel.
      const reason = (ocrErr as Error).message;
      console.warn(
        `[document-worker] OCR échec, repli original ` +
        `file=${job.id} filename=${JSON.stringify(job.filename)} ` +
        `collection=${job.collection_id ?? 'none'} reason=${reason}`,
      );
      served = original;
      servedKey = originalKey(job.id);
      ocrApplied = false;
    }

    const albertId = await deps.uploadToAlbert(job, served);
    // Les ancres sont un enrichissement de la visionneuse. Une impossibilité
    // de les calculer ne doit pas rendre le document inutilisable dans le RAG ;
    // elle laisse simplement le manifeste incomplet ; les chunks vérifiés
    // restent exploitables et les autres sont explicitement exclus.
    if (deps.indexHighlights) {
      try {
        await deps.indexHighlights(job, albertId, served, servedKey);
      } catch (err) {
        console.warn(
          `[document-worker] ancres de surlignage indisponibles ` +
          `file=${job.id} filename=${JSON.stringify(job.filename)} ` +
          `reason=${(err as Error).message}`,
        );
      }
    }
    await deps.markReady(job, albertId, servedKey, ocrApplied);
  } catch (err) {
    await deps.markFailed(job, (err as Error).message);
  }
}

async function indexDocumentHighlights(
  job: DocumentFile,
  albertId: string,
  bytes: Uint8Array,
  servedKey: string,
): Promise<boolean> {
  return withPriority('low', async () => {
  // L'upload Albert peut répondre avant que les chunks soient consultables.
  // On attend leur disponibilité sans multiplier les appels : le limiteur
  // Albert reste l'autorité du débit global.
  let chunks: Array<{ id: string; content: string }> = [];
  let lastChunkError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      chunks = await albert.getDocumentChunksStrict(albertId);
      if (chunks.length > 0) break;
      lastChunkError = new Error('Albert ne renvoie encore aucun chunk');
    } catch (err) {
      // L'upload et la disponibilité des chunks sont asynchrones. Une page
      // manquante ne doit surtout pas être interprétée comme une liste
      // complète ; on recommence, puis le backfill reprendra avec backoff.
      lastChunkError = err;
      console.warn(
        `[document-worker] chunks Albert indisponibles ` +
          `file=${job.id} attempt=${attempt}/6 reason=${(err as Error).message}`,
      );
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  let indexed: ReturnType<typeof computeChunkAnchors>;
  try {
    indexed = computeChunkAnchors(bytes, chunks, servedKey);
  } catch (err) {
    // Un PDF structurellement illisible est un échec déterministe de l'ancrage.
    // On persiste l'état vide pour éviter de relancer indéfiniment le même coût
    // Albert à chaque tour du worker ; le RAG reste, lui, disponible.
    const error = `Calcul des ancres impossible : ${(err as Error).message}`;
    await replaceDocumentHighlightAnchors({
      documentId: albertId,
      s3KeySearchable: servedKey,
      complete: false,
      error,
      anchors: [],
    });
    console.warn(`[document-worker] ${error} file=${job.id} filename=${JSON.stringify(job.filename)}`);
    return false;
  }
  const error = indexed.complete
    ? null
    : chunks.length === 0 && lastChunkError
      ? `Chunks Albert indisponibles : ${(lastChunkError as Error).message}`
      : `Couverture de surlignage incomplète : ${indexed.anchors.filter((a) => a.verified).length}/${indexed.anchors.length} chunks vérifiés`;
  await replaceDocumentHighlightAnchors({
    documentId: albertId,
    s3KeySearchable: servedKey,
    complete: indexed.complete,
    error,
    anchors: indexed.anchors,
  });
  if (!indexed.complete) {
    console.warn(
      `[document-worker] surlignage non validé ` +
      `file=${job.id} filename=${JSON.stringify(job.filename)} ` +
      `reason=${error}`,
    );
  }
  return indexed.complete;
  });
}

// Documents déjà prêts : le déploiement n'impose pas de les supprimer et de
// les réimporter. Le rattrapage est séquentiel et reprend avec un backoff si
// Albert n'a pas fourni des chunks alignables.
const highlightBackoff = new Map<string, { failures: number; nextAt: number }>();
const BACKFILL_MAX_DELAY_MS = 60 * 60 * 1000;

function deferHighlightBackfill(documentId: string): void {
  const previous = highlightBackoff.get(documentId);
  const failures = (previous?.failures ?? 0) + 1;
  const delay = Math.min(5_000 * 2 ** Math.min(failures - 1, 8), BACKFILL_MAX_DELAY_MS);
  highlightBackoff.set(documentId, { failures, nextAt: Date.now() + delay });
}

async function backfillOneDocument(): Promise<void> {
  const candidates = await getDocumentsNeedingHighlightBackfill(20);
  const now = Date.now();
  const job = candidates.find((candidate) => {
    const id = candidate.albert_document_id!;
    return !highlightBackoff.has(id) || highlightBackoff.get(id)!.nextAt <= now;
  });
  if (!job || !job.albert_document_id || !job.s3_key_searchable) return;

  try {
    const { body } = await getPdfStream(job.s3_key_searchable);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const complete = await indexDocumentHighlights(job, job.albert_document_id, bytes, job.s3_key_searchable);
    if (complete) highlightBackoff.delete(job.albert_document_id);
    else deferHighlightBackfill(job.albert_document_id);
  } catch (err) {
    console.warn(
      `[document-worker] rattrapage surlignage échoué ` +
      `file=${job.id} filename=${JSON.stringify(job.filename)} ` +
      `reason=${(err as Error).message}`,
    );
    deferHighlightBackfill(job.albert_document_id);
  }
}

// Dépendances réelles (IO) câblées sur storage/OCR/Albert/DB.
function liveDeps(): JobDeps {
  return {
    loadOriginal: async (job) => {
      const { body } = await getPdfStream(originalKey(job.id));
      const buf = await new Response(body).arrayBuffer();
      return new Uint8Array(buf);
    },
    ocr: (bytes) => ocrToSearchablePdf(bytes),
    storeSearchable: (job, bytes) => putPdf(searchableKey(job.id), bytes),
    deleteOriginal: (job) => deletePdf(originalKey(job.id)),
    uploadToAlbert: async (job, bytes) => {
      const fd = new FormData();
      const blobPart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      fd.append('file', new Blob([blobPart], { type: 'application/pdf' }), job.filename);
      if (job.collection_id != null) fd.append('collection_id', String(job.collection_id));
      const data = await albert.uploadDocument(fd);
      const id = (data as any)?.id ?? (data as any)?.document_id;
      if (!id) throw new Error('Albert : id de document manquant');
      return String(id);
    },
    indexHighlights: indexDocumentHighlights,
    markReady: (job, albertId, servedKey, ocrApplied) =>
      markFileReady(job.id, albertId, servedKey, ocrApplied),
    markFailed: (job, message) => markFileFailed(job.id, message),
  };
}

let running = false;
export function startDocumentWorker(): void {
  if (running) return;
  running = true;
  const deps = liveDeps();
  const tick = async () => {
    try {
      const job = await claimNextProcessingFile();
      if (job) await withPriority('low', () => processJob(job, deps));
      else await backfillOneDocument();
    } catch (err) {
      console.error('[document-worker] tick error:', (err as Error).message);
    } finally {
      setTimeout(tick, 3000);
    }
  };
  void tick();
}
