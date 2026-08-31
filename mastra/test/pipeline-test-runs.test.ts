import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySchema,
  createPipelineTestRun,
  getPipelineTestRun,
  listPipelineTestRuns,
  query,
  run,
  updatePipelineTestRun,
} from '../src/lib/db.ts';

test('un test pipeline reste consultable avec son état et son résultat', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL absente (test PostgreSQL)',
}, async () => {
  await applySchema();
  const suffix = `${Date.now()}-${Math.random()}`;
  const users = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, salt, role)
     VALUES ($1, 'hash', 'salt', 'editor') RETURNING id`,
    [`pipeline-${suffix}@example.test`],
  );
  const userId = users[0].id;

  try {
    const created = await createPipelineTestRun({ userId, query: 'Question persistante', withJudge: true });
    assert.equal(created.status, 'queued');

    await updatePipelineTestRun(created.id, 'running');
    await updatePipelineTestRun(created.id, 'completed', { query: created.query, answer: 'Réponse conservée' });

    const restored = await getPipelineTestRun(created.id, userId);
    assert.equal(restored?.status, 'completed');
    assert.equal(restored?.result?.answer, 'Réponse conservée');

    const history = await listPipelineTestRuns(userId);
    assert.equal(history[0].id, created.id);
    assert.equal(history[0].result, null, 'la liste légère ne duplique pas le résultat complet');
  } finally {
    await run('DELETE FROM users WHERE id = $1', [userId]);
  }
});
