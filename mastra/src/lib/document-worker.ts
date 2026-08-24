// mastra/src/lib/document-worker.ts
import {
  claimNextProcessingFile,
  markFileReady,
  markFileFailed,
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

export interface JobDeps {
  loadOriginal: (job: DocumentFile) => Promise<Uint8Array>;
  ocr: (bytes: Uint8Array) => Promise<{ pdf: Uint8Array; ocrApplied: boolean }>;
  storeSearchable: (job: DocumentFile, bytes: Uint8Array) => Promise<void>;
  deleteOriginal: (job: DocumentFile) => Promise<void>;
  uploadToAlbert: (job: DocumentFile, bytes: Uint8Array) => Promise<string>;
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
    await deps.markReady(job, albertId, servedKey, ocrApplied);
  } catch (err) {
    await deps.markFailed(job, (err as Error).message);
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
      if (job) await processJob(job, deps);
    } catch (err) {
      console.error('[document-worker] tick error:', (err as Error).message);
    } finally {
      setTimeout(tick, 3000);
    }
  };
  void tick();
}
