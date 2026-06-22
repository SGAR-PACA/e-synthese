import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'node:crypto';
import * as albert from '../lib/albert-client';
import { requireAuth, canAccessCollection, getClientIp, verifyCsrf, type AuthContext } from '../lib/middleware.js';
import { logAudit, createDocumentFile, deleteDocumentFileByAlbertId } from '../lib/db.js';
import { isPdfBytes } from '../lib/pdf-validation.js';
import { putPdf, originalKey, deletePdf, searchableKey } from '../lib/storage.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Premier Blob (le fichier) d'un FormData multipart. Pur, testé.
export function pickPdfBlob(formData: FormData): Blob | undefined {
  for (const entry of formData.values()) {
    if (entry instanceof Blob) return entry;
  }
  return undefined;
}

// Nettoie le nom de fichier client : retire séparateurs de chemin + caractères de
// contrôle, borne la longueur (defense-in-depth : path traversal / XSS stocké).
export function sanitizeFilename(name: string | undefined): string {
  const cleaned = (name || '').replace(/[/\\\x00-\x1f]/g, '_').trim().slice(0, 200);
  return cleaned || 'document.pdf';
}

// Autorisation d'accès à un document précis (GET/DELETE). admin = tout ; editor =
// seulement si la collection du document fait partie de ses collections autorisées.
// La collection est lue auprès d'Albert (source d'autorité) -> couvre AUSSI les anciens
// documents, pas seulement ceux uploadés via la feature. Double sécurité : le RAG
// (/v1/search) est déjà filtré par collection côté Albert.
async function authorizeDocumentAccess(
  c: any,
  authCtx: AuthContext,
  documentId: string,
): Promise<Response | null> {
  if (authCtx.user.role === 'admin') return null;
  try {
    const doc: any = await albert.getDocument(documentId);
    const collectionId = doc?.collection_id;
    if (collectionId != null && canAccessCollection(authCtx, Number(collectionId))) {
      return null;
    }
  } catch (err) {
    console.error('[documents] échec autorisation document:', (err as Error).message);
  }
  return c.json({ error: 'Forbidden' }, 403);
}

export const documentsRoute = [
  registerApiRoute('/v1/documents', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = await requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const collectionId = c.req.query('collection_id') || '';
      if (!collectionId) {
        return c.json({ error: 'collection_id query parameter is required' }, 400);
      }
      const collectionIdNum = parseInt(collectionId, 10);
      if (isNaN(collectionIdNum)) {
        return c.json({ error: 'collection_id must be a valid integer' }, 400);
      }
      if (!canAccessCollection(authCtx, collectionIdNum)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const data = await albert.listDocuments(collectionId);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/documents', {
    method: 'POST',
    handler: async (c) => {
      const authCtx = await requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const csrfError = verifyCsrf(c, authCtx);
      if (csrfError) return csrfError;

      const contentLength = parseInt(c.req.header('content-length') || '0', 10);
      if (contentLength > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'Upload trop volumineux (max 10 Mo)' }, 413);
      }

      const formData = await c.req.formData();

      const blob = pickPdfBlob(formData);
      if (!blob) return c.json({ error: 'Fichier manquant' }, 400);
      if (blob.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'Upload trop volumineux (max 10 Mo)' }, 413);
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!isPdfBytes(bytes)) {
        return c.json({ error: 'Le fichier doit être un PDF' }, 400);
      }

      const collectionRaw = formData.get('collection_id');
      const collectionId = collectionRaw != null ? parseInt(collectionRaw as string, 10) : null;
      if (collectionId != null && !canAccessCollection(authCtx, collectionId)) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const fileId = randomUUID();
      const filename = sanitizeFilename((blob as File).name);
      await putPdf(originalKey(fileId), bytes);
      try {
        await createDocumentFile({ id: fileId, collectionId, filename, uploadedBy: authCtx.user.id });
      } catch (err) {
        // Compensation : ne pas laisser un PDF orphelin en S3 si l'écriture DB échoue (RGPD).
        await deletePdf(originalKey(fileId)).catch(() => {});
        throw err;
      }
      await logAudit(getClientIp(c), 'DOCUMENT_UPLOADED', authCtx.user.id, 'fileId: ' + fileId);

      return c.json({ fileId, status: 'processing' }, 202);
    },
  }),
  registerApiRoute('/v1/documents/:documentId', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = await requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const documentId = c.req.param('documentId');
      const forbidden = await authorizeDocumentAccess(c, authCtx, documentId);
      if (forbidden) return forbidden;
      const data = await albert.getDocument(documentId);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/documents/:documentId', {
    method: 'DELETE',
    handler: async (c) => {
      const authCtx = await requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const csrfError = verifyCsrf(c, authCtx);
      if (csrfError) return csrfError;
      const documentId = c.req.param('documentId');
      const forbidden = await authorizeDocumentAccess(c, authCtx, documentId);
      if (forbidden) return forbidden;

      // 1) Albert (source de vérité du RAG)
      const data = await albert.deleteDocument(documentId);

      // 2) Cascade : effacer le PDF stocké + la ligne de mapping (RGPD, anti-orphelin)
      const file = await deleteDocumentFileByAlbertId(documentId);
      if (file) {
        // Efface les deux clés possibles (original + cherchable) : deletePdf est idempotent
        // si la clé est absente. Évite tout PDF orphelin (RGPD), y compris en repli OCR.
        for (const key of [originalKey(file.id), searchableKey(file.id)]) {
          try {
            await deletePdf(key);
          } catch (err) {
            console.error('[documents] échec suppression S3:', (err as Error).message);
          }
        }
      }

      await logAudit(getClientIp(c), 'DOCUMENT_DELETED', authCtx.user.id, 'Document: ' + documentId);
      return c.json(data);
    },
  }),
];
