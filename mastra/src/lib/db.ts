import Database from 'better-sqlite3';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function resolveProjectRoot(): string {
  const candidates = [
    process.cwd(),
    join(process.cwd(), '..', '..', '..'),
    join(process.cwd(), '..', '..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return process.cwd();
}

const DB_PATH = process.env.DB_PATH || join(resolveProjectRoot(), 'data.db');
let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = initDb();
  }
  return db;
}

function initDb(): Database.Database {
  const isNew = !existsSync(DB_PATH);
  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  if (isNew || !tableExists(database, 'users')) {
    applySchema(database);
  }

  try { chmodSync(DB_PATH, 0o600); } catch {}

  setInterval(() => cleanupExpired(database), 60 * 60 * 1000);
  cleanupExpired(database);

  return database;
}

function tableExists(database: Database.Database, name: string): boolean {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as any;
  return !!row;
}

function runSchema(database: Database.Database, sql: string): void {
  database.exec(sql);
}

function applySchema(database: Database.Database): void {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      email               TEXT UNIQUE NOT NULL,
      password_hash       TEXT NOT NULL,
      salt                TEXT NOT NULL,
      role                TEXT NOT NULL CHECK(role IN ('admin', 'editor')),
      recovery_code_hash  TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_collections (
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      collection_id  INTEGER NOT NULL,
      PRIMARY KEY (user_id, collection_id)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash      TEXT UNIQUE NOT NULL,
      created_by     INTEGER REFERENCES users(id),
      collections    TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      used_by        INTEGER REFERENCES users(id),
      used_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash     TEXT PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      csrf_token     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key            TEXT PRIMARY KEY,
      value          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash     TEXT UNIQUE NOT NULL,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at     TEXT NOT NULL,
      used           INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
      user_id        INTEGER,
      ip             TEXT NOT NULL,
      action         TEXT NOT NULL,
      details        TEXT
    );
  `;
  runSchema(database, schema);
}

function cleanupExpired(database: Database.Database): void {
  database.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  database.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now')").run();
}

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

export interface DbUser {
  id: number;
  email: string;
  password_hash: string;
  salt: string;
  role: 'admin' | 'editor';
  recovery_code_hash: string | null;
  created_at: string;
}

export function findUserByEmail(email: string): DbUser | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as DbUser | undefined;
}

export function findUserById(id: number): DbUser | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUser | undefined;
}

export function createUser(email: string, passwordHash: string, salt: string, role: 'admin' | 'editor', recoveryCodeHash: string): number {
  const result = getDb().prepare(
    'INSERT INTO users (email, password_hash, salt, role, recovery_code_hash) VALUES (?, ?, ?, ?, ?)'
  ).run(email, passwordHash, salt, role, recoveryCodeHash);
  return result.lastInsertRowid as number;
}

export function updateUserPassword(userId: number, passwordHash: string, salt: string, recoveryCodeHash: string): void {
  getDb().prepare(
    'UPDATE users SET password_hash = ?, salt = ?, recovery_code_hash = ? WHERE id = ?'
  ).run(passwordHash, salt, recoveryCodeHash, userId);
}

export function deleteUser(userId: number): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

export function listUsers(): DbUser[] {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as DbUser[];
}

export function countAdmins(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as any;
  return row.count;
}

export function isSetup(): boolean {
  return countAdmins() > 0;
}

export function getUserCollections(userId: number): number[] {
  const rows = getDb().prepare('SELECT collection_id FROM user_collections WHERE user_id = ?').all(userId) as any[];
  return rows.map(r => r.collection_id);
}

export function setUserCollections(userId: number, collectionIds: number[]): void {
  const database = getDb();
  const del = database.prepare('DELETE FROM user_collections WHERE user_id = ?');
  const ins = database.prepare('INSERT INTO user_collections (user_id, collection_id) VALUES (?, ?)');
  const tx = database.transaction(() => {
    del.run(userId);
    for (const cid of collectionIds) {
      ins.run(userId, cid);
    }
  });
  tx();
}

const SESSION_DURATION_HOURS = 24;
const MAX_SESSIONS_PER_USER = 5;

export function createSession(userId: number, tokenHash: string, csrfToken: string): void {
  const database = getDb();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

  const sessions = database.prepare(
    'SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at ASC'
  ).all(userId) as any[];

  if (sessions.length >= MAX_SESSIONS_PER_USER) {
    const toDelete = sessions.slice(0, sessions.length - MAX_SESSIONS_PER_USER + 1);
    for (const s of toDelete) {
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
    }
  }

  database.prepare(
    'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash, userId, csrfToken, expiresAt);
}

export interface DbSession {
  token_hash: string;
  user_id: number;
  csrf_token: string;
  expires_at: string;
}

export function findSession(tokenHash: string): DbSession | undefined {
  return getDb().prepare(
    "SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
  ).get(tokenHash) as DbSession | undefined;
}

export function deleteSession(tokenHash: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserSessions(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
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

export function createInvitation(codeHash: string, createdBy: number, collections: number[], expiresAt: string): number {
  const result = getDb().prepare(
    'INSERT INTO invitations (code_hash, created_by, collections, expires_at) VALUES (?, ?, ?, ?)'
  ).run(codeHash, createdBy, JSON.stringify(collections), expiresAt);
  return result.lastInsertRowid as number;
}

export function findInvitationByHash(codeHash: string): DbInvitation | undefined {
  return getDb().prepare(
    "SELECT * FROM invitations WHERE code_hash = ? AND used_by IS NULL AND expires_at > datetime('now')"
  ).get(codeHash) as DbInvitation | undefined;
}

export function markInvitationUsed(invitationId: number, usedBy: number): void {
  getDb().prepare(
    "UPDATE invitations SET used_by = ?, used_at = datetime('now') WHERE id = ?"
  ).run(usedBy, invitationId);
}

export function listInvitations(): DbInvitation[] {
  return getDb().prepare('SELECT * FROM invitations ORDER BY id DESC').all() as DbInvitation[];
}

export function deleteInvitation(id: number): void {
  getDb().prepare('DELETE FROM invitations WHERE id = ?').run(id);
}

export function createPasswordReset(tokenHash: string, userId: number, expiresAt: string): void {
  getDb().prepare(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(tokenHash, userId, expiresAt);
}

export function findPasswordReset(tokenHash: string): { id: number; user_id: number } | undefined {
  return getDb().prepare(
    "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')"
  ).get(tokenHash) as { id: number; user_id: number } | undefined;
}

export function markResetUsed(id: number): void {
  getDb().prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(id);
}

export function getConfigValue(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as any;
  return row?.value;
}

export function setConfigValue(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM config').all() as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function logAudit(ip: string, action: string, userId?: number, details?: string): void {
  getDb().prepare(
    'INSERT INTO audit_log (ip, action, user_id, details) VALUES (?, ?, ?, ?)'
  ).run(ip, action, userId ?? null, details ?? null);
}

export function getAuditLog(limit = 100): any[] {
  return getDb().prepare(
    `SELECT a.*, u.email as user_email FROM audit_log a
     LEFT JOIN users u ON a.user_id = u.id
     ORDER BY a.id DESC LIMIT ?`
  ).all(limit);
}
