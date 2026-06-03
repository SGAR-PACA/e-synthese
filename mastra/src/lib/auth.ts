import { hashPassword, verifyPassword, sha256, safeCompareHex, generateToken, generateInviteCode, generateRecoveryCode, validatePassword } from './crypto.js';
import * as db from './db.js';

export { validatePassword } from './crypto.js';

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export function sessionCookieString(token: string): string {
  const maxAge = SESSION_DURATION_MS / 1000;
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `session=${token}; HttpOnly; SameSite=Strict;${secure} Max-Age=${maxAge}; Path=/`;
}

export function clearSessionCookie(): string {
  return 'session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/';
}

export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

export async function isSetup(): Promise<boolean> {
  return db.isSetup();
}

export async function setupAdmin(email: string, password: string): Promise<{ recoveryCode: string }> {
  const { hash, salt } = hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  await db.createUser(email, hash, salt, 'admin', sha256(recoveryCode));
  return { recoveryCode };
}

export async function login(email: string, password: string): Promise<{ token: string; csrfToken: string; user: db.DbUser } | null> {
  const user = await db.findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash, user.salt)) return null;
  const token = generateToken();
  const csrfToken = generateToken();
  await db.createSession(user.id, sha256(token), csrfToken);
  return { token, csrfToken, user };
}

export interface SessionInfo {
  user: db.DbUser;
  csrfToken: string;
}

export async function validateSession(token: string): Promise<SessionInfo | null> {
  const session = await db.findSession(sha256(token));
  if (!session) return null;
  const user = await db.findUserById(session.user_id);
  if (!user) return null;
  return { user, csrfToken: session.csrf_token };
}

export async function logout(token: string): Promise<void> {
  await db.deleteSession(sha256(token));
}

export async function register(email: string, password: string, inviteCode: string): Promise<{ recoveryCode: string; userId: number } | { error: string }> {
  const invitation = await db.findInvitationByHash(sha256(inviteCode));
  if (!invitation) return { error: 'Code d\'invitation invalide ou expire' };
  if (await db.findUserByEmail(email)) return { error: 'Cet email est deja utilise' };

  const { hash, salt } = hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  const userId = await db.createUser(email, hash, salt, 'editor', sha256(recoveryCode));

  const collections: number[] = JSON.parse(invitation.collections);
  await db.setUserCollections(userId, collections);
  await db.markInvitationUsed(invitation.id, userId);

  return { recoveryCode, userId };
}

export async function forgotPassword(email: string, recoveryCode: string, newPassword: string): Promise<{ recoveryCode: string } | { error: string }> {
  const user = await db.findUserByEmail(email);
  const providedHash = sha256(recoveryCode);
  const storedHash = user?.recovery_code_hash ?? sha256('');
  const hashMatches = safeCompareHex(providedHash, storedHash);
  if (!user || !user.recovery_code_hash || !hashMatches) {
    return { error: 'Email ou code de recuperation incorrect' };
  }

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  await db.updateUserPassword(user.id, hash, salt, sha256(newRecoveryCode));
  await db.deleteUserSessions(user.id);

  return { recoveryCode: newRecoveryCode };
}

export async function createForceReset(userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.createPasswordReset(sha256(token), userId, expiresAt);
  return token;
}

export async function executeForceReset(token: string, newPassword: string): Promise<{ recoveryCode: string } | { error: string }> {
  const reset = await db.findPasswordReset(sha256(token));
  if (!reset) return { error: 'Lien de reset invalide ou expire' };

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  await db.updateUserPassword(reset.user_id, hash, salt, sha256(newRecoveryCode));
  await db.markResetUsed(reset.id);
  await db.deleteUserSessions(reset.user_id);

  return { recoveryCode: newRecoveryCode };
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ recoveryCode: string } | { error: string }> {
  const user = await db.findUserById(userId);
  if (!user) return { error: 'Utilisateur introuvable' };
  if (!verifyPassword(currentPassword, user.password_hash, user.salt)) return { error: 'Mot de passe actuel incorrect' };

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  await db.updateUserPassword(user.id, hash, salt, sha256(newRecoveryCode));

  return { recoveryCode: newRecoveryCode };
}

export async function createInvitation(createdBy: number, collections: number[], durationDays: number): Promise<string> {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  await db.createInvitation(sha256(code), createdBy, collections, expiresAt);
  return code;
}

// Rate limiting (in-memory, synchrone — inchangé)
interface RateEntry {
  attempts: number;
  blockedUntil: number;
}

const rateLimits = new Map<string, RateEntry>();

export function checkRateLimit(key: string, maxAttempts = 5): { allowed: boolean; retryAfterSeconds?: number } {
  const entry = rateLimits.get(key);
  if (!entry) return { allowed: true };
  if (Date.now() < entry.blockedUntil) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  if (entry.attempts >= maxAttempts) {
    rateLimits.delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

export function recordFailedAttempt(key: string, maxAttempts = 5, blockMs = 15 * 60 * 1000): void {
  const entry = rateLimits.get(key) || { attempts: 0, blockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= maxAttempts) {
    entry.blockedUntil = Date.now() + blockMs;
  }
  rateLimits.set(key, entry);
}

export function resetRateLimit(key: string): void {
  rateLimits.delete(key);
}
