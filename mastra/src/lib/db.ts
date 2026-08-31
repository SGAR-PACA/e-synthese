import { Pool, types } from 'pg';
import { randomBytes } from 'node:crypto';

// pg renvoie les TIMESTAMPTZ comme Date par défaut ; on garde des chaînes
// pour préserver l'API existante (DbUser.created_at: string, etc.).
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => v as unknown as string);

let pool: Pool | undefined;
let schemaApplied = false;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required — la base admin Postgres est obligatoire.');
    }
    pool = new Pool({ connectionString });
    pool.on('error', (err) => console.error('Postgres pool error:', err));
  }
  return pool;
}

// Singleton sur la promesse d'init pour éviter une fenêtre de concurrence :
// plusieurs `ensureSchema()` parallèles déclencheraient des `CREATE TABLE IF
// NOT EXISTS` simultanés, qui ne sont pas atomic-safe dans le catalogue PG.
let schemaPromise: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  if (schemaApplied) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = applySchema();
  return schemaPromise;
}

export async function applySchema(): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id                  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email               TEXT UNIQUE NOT NULL,
      password_hash       TEXT NOT NULL,
      salt                TEXT NOT NULL,
      role                TEXT NOT NULL CHECK(role IN ('admin', 'editor')),
      recovery_code_hash  TEXT,
      created_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    CREATE TABLE IF NOT EXISTS user_collections (
      user_id        INT REFERENCES users(id) ON DELETE CASCADE,
      collection_id  INT NOT NULL,
      PRIMARY KEY (user_id, collection_id)
    );
    -- Chantier 2 : cloisonnement du RAG par groupe Keycloak (administrations).
    -- group_collections : mapping groupe Keycloak -> collections (géré en admin).
    -- L'accès d'un utilisateur = union des collections de ses groupes (un user
    -- peut être dans plusieurs groupes → pas besoin d'exceptions individuelles).
    CREATE TABLE IF NOT EXISTS group_collections (
      group_name     TEXT NOT NULL,
      collection_id  INT NOT NULL,
      PRIMARY KEY (group_name, collection_id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code_hash      TEXT UNIQUE NOT NULL,
      created_by     INT REFERENCES users(id),
      collections    TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      used_by        INT REFERENCES users(id),
      used_at        TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash     TEXT PRIMARY KEY,
      user_id        INT REFERENCES users(id) ON DELETE CASCADE,
      csrf_token     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    -- Session opaque et révocable de la visionneuse OIDC. Le cookie navigateur
    -- ne contient que le token aléatoire ; les droits et le lien avec la session
    -- Keycloak restent côté serveur.
    CREATE TABLE IF NOT EXISTS source_sessions (
      token_hash     TEXT PRIMARY KEY,
      sub            TEXT NOT NULL,
      oidc_sid       TEXT,
      groups         JSONB NOT NULL DEFAULT '[]'::jsonb,
      expires_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    CREATE INDEX IF NOT EXISTS idx_source_sessions_expiry ON source_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_source_sessions_oidc_sid ON source_sessions(oidc_sid);
    CREATE INDEX IF NOT EXISTS idx_source_sessions_sub ON source_sessions(sub);
    CREATE TABLE IF NOT EXISTS source_logout_tokens (
      jti            TEXT PRIMARY KEY,
      expires_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_logout_tokens_expiry ON source_logout_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS config (
      key            TEXT PRIMARY KEY,
      value          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      token_hash     TEXT UNIQUE NOT NULL,
      user_id        INT REFERENCES users(id) ON DELETE CASCADE,
      expires_at     TEXT NOT NULL,
      used           BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      timestamp      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      user_id        INT,
      ip             TEXT NOT NULL,
      action         TEXT NOT NULL,
      details        TEXT
    );
    CREATE TABLE IF NOT EXISTS rag_runs (
      id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      source       TEXT NOT NULL,
      question     TEXT NOT NULL,
      answer       TEXT NOT NULL,
      used_chunks  JSONB NOT NULL DEFAULT '[]',
      wide_k       INT NOT NULL DEFAULT 0,
      gen_model    TEXT,
      is_refusal   BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS rag_scores (
      id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id       INT NOT NULL REFERENCES rag_runs(id) ON DELETE CASCADE,
      metric       TEXT NOT NULL,
      score        REAL NOT NULL,
      reason       TEXT NOT NULL DEFAULT '',
      judge_model  TEXT,
      created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    CREATE INDEX IF NOT EXISTS idx_rag_scores_run    ON rag_scores(run_id);
    CREATE INDEX IF NOT EXISTS idx_rag_scores_metric ON rag_scores(metric);
    CREATE INDEX IF NOT EXISTS idx_rag_runs_created  ON rag_runs(created_at);
    CREATE TABLE IF NOT EXISTS pipeline_test_runs (
      id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query        TEXT NOT NULL,
      with_judge   BOOLEAN NOT NULL DEFAULT false,
      status       TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
      result       JSONB,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      updated_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_test_runs_user_created
      ON pipeline_test_runs(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS document_files (
      id                  TEXT PRIMARY KEY,
      albert_document_id  TEXT,
      collection_id       INT,
      filename            TEXT NOT NULL,
      s3_key_searchable   TEXT,
      status              TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
      error               TEXT,
      ocr_applied         BOOLEAN NOT NULL DEFAULT false,
      uploaded_by         INT,
      created_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      updated_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    CREATE INDEX IF NOT EXISTS idx_document_files_status ON document_files(status);
    CREATE INDEX IF NOT EXISTS idx_document_files_albert ON document_files(albert_document_id);
    -- Coordonnées de surlignage calculées sur le PDF searchable au moment de
    -- l'ingestion. La visionneuse ne fait pas de recherche approximative à la
    -- volée : elle ne sert que les ancres vérifiées ; un manifeste incomplet
    -- peut donc tout de même fournir un surlignage partiel explicitement signalé.
    CREATE TABLE IF NOT EXISTS document_highlight_manifests (
      document_id          TEXT PRIMARY KEY,
      s3_key_searchable    TEXT NOT NULL,
      complete             BOOLEAN NOT NULL DEFAULT false,
      chunk_count          INT NOT NULL DEFAULT 0,
      verified_chunk_count INT NOT NULL DEFAULT 0,
      coordinate_space     TEXT NOT NULL DEFAULT 'mupdf-top-left',
      error                TEXT,
      created_at           TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    ALTER TABLE document_highlight_manifests
      ADD COLUMN IF NOT EXISTS coordinate_space TEXT NOT NULL DEFAULT 'mupdf-top-left';
    CREATE TABLE IF NOT EXISTS document_chunk_highlights (
      document_id  TEXT NOT NULL,
      chunk_id     TEXT NOT NULL,
      words        INT NOT NULL,
      matched      INT NOT NULL,
      matched_tokens INT NOT NULL DEFAULT 0,
      verified     BOOLEAN NOT NULL DEFAULT false,
      pages        JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      PRIMARY KEY (document_id, chunk_id)
    );
    ALTER TABLE document_chunk_highlights
      ADD COLUMN IF NOT EXISTS matched_tokens INT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_document_chunk_highlights_doc ON document_chunk_highlights(document_id);
    CREATE TABLE IF NOT EXISTS user_ratings (
      id               INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sub              TEXT NOT NULL,
      email            TEXT,
      message_id       TEXT NOT NULL,
      conversation_id  TEXT,
      rating           INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment          TEXT,
      question         TEXT,
      answer           TEXT,
      created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      updated_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      UNIQUE (sub, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_ratings_created ON user_ratings(created_at);
  `;
  // `CREATE TABLE IF NOT EXISTS` n'est pas sûr face à deux processus qui créent
  // simultanément les mêmes séquences implicites (IDENTITY). Le verrou advisory
  // sérialise la migration entre workers de tests et replicas Mastra partageant
  // la même base, puis est libéré avec la connexion même en cas d'échec.
  const schemaLockId = 1_163_088_456;
  const client = await getPool().connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [schemaLockId]);
    locked = true;
    await client.query(sql);
    schemaApplied = true;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [schemaLockId]).catch(() => undefined);
    }
    client.release();
  }
}

export async function query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<T[]> {
  await ensureSchema();
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function run(sql: string, params?: any[]): Promise<void> {
  await ensureSchema();
  await getPool().query(sql, params);
}

const NOW_ISO_SQL = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

async function cleanupExpired(): Promise<void> {
  await run(`DELETE FROM sessions WHERE expires_at < ${NOW_ISO_SQL}`);
  await run(`DELETE FROM source_sessions WHERE expires_at < ${NOW_ISO_SQL}`);
  await run(`DELETE FROM source_logout_tokens WHERE expires_at < ${NOW_ISO_SQL}`);
  await run(`DELETE FROM password_resets WHERE expires_at < ${NOW_ISO_SQL}`);
}

// .unref() : ce timer périodique ne doit pas, à lui seul, maintenir le process
// en vie (sinon `node --test` ne se termine jamais dès qu'un test importe db.ts).
// En production, le serveur HTTP garde le process actif — l'interval tourne donc
// normalement.
setInterval(() => {
  cleanupExpired().catch((err) => console.error('cleanup error:', err));
}, 60 * 60 * 1000).unref();

// Nettoyage immédiat au démarrage (parité avec la version SQLite). Silencieux
// hors base configurée (ex. tests sans DATABASE_URL) : rien à nettoyer.
if (process.env.DATABASE_URL) {
  cleanupExpired().catch((err) => console.error('cleanup error:', err));
}

// ---- Chiffrement (synchrone — ne touche pas la base) ----
let encryptionKey: string | null = null;

export function getEncryptionKey(): string {
  if (encryptionKey) return encryptionKey;
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey.length >= 64) {
    encryptionKey = envKey.slice(0, 64);
    return encryptionKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY is required in production. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  console.warn('[WARNING] No ENCRYPTION_KEY set. Using temporary key. Secrets will be lost on restart.');
  encryptionKey = randomBytes(32).toString('hex');
  return encryptionKey;
}

// ---- Types ----
export interface DbUser {
  id: number;
  email: string;
  password_hash: string;
  salt: string;
  role: 'admin' | 'editor';
  recovery_code_hash: string | null;
  created_at: string;
}

export interface DbSession {
  token_hash: string;
  user_id: number;
  csrf_token: string;
  expires_at: string;
}

export interface DbSourceSession {
  token_hash: string;
  sub: string;
  oidc_sid: string | null;
  groups: unknown;
  expires_at: string;
  created_at: string;
}

export interface DbInvitation {
  id: number;
  code_hash: string;
  created_by: number;
  collections: string;
  expires_at: string;
  used_by: number | null;
  used_at: string | null;
}

// ---- Users ----
export async function findUserByEmail(email: string): Promise<DbUser | undefined> {
  const rows = await query<DbUser>('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

export async function findUserById(id: number): Promise<DbUser | undefined> {
  const rows = await query<DbUser>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

export async function createUser(email: string, passwordHash: string, salt: string, role: 'admin' | 'editor', recoveryCodeHash: string): Promise<number> {
  const rows = await query<{ id: number }>(
    'INSERT INTO users (email, password_hash, salt, role, recovery_code_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [email, passwordHash, salt, role, recoveryCodeHash]
  );
  return rows[0].id;
}

export async function updateUserPassword(userId: number, passwordHash: string, salt: string, recoveryCodeHash: string): Promise<void> {
  await run(
    'UPDATE users SET password_hash = $1, salt = $2, recovery_code_hash = $3 WHERE id = $4',
    [passwordHash, salt, recoveryCodeHash, userId]
  );
}

export async function deleteUser(userId: number): Promise<void> {
  await run('DELETE FROM users WHERE id = $1', [userId]);
}

export async function listUsers(): Promise<DbUser[]> {
  return query<DbUser>('SELECT * FROM users ORDER BY created_at DESC');
}

export async function countAdmins(): Promise<number> {
  const rows = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin'");
  return parseInt(rows[0].count, 10);
}

export async function isSetup(): Promise<boolean> {
  return (await countAdmins()) > 0;
}

// ---- User collections ----
export async function getUserCollections(userId: number): Promise<number[]> {
  const rows = await query<{ collection_id: number }>('SELECT collection_id FROM user_collections WHERE user_id = $1', [userId]);
  return rows.map((r) => r.collection_id);
}

export async function setUserCollections(userId: number, collectionIds: number[]): Promise<void> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_collections WHERE user_id = $1', [userId]);
    for (const cid of collectionIds) {
      await client.query('INSERT INTO user_collections (user_id, collection_id) VALUES ($1, $2)', [userId, cid]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- Cloisonnement RAG par groupe Keycloak (Chantier 2) ----

// Collections autorisées pour un ensemble de groupes Keycloak (union, dédupliquée).
export async function getCollectionsForGroups(groups: string[]): Promise<number[]> {
  if (groups.length === 0) return [];
  const rows = await query<{ collection_id: number }>(
    'SELECT DISTINCT collection_id FROM group_collections WHERE group_name = ANY($1)',
    [groups],
  );
  return rows.map((r) => r.collection_id);
}

// Toutes les paires (groupe, collection) pour l'écran d'admin.
export async function listGroupCollections(): Promise<{ group_name: string; collection_id: number }[]> {
  return query<{ group_name: string; collection_id: number }>(
    'SELECT group_name, collection_id FROM group_collections ORDER BY group_name, collection_id',
  );
}

// Remplace atomiquement le jeu de collections d'un groupe.
export async function setGroupCollections(group: string, collectionIds: number[]): Promise<void> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM group_collections WHERE group_name = $1', [group]);
    for (const cid of collectionIds) {
      await client.query('INSERT INTO group_collections (group_name, collection_id) VALUES ($1, $2)', [group, cid]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Supprime entièrement le mapping d'un groupe.
export async function deleteGroupMapping(group: string): Promise<void> {
  await run('DELETE FROM group_collections WHERE group_name = $1', [group]);
}

// ---- Sessions ----
const SESSION_DURATION_HOURS = 24;
const MAX_SESSIONS_PER_USER = 5;

export async function createSession(userId: number, tokenHash: string, csrfToken: string): Promise<void> {
  await ensureSchema();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sessions = await client.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    if (sessions.rows.length >= MAX_SESSIONS_PER_USER) {
      const toDelete = sessions.rows.slice(0, sessions.rows.length - MAX_SESSIONS_PER_USER + 1);
      for (const s of toDelete) {
        await client.query('DELETE FROM sessions WHERE token_hash = $1', [s.token_hash]);
      }
    }
    await client.query(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, userId, csrfToken, expiresAt]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findSession(tokenHash: string): Promise<DbSession | undefined> {
  const rows = await query<DbSession>(
    `SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > ${NOW_ISO_SQL}`,
    [tokenHash]
  );
  return rows[0];
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await run('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteUserSessions(userId: number): Promise<void> {
  await run('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// ---- Sessions visionneuse OIDC ----
export async function createSourceSession(
  tokenHash: string,
  sub: string,
  oidcSid: string | undefined,
  groups: string[],
  expiresAt: string,
): Promise<void> {
  await run(
    `INSERT INTO source_sessions (token_hash, sub, oidc_sid, groups, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [tokenHash, sub, oidcSid ?? null, JSON.stringify(groups), expiresAt],
  );
}

export async function findSourceSession(tokenHash: string): Promise<DbSourceSession | undefined> {
  const rows = await query<DbSourceSession>(
    `SELECT * FROM source_sessions
     WHERE token_hash = $1 AND expires_at > ${NOW_ISO_SQL}`,
    [tokenHash],
  );
  return rows[0];
}

export async function deleteSourceSession(tokenHash: string): Promise<void> {
  await run('DELETE FROM source_sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteSourceSessionsByOidcSid(oidcSid: string): Promise<void> {
  await run('DELETE FROM source_sessions WHERE oidc_sid = $1', [oidcSid]);
}

export async function deleteSourceSessionsBySub(sub: string): Promise<void> {
  await run('DELETE FROM source_sessions WHERE sub = $1', [sub]);
}

// Claim + révocation dans une seule transaction : les retries Keycloak sont
// idempotents, mais un ancien logout_token ne peut pas révoquer une nouvelle
// session entre le claim et la suppression.
export async function revokeSourceSessionsForLogout(
  jti: string,
  expiresAt: string,
  oidcSid?: string,
  sub?: string,
): Promise<boolean> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{ jti: string }>(
      `INSERT INTO source_logout_tokens (jti, expires_at) VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING RETURNING jti`,
      [jti, expiresAt],
    );
    if (claimed.rows.length === 0) {
      await client.query('COMMIT');
      return false;
    }
    if (oidcSid) {
      await client.query('DELETE FROM source_sessions WHERE oidc_sid = $1', [oidcSid]);
    } else if (sub) {
      await client.query('DELETE FROM source_sessions WHERE sub = $1', [sub]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- Invitations ----
export async function createInvitation(codeHash: string, createdBy: number, collections: number[], expiresAt: string): Promise<number> {
  const rows = await query<{ id: number }>(
    'INSERT INTO invitations (code_hash, created_by, collections, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [codeHash, createdBy, JSON.stringify(collections), expiresAt]
  );
  return rows[0].id;
}

export async function findInvitationByHash(codeHash: string): Promise<DbInvitation | undefined> {
  const rows = await query<DbInvitation>(
    `SELECT * FROM invitations WHERE code_hash = $1 AND used_by IS NULL AND expires_at > ${NOW_ISO_SQL}`,
    [codeHash]
  );
  return rows[0];
}

export async function markInvitationUsed(invitationId: number, usedBy: number): Promise<void> {
  await run(
    `UPDATE invitations SET used_by = $1, used_at = ${NOW_ISO_SQL} WHERE id = $2`,
    [usedBy, invitationId]
  );
}

export async function listInvitations(): Promise<DbInvitation[]> {
  return query<DbInvitation>('SELECT * FROM invitations ORDER BY id DESC');
}

export async function deleteInvitation(id: number): Promise<void> {
  await run('DELETE FROM invitations WHERE id = $1', [id]);
}

// ---- Password resets ----
export async function createPasswordReset(tokenHash: string, userId: number, expiresAt: string): Promise<void> {
  await run(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, userId, expiresAt]
  );
}

export async function findPasswordReset(tokenHash: string): Promise<{ id: number; user_id: number } | undefined> {
  const rows = await query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used = false AND expires_at > ${NOW_ISO_SQL}`,
    [tokenHash]
  );
  return rows[0];
}

export async function markResetUsed(id: number): Promise<void> {
  await run('UPDATE password_resets SET used = true WHERE id = $1', [id]);
}

// ---- Config ----
export async function getConfigValue(key: string): Promise<string | undefined> {
  const rows = await query<{ value: string }>('SELECT value FROM config WHERE key = $1', [key]);
  return rows[0]?.value;
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await run(
    'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

export async function getAllConfig(): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM config');
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// ---- Audit log ----
export async function logAudit(ip: string, action: string, userId?: number, details?: string): Promise<void> {
  await run(
    'INSERT INTO audit_log (ip, action, user_id, details) VALUES ($1, $2, $3, $4)',
    [ip, action, userId ?? null, details ?? null]
  );
}

export async function getAuditLog(limit = 100): Promise<any[]> {
  return query(
    `SELECT a.*, u.email as user_email FROM audit_log a
     LEFT JOIN users u ON a.user_id = u.id
     ORDER BY a.id DESC LIMIT $1`,
    [limit]
  );
}

// ---- Évaluation RAG (notation) ----
export interface RagChunk { name: string; content: string; score: number; url: string; documentId?: string; chunkId?: string; collectionId?: number }

export interface RagRunInput {
  source: 'live' | 'on-demand' | 'test';
  question: string;
  answer: string;
  usedChunks: RagChunk[];
  wideK: number;
  genModel: string | null;
  isRefusal: boolean;
}

export interface RagRunRecord {
  id: number;
  created_at: string;
  source: 'live' | 'on-demand' | 'test';
  question: string;
  answer: string;
  used_chunks: RagChunk[];
  wide_k: number;
  gen_model: string | null;
  is_refusal: boolean;
}

export interface RagScoreInput {
  metric: string;
  score: number;
  reason: string;
  judgeModel: string | null;
}

export interface ScoreFilters {
  metric?: string;
  from?: string;
  to?: string;
  minScore?: number;
  maxScore?: number;
  source?: string;
  scored?: boolean;
  limit?: number;
  offset?: number;
}

export async function insertRagRun(r: RagRunInput): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO rag_runs (source, question, answer, used_chunks, wide_k, gen_model, is_refusal)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
    [r.source, r.question, r.answer, JSON.stringify(r.usedChunks), r.wideK, r.genModel, r.isRefusal],
  );
  return rows[0].id;
}

export async function getRagRunById(id: number): Promise<RagRunRecord | null> {
  const rows = await query<RagRunRecord>(
    `SELECT id, created_at, source, question, answer, used_chunks, wide_k, gen_model, is_refusal
       FROM rag_runs WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    used_chunks: Array.isArray(row.used_chunks) ? row.used_chunks : [],
  };
}

export async function hasRagScores(runId: number): Promise<boolean> {
  const rows = await query<{ has_scores: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM rag_scores WHERE run_id = $1) AS has_scores',
    [runId],
  );
  return Boolean(rows[0]?.has_scores);
}

export async function updateRagRunWideK(runId: number, wideK: number): Promise<void> {
  await run('UPDATE rag_runs SET wide_k = $2 WHERE id = $1', [runId, wideK]);
}

export async function insertRagScores(runId: number, scores: RagScoreInput[]): Promise<void> {
  for (const s of scores) {
    await run(
      `INSERT INTO rag_scores (run_id, metric, score, reason, judge_model)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, s.metric, s.score, s.reason, s.judgeModel],
    );
  }
}

/** Moyennes par métrique (calculées en SQL), sur les notes filtrées. */
export async function getScoreAverages(f: ScoreFilters): Promise<Record<string, { avg: number; n: number }>> {
  const rows = await query<{ metric: string; avg: number; n: number }>(
    `SELECT s.metric, AVG(s.score)::float AS avg, COUNT(*)::int AS n
       FROM rag_scores s JOIN rag_runs r ON r.id = s.run_id
      WHERE ($1::text  IS NULL OR r.source   = $1)
        AND ($2::text  IS NULL OR r.created_at >= $2)
        AND ($3::text  IS NULL OR r.created_at <= $3)
        AND ($4::text  IS NULL OR s.metric   = $4)
        AND ($5::float IS NULL OR s.score   >= $5)
        AND ($6::float IS NULL OR s.score   <= $6)
        AND ($7::boolean IS NULL OR (($7 = true AND EXISTS (SELECT 1 FROM rag_scores sx WHERE sx.run_id = r.id))
                                  OR ($7 = false AND NOT EXISTS (SELECT 1 FROM rag_scores sx WHERE sx.run_id = r.id))))
      GROUP BY s.metric`,
    [f.source ?? null, f.from ?? null, f.to ?? null, f.metric ?? null, f.minScore ?? null, f.maxScore ?? null, f.scored ?? null],
  );
  const out: Record<string, { avg: number; n: number }> = {};
  for (const row of rows) out[row.metric] = { avg: Math.round(row.avg * 1000) / 1000, n: row.n };
  return out;
}

export interface ScoreItem {
  run_id: number;
  created_at: string;
  source: string;
  question: string;
  answer: string;
  is_refusal: boolean;
  scores: { metric: string; score: number; reason: string }[];
}

/** Page de runs (filtres niveau run + existence d'une note correspondant aux filtres de métrique/score). */
export async function getScores(f: ScoreFilters): Promise<{ count: number; items: ScoreItem[] }> {
  const limit = f.limit ?? 50;
  const offset = f.offset ?? 0;
  const filterParams = [f.source ?? null, f.from ?? null, f.to ?? null, f.metric ?? null, f.minScore ?? null, f.maxScore ?? null, f.scored ?? null];

  const whereRuns =
    `($1::text  IS NULL OR r.source   = $1)
     AND ($2::text  IS NULL OR r.created_at >= $2)
     AND ($3::text  IS NULL OR r.created_at <= $3)
     AND ( ($4::text IS NULL AND $5::float IS NULL AND $6::float IS NULL)
           OR EXISTS (SELECT 1 FROM rag_scores s WHERE s.run_id = r.id
                        AND ($4::text  IS NULL OR s.metric = $4)
                        AND ($5::float IS NULL OR s.score >= $5)
                        AND ($6::float IS NULL OR s.score <= $6)) )
     AND ($7::boolean IS NULL OR (($7 = true AND EXISTS (SELECT 1 FROM rag_scores sx WHERE sx.run_id = r.id))
                               OR ($7 = false AND NOT EXISTS (SELECT 1 FROM rag_scores sx WHERE sx.run_id = r.id))))`;

  const countRows = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM rag_runs r WHERE ${whereRuns}`,
    filterParams,
  );
  const count = countRows[0]?.count ?? 0;

  const runs = await query<{ id: number; created_at: string; source: string; question: string; answer: string; is_refusal: boolean }>(
    `SELECT r.id, r.created_at, r.source, r.question, r.answer, r.is_refusal
       FROM rag_runs r WHERE ${whereRuns}
      ORDER BY r.created_at DESC
      LIMIT $8 OFFSET $9`,
    [...filterParams, limit, offset],
  );

  const ids = runs.map((r) => r.id);
  const scoreRows = ids.length
    ? await query<{ run_id: number; metric: string; score: number; reason: string }>(
        `SELECT run_id, metric, score, reason FROM rag_scores WHERE run_id = ANY($1::int[]) ORDER BY id`,
        [ids],
      )
    : [];

  const items: ScoreItem[] = runs.map((r) => ({
    run_id: r.id,
    created_at: r.created_at,
    source: r.source,
    question: r.question,
    answer: r.answer,
    is_refusal: r.is_refusal,
    scores: scoreRows.filter((s) => s.run_id === r.id).map((s) => ({ metric: s.metric, score: s.score, reason: s.reason })),
  }));

  return { count, items };
}

// ---- Banc de test pipeline persistant ----
export type PipelineTestStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PipelineTestRun {
  id: number;
  user_id: number;
  query: string;
  with_judge: boolean;
  status: PipelineTestStatus;
  result: Record<string, any> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function createPipelineTestRun(input: {
  userId: number;
  query: string;
  withJudge: boolean;
}): Promise<PipelineTestRun> {
  const rows = await query<PipelineTestRun>(
    `INSERT INTO pipeline_test_runs (user_id, query, with_judge, status)
     VALUES ($1, $2, $3, 'queued') RETURNING *`,
    [input.userId, input.query, input.withJudge],
  );
  return rows[0];
}

export async function updatePipelineTestRun(
  id: number,
  status: PipelineTestStatus,
  result: Record<string, any> | null = null,
  error: string | null = null,
): Promise<void> {
  await run(
    `UPDATE pipeline_test_runs
        SET status = $2, result = $3::jsonb, error = $4, updated_at = ${NOW_ISO_SQL}
      WHERE id = $1`,
    [id, status, result == null ? null : JSON.stringify(result), error],
  );
}

export async function getPipelineTestRun(id: number, userId: number): Promise<PipelineTestRun | null> {
  const rows = await query<PipelineTestRun>(
    `SELECT * FROM pipeline_test_runs WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function listPipelineTestRuns(userId: number, limit = 30): Promise<PipelineTestRun[]> {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 30;
  return query<PipelineTestRun>(
    `SELECT id, user_id, query, with_judge, status, NULL::jsonb AS result,
            error, created_at, updated_at
       FROM pipeline_test_runs
      WHERE user_id = $1
      ORDER BY id DESC LIMIT $2`,
    [userId, boundedLimit],
  );
}

// ---- Fichiers documents (visionneuse de sources) ----
export type DocumentFileStatus = 'processing' | 'ready' | 'failed';

export interface DocumentFile {
  id: string;
  albert_document_id: string | null;
  collection_id: number | null;
  filename: string;
  s3_key_searchable: string | null;
  status: DocumentFileStatus;
  error: string | null;
  ocr_applied: boolean;
  uploaded_by: number | null;
  created_at: string;
  updated_at: string;
}

// Transition d'état PURE (testée). Un job terminal (ready/failed) ne bouge plus.
export function nextJobStatus(
  current: DocumentFileStatus,
  event: 'ocr_done' | 'albert_done' | 'error',
): DocumentFileStatus {
  if (current !== 'processing') return current;
  if (event === 'error') return 'failed';
  if (event === 'albert_done') return 'ready';
  return 'processing'; // ocr_done : étape intermédiaire
}

export async function createDocumentFile(input: {
  id: string;
  collectionId: number | null;
  filename: string;
  uploadedBy: number | null;
}): Promise<void> {
  await run(
    `INSERT INTO document_files (id, collection_id, filename, status, uploaded_by)
     VALUES ($1, $2, $3, 'processing', $4)`,
    [input.id, input.collectionId, input.filename, input.uploadedBy],
  );
}

// Prend un job en attente de façon concurrent-safe (plusieurs instances Mastra).
export async function claimNextProcessingFile(): Promise<DocumentFile | undefined> {
  const rows = await query<DocumentFile>(
    `SELECT * FROM document_files
     WHERE status = 'processing'
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
  );
  return rows[0];
}

export async function markFileReady(
  id: string,
  albertDocumentId: string,
  s3KeySearchable: string,
  ocrApplied: boolean,
): Promise<void> {
  await run(
    `UPDATE document_files
     SET status = 'ready', albert_document_id = $2, s3_key_searchable = $3,
         ocr_applied = $4, error = NULL, updated_at = ${NOW_ISO_SQL}
     WHERE id = $1`,
    [id, albertDocumentId, s3KeySearchable, ocrApplied],
  );
}

export async function markFileFailed(id: string, message: string): Promise<void> {
  await run(
    `UPDATE document_files
     SET status = 'failed', error = $2, updated_at = ${NOW_ISO_SQL}
     WHERE id = $1`,
    [id, message.slice(0, 500)],
  );
}

export interface DocumentHighlightManifest {
  document_id: string;
  s3_key_searchable: string;
  complete: boolean;
  chunk_count: number;
  verified_chunk_count: number;
  coordinate_space: string;
  error: string | null;
  created_at: string;
}

export interface DocumentChunkHighlight {
  document_id: string;
  chunk_id: string;
  words: number;
  matched: number;
  matched_tokens: number;
  verified: boolean;
  pages: any[];
  created_at: string;
}

export async function replaceDocumentHighlightAnchors(input: {
  documentId: string;
  s3KeySearchable: string;
  complete: boolean;
  error?: string | null;
  anchors: Array<{
    id?: string;
    words: number;
    matched: number;
    matchedTokens?: number;
    verified: boolean;
    pages: any[];
  }>;
}): Promise<void> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM document_chunk_highlights WHERE document_id = $1', [input.documentId]);
    for (const anchor of input.anchors) {
      if (!anchor.id) continue;
      await client.query(
        `INSERT INTO document_chunk_highlights
           (document_id, chunk_id, words, matched, matched_tokens, verified, pages)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          input.documentId,
          anchor.id,
          anchor.words,
          anchor.matched,
          anchor.matchedTokens ?? anchor.words,
          anchor.verified,
          JSON.stringify(anchor.pages),
        ],
      );
    }
    await client.query(
      `INSERT INTO document_highlight_manifests
         (document_id, s3_key_searchable, complete, chunk_count, verified_chunk_count, coordinate_space, error)
       VALUES ($1, $2, $3, $4, $5, 'pdf-user', $6)
       ON CONFLICT (document_id) DO UPDATE SET
         s3_key_searchable = EXCLUDED.s3_key_searchable,
         complete = EXCLUDED.complete,
         chunk_count = EXCLUDED.chunk_count,
         verified_chunk_count = EXCLUDED.verified_chunk_count,
         coordinate_space = EXCLUDED.coordinate_space,
         error = EXCLUDED.error,
         created_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      [
        input.documentId,
        input.s3KeySearchable,
        input.complete,
        input.anchors.length,
        input.anchors.filter((a) => a.verified).length,
        input.error ?? null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getDocumentHighlightManifest(
  documentId: string,
): Promise<DocumentHighlightManifest | undefined> {
  const rows = await query<DocumentHighlightManifest>(
    `SELECT document_id, s3_key_searchable, complete, chunk_count,
            verified_chunk_count, coordinate_space, error, created_at
       FROM document_highlight_manifests
      WHERE document_id = $1`,
    [documentId],
  );
  return rows[0];
}

export async function getDocumentChunkHighlights(
  documentId: string,
  chunkIds: string[],
): Promise<DocumentChunkHighlight[]> {
  if (chunkIds.length === 0) return [];
  return query<DocumentChunkHighlight>(
    `SELECT document_id, chunk_id, words, matched, matched_tokens, verified, pages, created_at
       FROM document_chunk_highlights
      WHERE document_id = $1 AND chunk_id = ANY($2::text[])`,
    [documentId, chunkIds],
  );
}

// Documents prêts dont les ancres n'existent pas encore ou dont la couverture
// n'a pas été validée. Le worker les traite progressivement pour ne pas faire
// exploser le quota Albert au redémarrage.
export async function getDocumentsNeedingHighlightBackfill(limit = 20): Promise<DocumentFile[]> {
  return query<DocumentFile>(
    `SELECT df.*
       FROM document_files df
       LEFT JOIN document_highlight_manifests hm
         ON hm.document_id = df.albert_document_id
        AND hm.s3_key_searchable = df.s3_key_searchable
      WHERE df.status = 'ready'
        AND df.albert_document_id IS NOT NULL
        AND df.s3_key_searchable IS NOT NULL
        AND (
          hm.document_id IS NULL
          OR hm.coordinate_space <> 'pdf-user'
          OR (
            hm.complete = false
            AND (
              hm.error IS NULL
              OR hm.error LIKE 'Chunks Albert indisponibles:%'
            )
          )
        )
      ORDER BY df.updated_at ASC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
}

export async function getDocumentFileByAlbertId(
  albertDocumentId: string,
): Promise<DocumentFile | undefined> {
  const rows = await query<DocumentFile>(
    `SELECT * FROM document_files WHERE albert_document_id = $1`,
    [albertDocumentId],
  );
  return rows[0];
}

// Résout les documents par leur NOM de fichier. Nécessaire car Albert expose DEUX
// espaces d'ID : celui de la recherche (chunk.document_id) diffère de celui de
// l'upload (stocké dans albert_document_id). Le nom (document_name des chunks =
// filename stocké) fait le pont.
//
// Renvoie TOUTES les copies `ready` de ce nom (un même fichier peut vivre dans
// plusieurs collections : doublons inter-groupes / copies legacy). Le choix de
// l'exemplaire à citer — cloisonné aux collections autorisées — est délégué à
// `pickDocumentFile` (lib/source-resolve.ts), pour éviter qu'un lien pointe vers
// un homonyme d'une collection que l'utilisateur ne peut pas voir (→ refus 403).
export async function getDocumentFilesByFilename(
  filename: string,
): Promise<DocumentFile[]> {
  return query<DocumentFile>(
    `SELECT * FROM document_files WHERE filename = $1 AND status = 'ready'
     ORDER BY created_at DESC`,
    [filename],
  );
}

// Supprime la ligne et retourne l'ancienne valeur (pour effacer la clé S3 associée).
export async function deleteDocumentFileByAlbertId(
  albertDocumentId: string,
): Promise<DocumentFile | undefined> {
  await run('DELETE FROM document_chunk_highlights WHERE document_id = $1', [albertDocumentId]);
  await run('DELETE FROM document_highlight_manifests WHERE document_id = $1', [albertDocumentId]);
  const rows = await query<DocumentFile>(
    `DELETE FROM document_files WHERE albert_document_id = $1 RETURNING *`,
    [albertDocumentId],
  );
  return rows[0];
}

// ---- Notation utilisateur ----
export interface UserRating {
  id: number;
  sub: string;
  email: string | null;
  message_id: string;
  conversation_id: string | null;
  rating: number;
  comment: string | null;
  question: string | null;
  answer: string | null;
  created_at: string;
  updated_at: string;
}

export async function upsertRating(input: {
  sub: string;
  email: string | null;
  message_id: string;
  conversation_id: string;
  rating: number;
  comment: string;
  question: string;
  answer: string;
}): Promise<void> {
  await run(
    `INSERT INTO user_ratings (sub, email, message_id, conversation_id, rating, comment, question, answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (sub, message_id) DO UPDATE SET
       email = EXCLUDED.email,
       conversation_id = EXCLUDED.conversation_id,
       rating = EXCLUDED.rating,
       comment = EXCLUDED.comment,
       question = EXCLUDED.question,
       answer = EXCLUDED.answer,
       updated_at = ${NOW_ISO_SQL}`,
    [input.sub, input.email, input.message_id, input.conversation_id, input.rating, input.comment, input.question, input.answer],
  );
}

export async function getRatingForUser(sub: string, messageId: string): Promise<UserRating | undefined> {
  const rows = await query<UserRating>(
    `SELECT * FROM user_ratings WHERE sub = $1 AND message_id = $2`,
    [sub, messageId],
  );
  return rows[0];
}

export async function listRatings(limit: number, offset: number): Promise<UserRating[]> {
  return query<UserRating>(
    `SELECT * FROM user_ratings ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

export async function getRatingStats(): Promise<{ count: number; average: number }> {
  const rows = await query<{ count: number; average: number | null }>(
    `SELECT COUNT(*)::int AS count, AVG(rating)::float AS average FROM user_ratings`,
  );
  return { count: Number(rows[0]?.count ?? 0), average: Number(rows[0]?.average ?? 0) };
}

// Calcule les KPIs agrégés pour le dashboard admin de notation.
// distribution = tableau de 5 entiers (index 0 = 1★ … index 4 = 5★).
// trend = moyenne et nombre de notes par jour sur les 30 derniers jours,
// trié par date croissante.
export async function getRatingDashboardStats(): Promise<{
  count: number; average: number; pct_high: number; week: number;
  distribution: number[]; trend: { date: string; avg: number; count: number }[];
}> {
  const agg = await query<{ count: string; average: string | null; high: string; week: string }>(
    `SELECT COUNT(*)::int AS count,
            AVG(rating)::float AS average,
            COUNT(*) FILTER (WHERE rating >= 4)::int AS high,
            COUNT(*) FILTER (WHERE created_at >= to_char((now() - interval '7 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::int AS week
       FROM user_ratings`,
  );
  const dist = await query<{ rating: number; n: string }>(
    `SELECT rating, COUNT(*)::int AS n FROM user_ratings GROUP BY rating`,
  );
  const distribution = [0, 0, 0, 0, 0];
  for (const d of dist) if (d.rating >= 1 && d.rating <= 5) distribution[d.rating - 1] = Number(d.n);
  const tr = await query<{ d: string; avg: string; n: string }>(
    `SELECT substring(created_at for 10) AS d, AVG(rating)::float AS avg, COUNT(*)::int AS n
       FROM user_ratings
      WHERE created_at >= to_char((now() - interval '30 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      GROUP BY d ORDER BY d`,
  );
  const a = agg[0] ?? { count: 0, average: 0, high: 0, week: 0 } as any;
  const count = Number(a.count) || 0;
  return {
    count,
    average: a.average ? Number(a.average) : 0,
    pct_high: count ? Math.round((Number(a.high) / count) * 100) : 0,
    week: Number(a.week) || 0,
    distribution,
    trend: tr.map((r) => ({ date: r.d, avg: Number(r.avg), count: Number(r.n) })),
  };
}
