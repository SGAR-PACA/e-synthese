import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/albert-limiter.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('limiteur : ne dépasse jamais maxPerWindow départs par fenêtre', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 3, windowMs: 200 });
  const starts: number[] = [];
  const t0 = Date.now();

  const jobs = Array.from({ length: 9 }, () =>
    limiter.schedule(async () => {
      starts.push(Date.now() - t0);
      return true;
    }),
  );
  await Promise.all(jobs);

  // Pour chaque départ, au plus maxPerWindow départs dans la fenêtre [t-window, t].
  for (const t of starts) {
    const inWindow = starts.filter((s) => s > t - 200 && s <= t).length;
    assert.ok(inWindow <= 3, `fenêtre à t=${t}ms contient ${inWindow} départs (> 3)`);
  }
  assert.equal(starts.length, 9);
});

test('limiteur : la priorité high passe devant low quand saturé', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 120 });
  const order: string[] = [];

  // Sature le créneau avec un premier job (priorité par défaut high).
  const first = limiter.schedule(async () => void order.push('first'));
  // Puis empile 1 low et 1 high pendant que le créneau est plein.
  const low = limiter.withPriority('low', () => limiter.schedule(async () => void order.push('low')));
  const high = limiter.withPriority('high', () => limiter.schedule(async () => void order.push('high')));

  await Promise.all([first, low, high]);

  assert.equal(order[0], 'first');
  // Le high empilé doit être servi avant le low, malgré son ajout après.
  assert.deepEqual(order.slice(1), ['high', 'low']);
});

test('limiteur : sous le plafond, exécution immédiate (pas de blocage)', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 1000 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map((n) => limiter.schedule(async () => n)));
  assert.ok(Date.now() - t0 < 50, 'les 3 appels sous plafond ne doivent pas être retardés');
});

test('limiteur : propage la valeur de retour et les erreurs', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 100 });
  assert.equal(await limiter.schedule(async () => 42), 42);
  await assert.rejects(() => limiter.schedule(async () => { throw new Error('boom'); }), /boom/);
});
