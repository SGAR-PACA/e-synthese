import { registerApiRoute } from '@mastra/core/server';
import * as auth from '../lib/auth.js';
import * as db from '../lib/db.js';
import { getConfig, updateConfig, initConfigFromEnv } from '../lib/config.js';
import { requireAuth, requireAdmin, verifyCsrf, getAuth, getClientIp } from '../lib/middleware.js';
import { validatePassword } from '../lib/crypto.js';
import * as albert from '../lib/albert-client.js';
import { scoreRun } from '../mastra/scorers/run.js';
import { runRagCore } from '../mastra/pipeline/orchestrate.js';
import type { RagChunk } from '../lib/db.js';
import { parseCitedSources } from '../lib/cited-sources.js';
import { configureAlbertRateLimit } from '../lib/albert-limiter.js';
import { isRefusal } from '../mastra/scorers/refusal.js';

await initConfigFromEnv();
configureAlbertRateLimit((await getConfig()).albertMaxRpm);

export const adminApiRoute = [
  registerApiRoute('/admin/auth-status', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = await getAuth(c);
      return c.json({
        isSetup: await auth.isSetup(),
        isAuthenticated: !!authCtx,
        role: authCtx?.user.role ?? null,
      });
    },
  }),

  registerApiRoute('/admin/setup', {
    method: 'POST',
    handler: async (c) => {
      if (await auth.isSetup()) {
        return c.json({ error: 'Admin already configured' }, 403);
      }
      const { email, password } = await c.req.json();
      if (!email || !password) {
        return c.json({ error: 'Email and password are required' }, 400);
      }
      const pwError = validatePassword(password);
      if (pwError) {
        return c.json({ error: pwError }, 400);
      }

      const { recoveryCode } = await auth.setupAdmin(email, password);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'SETUP', undefined, 'First admin created');

      const loginResult = await auth.login(email, password);
      if (!loginResult) {
        return c.json({ ok: true, recoveryCode, csrfToken: null });
      }

      await db.logAudit(ip, 'LOGIN_SUCCESS', loginResult.user.id);

      return new Response(JSON.stringify({ ok: true, recoveryCode, csrfToken: loginResult.csrfToken }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': auth.sessionCookieString(loginResult.token),
        },
      });
    },
  }),

  registerApiRoute('/admin/login', {
    method: 'POST',
    handler: async (c) => {
      const ip = getClientIp(c);
      const rateCheck = auth.checkRateLimit(`login:${ip}`, 5);
      if (!rateCheck.allowed) {
        return c.json({ error: `Too many attempts. Retry in ${rateCheck.retryAfterSeconds}s` }, 429);
      }

      const { email, password } = await c.req.json();
      const loginResult = await auth.login(email, password);
      if (!loginResult) {
        auth.recordFailedAttempt(`login:${ip}`, 5);
        await db.logAudit(ip, 'LOGIN_FAILED', undefined, email);
        return c.json({ error: 'Invalid credentials' }, 401);
      }

      auth.resetRateLimit(`login:${ip}`);
      await db.logAudit(ip, 'LOGIN_SUCCESS', loginResult.user.id);

      return new Response(JSON.stringify({ ok: true, csrfToken: loginResult.csrfToken, role: loginResult.user.role }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': auth.sessionCookieString(loginResult.token),
        },
      });
    },
  }),

  registerApiRoute('/admin/register', {
    method: 'POST',
    handler: async (c) => {
      const ip = getClientIp(c);
      const rateCheck = auth.checkRateLimit(`register:${ip}`, 3);
      if (!rateCheck.allowed) {
        return c.json({ error: `Too many attempts. Retry in ${rateCheck.retryAfterSeconds}s` }, 429);
      }

      const { email, password, inviteCode } = await c.req.json();
      if (!email || !password || !inviteCode) {
        return c.json({ error: 'Email, password, and inviteCode are required' }, 400);
      }
      const pwError = validatePassword(password);
      if (pwError) {
        return c.json({ error: pwError }, 400);
      }

      const result = await auth.register(email, password, inviteCode);
      if ('error' in result) {
        auth.recordFailedAttempt(`register:${ip}`, 3);
        return c.json({ error: result.error }, 400);
      }

      auth.resetRateLimit(`register:${ip}`);
      await db.logAudit(ip, 'REGISTER', result.userId, email);

      return c.json({ recoveryCode: result.recoveryCode });
    },
  }),

  registerApiRoute('/admin/forgot-password', {
    method: 'POST',
    handler: async (c) => {
      const ip = getClientIp(c);
      const rateCheck = auth.checkRateLimit(`forgot:${ip}`, 3);
      if (!rateCheck.allowed) {
        return c.json({ error: `Too many attempts. Retry in ${rateCheck.retryAfterSeconds}s` }, 429);
      }

      const { email, recoveryCode, newPassword } = await c.req.json();
      if (!email || !recoveryCode || !newPassword) {
        return c.json({ error: 'Email, recoveryCode, and newPassword are required' }, 400);
      }
      const pwError = validatePassword(newPassword);
      if (pwError) {
        return c.json({ error: pwError }, 400);
      }

      const result = await auth.forgotPassword(email, recoveryCode, newPassword);
      if ('error' in result) {
        auth.recordFailedAttempt(`forgot:${ip}`, 3);
        await db.logAudit(ip, 'FORGOT_PASSWORD_FAILED', undefined, email);
        return c.json({ error: result.error }, 400);
      }

      auth.resetRateLimit(`forgot:${ip}`);
      await db.logAudit(ip, 'FORGOT_PASSWORD_SUCCESS', undefined, email);

      return c.json({ recoveryCode: result.recoveryCode });
    },
  }),

  registerApiRoute('/admin/reset-password', {
    method: 'POST',
    handler: async (c) => {
      const { token, newPassword } = await c.req.json();
      if (!token || !newPassword) {
        return c.json({ error: 'Token and newPassword are required' }, 400);
      }
      const pwError = validatePassword(newPassword);
      if (pwError) {
        return c.json({ error: pwError }, 400);
      }

      const result = await auth.executeForceReset(token, newPassword);
      if ('error' in result) {
        return c.json({ error: result.error }, 400);
      }

      const ip = getClientIp(c);
      await db.logAudit(ip, 'RESET_PASSWORD', undefined, 'Via token link');

      return c.json({ recoveryCode: result.recoveryCode });
    },
  }),

  registerApiRoute('/admin/logout', {
    method: 'POST',
    handler: async (c) => {
      const token = auth.parseSessionCookie(c.req.header('cookie'));
      if (token) {
        const session = await auth.validateSession(token);
        if (session) {
          await db.logAudit(getClientIp(c), 'LOGOUT', session.user.id);
        }
        await auth.logout(token);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': auth.clearSessionCookie(),
        },
      });
    },
  }),

  registerApiRoute('/admin/me', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAuth(c);
      if (authResult instanceof Response) return authResult;
      const collections = authResult.user.role === 'admin'
        ? []
        : await db.getUserCollections(authResult.user.id);
      return c.json({
        id: authResult.user.id,
        email: authResult.user.email,
        role: authResult.user.role,
        collections,
      });
    },
  }),

  registerApiRoute('/admin/change-password', {
    method: 'PUT',
    handler: async (c) => {
      const authResult = await requireAuth(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const { currentPassword, newPassword } = await c.req.json();
      if (!currentPassword || !newPassword) {
        return c.json({ error: 'currentPassword and newPassword are required' }, 400);
      }
      const pwError = validatePassword(newPassword);
      if (pwError) {
        return c.json({ error: pwError }, 400);
      }

      const result = await auth.changePassword(authResult.user.id, currentPassword, newPassword);
      if ('error' in result) {
        return c.json({ error: result.error }, 400);
      }

      const ip = getClientIp(c);
      await db.logAudit(ip, 'CHANGE_PASSWORD', authResult.user.id);

      return c.json({ recoveryCode: result.recoveryCode });
    },
  }),

  registerApiRoute('/admin/test-pipeline', {
    method: 'POST',
    handler: async (c) => {
      const authResult = await requireAuth(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const body = await c.req.json();
      const query = body?.query;
      const withJudge = body?.withJudge !== false;
      if (!query) {
        return c.json({ error: 'query is required' }, 400);
      }

      const config = await getConfig();
      const ip = getClientIp(c);

      // Périmètre de recherche IDENTIQUE au chat : admin = accès non restreint (null → toutes
      // les collections, comme le repli chat), non-admin = ses collections autorisées (groupes).
      const allowedCollections: number[] | null =
        authResult.user.role === 'admin' ? null : authResult.collections;

      // Pipeline FIDÈLE au chat de production (planif → pêche large → rerank → rédaction),
      // via la fonction partagée : tout paramètre réglé dans l'admin agit ici à l'identique.
      const planner = c.get('mastra').getAgent('plannerAgent');
      const writer = c.get('mastra').getAgent('writerAgent');
      const writerSettings = {
        temperature: config.temperature,
        topP: config.topP < 1 ? config.topP : undefined,
        maxOutputTokens: config.maxOutputTokens,
      };

      let run;
      try {
        run = await runRagCore({ question: query, planner, writer, writerSettings, allowedCollections, config });
      } catch (err: any) {
        return c.json({ error: `Pipeline échoué : ${err?.message || err}` }, 500);
      }

      await db.logAudit(ip, 'TEST_PIPELINE', authResult.user.id, `query="${query}"`);

      const queryCount = run.plan.type === 'recherche' ? run.plan.requetes.length : 0;
      const pipelineRequestBudget = run.plan.type === 'recherche'
        ? 1 + queryCount + (config.useRerank ? 1 : 0) + 1
        : 1;

      // Snapshot des paramètres RÉELLEMENT appliqués (pour le réglage fin + export JSON).
      const params = {
        generation: {
          llmModel: config.llmModel,
          albertMaxRpm: config.albertMaxRpm,
          temperature: config.temperature,
          topP: config.topP,
          maxOutputTokens: config.maxOutputTokens,
          maxSearchQueries: config.maxSearchQueries,
          useRerank: config.useRerank,
          searchWideK: config.searchWideK,
          finalK: config.finalK,
          rerankMinScore: config.rerankMinScore,
          searchK: config.searchK,
          minScore: config.minScore,
        },
        judge: {
          judgeModel: config.judgeModel,
          temperature: config.judgeTemperature,
          maxCompletionTokens: config.judgeMaxCompletionTokens,
          evalWideK: config.evalWideK,
          evalWideSearch: config.evalWideSearch,
        },
        collections: allowedCollections,
        requestBudget: {
          pipeline: pipelineRequestBudget,
          judge: run.plan.type === 'recherche' && withJudge ? 1 + (config.evalWideSearch ? 1 : 0) : 0,
          total: pipelineRequestBudget + (run.plan.type === 'recherche' && withJudge ? 1 + (config.evalWideSearch ? 1 : 0) : 0),
        },
      };

      const chunkView = (ch: RagChunk) => ({ name: ch.name, score: ch.score, content: ch.content });

      // Cas direct (conversationnel) : pas de RAG ni de notation.
      if (run.plan.type === 'direct') {
        return c.json({
          query,
          params,
          plan: { type: 'direct' },
          usedChunks: [],
          wideChunks: [],
          answer: run.answer,
          scores: [],
          isRefusal: false,
          runId: null,
          note: 'Question conversationnelle (plan direct) : pas de recherche ni de notation.',
        });
      }

      // Notation SYNCHRONE (banc de test) : on ATTEND les notes du juge pour les afficher,
      // contrairement au chat live (fire-and-forget). Le résultat est aussi persisté (source 'test').
      let scoreResult: { scores: any[]; isRefusal: boolean; runId: number | null; used: RagChunk[]; wide: RagChunk[] };
      if (!withJudge) {
        // Le banc peut aussi constituer un log non noté, à reprendre ensuite
        // manuellement depuis la page Évaluation.
        const runId = await db.insertRagRun({
          source: 'test',
          question: query,
          answer: run.answer,
          usedChunks: run.chunks,
          wideK: 0,
          genModel: config.llmModel,
          isRefusal: isRefusal(run.answer),
        });
        scoreResult = { scores: [], isRefusal: isRefusal(run.answer), runId, used: run.chunks, wide: [] };
      } else try {
        scoreResult = await scoreRun({
          question: query,
          answer: run.answer,
          usedChunks: run.chunks,
          source: 'test',
          genModel: config.llmModel,
          allowedCollections,
        });
      } catch (err: any) {
        scoreResult = { scores: [{ metric: 'erreur', score: 0, reason: String(err?.message || err) }], isRefusal: false, runId: null, used: run.chunks, wide: [] };
      }

      return c.json({
        query,
        params,
        plan: { type: 'recherche', requetes: run.plan.requetes },
        usedChunks: run.chunks.map(chunkView),
        wideChunks: (scoreResult.wide || []).map(chunkView),
        answer: run.answer,
        finishReason: run.finishReason,
        scores: scoreResult.scores,
        isRefusal: scoreResult.isRefusal,
        runId: scoreResult.runId,
      });
    },
  }),

  registerApiRoute('/admin/config', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;

      const config = await getConfig();
      const masked = {
        ...config,
        albertApiKey: config.albertApiKey
          ? config.albertApiKey.slice(0, 6) + '...' + config.albertApiKey.slice(-4)
          : '',
      };
      return c.json(masked);
    },
  }),

  registerApiRoute('/admin/config', {
    method: 'PUT',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const body = await c.req.json();
      const ip = getClientIp(c);
      const allowed = [
        'albertApiKey', 'albertApiBaseUrl', 'albertMaxRpm', 'llmModel',
        'defaultCollections', 'maxSearchQueries', 'searchK', 'minScore',
        'useRerank', 'ragPromptTemplate', 'adminContactEmail',
        'judgeModel', 'evalSamplingRate',
        // Leviers de précision du pipeline RAG + éval.
        'temperature', 'topP', 'maxOutputTokens', 'judgeTemperature', 'judgeMaxCompletionTokens',
        'searchWideK', 'finalK', 'rerankMinScore', 'evalWideK', 'evalWideSearch',
      ];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      if (updates.judgeModel !== undefined || updates.llmModel !== undefined) {
        const current = await getConfig();
        const generationModel = String(updates.llmModel ?? current.llmModel);
        const judgeModel = String(updates.judgeModel ?? current.judgeModel);
        if (generationModel && judgeModel && generationModel === judgeModel) {
          return c.json({ error: 'Le modèle juge doit être différent du modèle de génération.' }, 400);
        }
      }

      // Validation des paramètres numériques (bornes + type) avant persistance.
      // [key, min, max, entier?]
      const numericBounds: Array<[string, number, number, boolean]> = [
        ['evalSamplingRate', 0, 1, false],
        ['albertMaxRpm', 1, 100, true],
        ['temperature', 0, 2, false],
        ['topP', 0, 1, false],
        ['maxOutputTokens', 256, 4096, true],
        ['judgeTemperature', 0, 1, false],
        ['judgeMaxCompletionTokens', 128, 2048, true],
        ['maxSearchQueries', 1, 4, true],
        ['rerankMinScore', 0, 1, false],
        ['searchWideK', 1, 100, true],
        ['finalK', 1, 50, true],
        ['evalWideK', 1, 100, true],
      ];
      for (const [key, min, max, isInt] of numericBounds) {
        if (updates[key] === undefined) continue;
        const v = Number(updates[key]);
        if (!Number.isFinite(v) || v < min || v > max || (isInt && !Number.isInteger(v))) {
          return c.json({ error: `${key} doit être un ${isInt ? 'entier' : 'nombre'} entre ${min} et ${max}` }, 400);
        }
        updates[key] = v;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No valid fields to update' }, 400);
      }

      await updateConfig(updates);
      if (updates.albertMaxRpm !== undefined) configureAlbertRateLimit(updates.albertMaxRpm);
      await db.logAudit(ip, 'CONFIG_UPDATED', authResult.user.id, `Fields: ${Object.keys(updates).join(', ')}`);

      return c.json({ ok: true });
    },
  }),

  registerApiRoute('/admin/status', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;

      const config = await getConfig();
      let albertStatus = 'unknown';
      let albertModels: string[] = [];
      try {
        const models = await albert.listModels();
        albertStatus = 'connected';
        // N'expose QUE les modèles `text-generation` : l'API Chat Completions Albert
        // refuse les modèles embeddings/rerank/audio/OCR et le catalogue actuel classe
        // certains anciens modèles conversationnels en `image-text-to-text`.
        albertModels = (models.data || [])
          .filter((m: any) => {
            const type = String(m.type || '');
            if (type !== 'text-generation') return false;
            const tokens = [m.id, ...(m.aliases || [])].join(' ').toLowerCase();
            return !/ocr|whisper|audio|embed|rerank/.test(tokens);
          })
          .map((m: any) => {
            const ow = (m.aliases || []).find((a: string) => a.startsWith('openweight-'));
            return ow || m.id;
          });
      } catch {
        albertStatus = 'error';
      }
      return c.json({
        albertStatus,
        albertModels,
        activeCollections: config.defaultCollections,
        llmModel: config.llmModel,
        searchK: config.searchK,
        minScore: config.minScore,
        useRerank: config.useRerank,
      });
    },
  }),

  registerApiRoute('/admin/users', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;

      const userList = await db.listUsers();
      const users = await Promise.all(userList.map(async (u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.created_at,
        collections: await db.getUserCollections(u.id),
      })));
      return c.json(users);
    },
  }),

  registerApiRoute('/admin/users/:id', {
    method: 'DELETE',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const userId = parseInt(c.req.param('id'), 10);
      if (isNaN(userId)) {
        return c.json({ error: 'Invalid user ID' }, 400);
      }
      if (userId === authResult.user.id) {
        return c.json({ error: 'Cannot delete yourself' }, 400);
      }

      const target = await db.findUserById(userId);
      if (!target) {
        return c.json({ error: 'User not found' }, 404);
      }

      await db.deleteUser(userId);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'USER_DELETED', authResult.user.id, `Deleted user ${target.email} (id=${userId})`);

      return c.json({ ok: true });
    },
  }),

  registerApiRoute('/admin/users/:id/force-reset', {
    method: 'POST',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const userId = parseInt(c.req.param('id'), 10);
      if (isNaN(userId)) {
        return c.json({ error: 'Invalid user ID' }, 400);
      }

      const target = await db.findUserById(userId);
      if (!target) {
        return c.json({ error: 'User not found' }, 404);
      }

      const resetToken = await auth.createForceReset(userId);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'FORCE_RESET_CREATED', authResult.user.id, `For user ${target.email} (id=${userId})`);

      const resetLink = `/admin/reset-password?token=${resetToken}`;
      return c.json({ resetLink, token: resetToken });
    },
  }),

  registerApiRoute('/admin/users/:id/revoke-sessions', {
    method: 'POST',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const userId = parseInt(c.req.param('id'), 10);
      if (isNaN(userId)) {
        return c.json({ error: 'Invalid user ID' }, 400);
      }

      const target = await db.findUserById(userId);
      if (!target) {
        return c.json({ error: 'User not found' }, 404);
      }

      await db.deleteUserSessions(userId);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'SESSIONS_REVOKED', authResult.user.id, `For user ${target.email} (id=${userId})`);

      return c.json({ ok: true });
    },
  }),

  registerApiRoute('/admin/invitations', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;

      const invitations = await db.listInvitations();
      return c.json(invitations);
    },
  }),

  registerApiRoute('/admin/invitations', {
    method: 'POST',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const { collections, durationDays } = await c.req.json();
      if (!Array.isArray(collections) || !durationDays || durationDays < 1) {
        return c.json({ error: 'collections (array) and durationDays (>= 1) are required' }, 400);
      }

      const code = await auth.createInvitation(authResult.user.id, collections, durationDays);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'INVITATION_CREATED', authResult.user.id, `collections=[${collections}] duration=${durationDays}d`);

      return c.json({ inviteCode: code });
    },
  }),

  registerApiRoute('/admin/invitations/:id', {
    method: 'DELETE',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const csrfError = verifyCsrf(c, authResult);
      if (csrfError) return csrfError;

      const invitationId = parseInt(c.req.param('id'), 10);
      if (isNaN(invitationId)) {
        return c.json({ error: 'Invalid invitation ID' }, 400);
      }

      await db.deleteInvitation(invitationId);
      const ip = getClientIp(c);
      await db.logAudit(ip, 'INVITATION_DELETED', authResult.user.id, `id=${invitationId}`);

      return c.json({ ok: true });
    },
  }),

  registerApiRoute('/admin/audit', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;

      const limit = parseInt(c.req.query('limit') || '100', 10);
      return c.json(await db.getAuditLog(limit));
    },
  }),

  registerApiRoute('/admin/ratings', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const limit = parseInt(c.req.query('limit') || '200', 10);
      const offset = parseInt(c.req.query('offset') || '0', 10);
      const [items, stats] = await Promise.all([db.listRatings(limit, offset), db.getRatingStats()]);
      return c.json({ stats, items });
    },
  }),

  // KPIs agrégés pour le dashboard admin (count, moyenne, répartition, tendance).
  registerApiRoute('/admin/ratings/stats', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      return c.json(await db.getRatingDashboardStats());
    },
  }),

  // Reconstruit les sources citées (PDF + texte des chunks) pour une note donnée.
  // Relit les liens signés Mastra dans user_ratings.answer, vérifie la signature,
  // puis résout le nom du PDF (document_files) et le texte des chunks (Albert).
  registerApiRoute('/admin/ratings/:id/sources', {
    method: 'GET',
    handler: async (c) => {
      const authResult = await requireAdmin(c);
      if (authResult instanceof Response) return authResult;
      const key = process.env.MASTRA_SOURCE_LINK_KEY;
      if (!key) return c.json({ sources: [], note: 'Liens de sources inactifs (MASTRA_SOURCE_LINK_KEY absent).' });
      const id = parseInt(c.req.param('id'), 10);
      if (Number.isNaN(id)) return c.json({ error: 'Note introuvable' }, 404);
      const rows = await db.query<{ answer: string }>(`SELECT answer FROM user_ratings WHERE id = $1`, [id]);
      if (!rows[0]) return c.json({ error: 'Note introuvable' }, 404);
      const cited = parseCitedSources(rows[0].answer ?? '', key, Date.now());
      const sources: Array<{ documentId: string; filename: string; status: string | null; href: string; chunks: { id: string; content: string }[] }> = [];
      for (const s of cited) {
        const file = await db.getDocumentFileByAlbertId(s.documentId);
        let chunks: { id: string; content: string }[] = [];
        try {
          const want = new Set(s.chunkIds);
          chunks = (await albert.getDocumentChunks(s.documentId)).filter((ch) => want.has(ch.id));
        } catch (err) {
          console.error('[admin-ratings] chunks indisponibles:', (err as Error).message);
        }
        sources.push({
          documentId: s.documentId,
          filename: file?.filename ?? '(document inconnu)',
          status: file?.status ?? null,
          href: s.href,
          chunks,
        });
      }
      return c.json({ sources });
    },
  }),
];
