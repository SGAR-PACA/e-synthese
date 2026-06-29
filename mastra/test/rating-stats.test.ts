import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, run, query, getRatingDashboardStats } from '../src/lib/db.ts';

test('getRatingDashboardStats agrège count/moyenne/distribution', async () => {
  await applySchema();
  await run(`DELETE FROM user_ratings`);
  await run(`INSERT INTO user_ratings (sub,message_id,rating,question,answer) VALUES
    ('u1','m1',5,'q','a'),('u2','m2',5,'q','a'),('u3','m3',3,'q','a'),('u4','m4',1,'q','a')`);
  const s = await getRatingDashboardStats();
  assert.equal(s.count, 4);
  assert.equal(s.distribution[4], 2); // deux 5★
  assert.equal(s.distribution[2], 1); // un 3★
  assert.equal(s.distribution[0], 1); // un 1★
  assert.equal(s.pct_high, 50);       // 2/4 ≥ 4
  assert.ok(s.average > 3.4 && s.average < 3.6);
});
