import { registerApiRoute } from '@mastra/core/server';
import * as auth from '../lib/auth.js';
import * as db from '../lib/db.js';
import { getConfig, updateConfig, initConfigFromEnv } from '../lib/config.js';
import { requireAuth, requireAdmin, verifyCsrf, getAuth, getClientIp } from '../lib/middleware.js';
import { validatePassword } from '../lib/crypto.js';
import * as albert from '../lib/albert-client.js';
import { scoreRun } from '../mastra/scorers/run.js';

await initConfigFromEnv();

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

      const { query } = await c.req.json();
      if (!query) {
        return c.json({ error: 'query is required' }, 400);
      }

      const config = await getConfig();
      const ip = getClientIp(c);

      const collections = authResult.user.role === 'admin'
        ? config.defaultCollections
        : authResult.collections;

      if (collections.length === 0) {
        return c.json({ error: 'No collections configured' }, 400);
      }

      const steps: any[] = [];

      let chunks: any[] = [];
      try {
        const searchResults = await albert.search({
          query,
          collections,
          k: config.searchK,
        });
        chunks = (searchResults.data || []).filter((r: any) => r.score >= config.minScore);
        steps.push({
          step: 'search',
          status: 'ok',
          resultCount: searchResults.data?.length || 0,
          afterFilter: chunks.length,
          results: chunks.slice(0, 5),
        });
      } catch (err: any) {
        steps.push({ step: 'search', status: 'error', error: err.message });
      }

      if (config.useRerank && chunks.length > 0) {
        try {
          const rerankResults = await albert.rerank({
            query,
            documents: chunks.map((r: any) => r.chunk?.content || r.content || ''),
          });
          if (rerankResults.results) {
            chunks = rerankResults.results
              .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
              .slice(0, config.searchK)
              .map((r: any) => ({
                score: r.relevance_score,
                chunk: { content: chunks[r.index]?.chunk?.content || '' },
              }));
          }
          steps.push({
            step: 'rerank',
            status: 'ok',
            resultCount: chunks.length,
            results: chunks.slice(0, 5),
          });
        } catch (err: any) {
          steps.push({ step: 'rerank', status: 'error', error: err.message });
        }
      } else {
        steps.push({ step: 'rerank', status: 'skipped' });
      }

      const context = chunks
        .map((r: any, i: number) => `[Source ${i + 1}] ${r.chunk?.content || ''}`)
        .join('\n\n---\n\n');
      const systemContent = config.ragPromptTemplate.replace('{context}', context);
      steps.push({
        step: 'augmentation',
        status: 'ok',
        systemPromptLength: systemContent.length,
        contextChunks: chunks.length,
      });

      let answer = '';
      try {
        const chatResponse = await albert.chatCompletions({
          model: config.llmModel,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: query },
          ],
          stream: false,
        });
        const chatData = await chatResponse.json();
        answer = chatData.choices?.[0]?.message?.content || '';
        steps.push({
          step: 'llm',
          status: 'ok',
          response: answer,
        });
      } catch (err: any) {
        steps.push({ step: 'llm', status: 'error', error: err.message });
      }

      await db.logAudit(ip, 'TEST_PIPELINE', authResult.user.id, `query="${query}" collections=[${collections}]`);

      // Notation Mastra du test (fire-and-forget) → apparaît dans /admin/eval (source 'test').
      // Ne bloque pas la réponse du test ; les 4 juges tournent en arrière-plan (~30 s).
      if (answer) {
        const usedChunks = chunks.map((r: any) => {
          const md = r.chunk?.metadata || {};
          return {
            name: md.document_name || md.name || md.title || md.filename || '',
            content: r.chunk?.content || r.content || '',
            score: r.score ?? 0,
            url: md.directory_url || md.url || md.source_url || '',
          };
        });
        void scoreRun({ question: query, answer, usedChunks, source: 'test', genModel: config.llmModel })
          .catch((e: any) => console.error('[eval] scoring test-pipeline échoué:', e?.message || e));
      }

      return c.json({ query, steps });
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
        'albertApiKey', 'albertApiBaseUrl', 'llmModel',
        'defaultCollections', 'searchK', 'minScore',
        'useRerank', 'ragPromptTemplate', 'adminContactEmail',
      ];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No valid fields to update' }, 400);
      }

      await updateConfig(updates);
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
        albertModels = (models.data || []).map((m: any) => m.id);
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
];
