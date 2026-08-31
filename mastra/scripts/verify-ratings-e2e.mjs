import assert from 'node:assert/strict';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:4112';

const loginResponse = await fetch(`${baseUrl}/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin-e2e@example.test', password: 'Testpass1' }),
});
const login = await loginResponse.json();
assert.equal(loginResponse.status, 200, JSON.stringify(login));
const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie);

const statsResponse = await fetch(`${baseUrl}/admin/ratings/stats`, { headers: { cookie } });
const stats = await statsResponse.json();
assert.equal(statsResponse.status, 200, JSON.stringify(stats));
assert.equal(stats.count, 5);
assert.equal(stats.average, 3);
assert.deepEqual(stats.distribution, [1, 1, 1, 1, 1]);
assert.equal(stats.week, 3);
assert.equal(stats.trend.reduce((sum, day) => sum + day.count, 0), 4);
assert.ok(stats.trend.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)));
assert.ok(stats.trend.every((day) => day.avg >= 1 && day.avg <= 5));

const pageResponse = await fetch(`${baseUrl}/admin/ratings-page`, { headers: { cookie } });
const page = await pageResponse.text();
assert.equal(pageResponse.status, 200);
assert.match(page, /Moyenne quotidienne — 30 derniers jours/);
assert.match(page, /dateLabel\(trend\[i\]\.date\)/);

process.stdout.write(JSON.stringify({
  ok: true,
  totalRatings: stats.count,
  trendRatings: stats.trend.reduce((sum, day) => sum + day.count, 0),
  trendDays: stats.trend.length,
}, null, 2) + '\n');
