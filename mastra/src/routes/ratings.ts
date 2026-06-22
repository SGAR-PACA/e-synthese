// mastra/src/routes/ratings.ts
import { registerApiRoute } from '@mastra/core/server';
import { requireRatingUser } from '../lib/rating-auth.js';
import { validateRatingInput } from '../lib/ratings-validate.js';
import { upsertRating, getRatingForUser } from '../lib/db.js';

export function pickRatingError(parsed: { ok: boolean }): string | null {
  return parsed.ok ? null : 'Données de note invalides';
}

export const ratingsRoute = [
  registerApiRoute('/v1/ratings', {
    method: 'POST',
    handler: async (c) => {
      const user = await requireRatingUser(c);
      if (user instanceof Response) return user;

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Corps JSON invalide' }, 400);
      }
      const parsed = validateRatingInput(body);
      const err = pickRatingError(parsed);
      if (err || !parsed.ok) return c.json({ error: err ?? 'Données de note invalides' }, 400);

      await upsertRating({ sub: user.sub, email: user.email, ...parsed.value });
      return c.json({ ok: true });
    },
  }),
  registerApiRoute('/v1/ratings', {
    method: 'GET',
    handler: async (c) => {
      const user = await requireRatingUser(c);
      if (user instanceof Response) return user;
      const messageId = c.req.query('message_id') || '';
      if (!messageId) return c.json({ error: 'message_id requis' }, 400);
      const rating = await getRatingForUser(user.sub, messageId);
      return c.json(rating ? { rating: rating.rating, comment: rating.comment ?? '' } : null);
    },
  }),
];
