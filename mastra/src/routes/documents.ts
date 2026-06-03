import { registerApiRoute } from '@mastra/core/server';
import * as albert from '../lib/albert-client';
import { requireAuth, canAccessCollection, getClientIp, verifyCsrf } from '../lib/middleware.js';
import { logAudit } from '../lib/db.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

      let totalBytes = 0;
      for (const entry of formData.values()) {
        if (entry instanceof Blob) totalBytes += entry.size;
      }
      if (totalBytes > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'Upload trop volumineux (max 10 Mo)' }, 413);
      }

      const collectionId = formData.get('collection_id');
      if (collectionId && !canAccessCollection(authCtx, parseInt(collectionId as string, 10))) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const data = await albert.uploadDocument(formData);
      await logAudit(getClientIp(c), 'DOCUMENT_UPLOADED', authCtx.user.id, 'Collection: ' + collectionId);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/documents/:documentId', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = await requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const documentId = c.req.param('documentId');
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
      const data = await albert.deleteDocument(documentId);
      await logAudit(getClientIp(c), 'DOCUMENT_DELETED', authCtx.user.id, 'Document: ' + documentId);
      return c.json(data);
    },
  }),
];
