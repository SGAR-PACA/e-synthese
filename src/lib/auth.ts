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

export function isSetup(): boolean {
  return db.isSetup();
}

export function setupAdmin(email: string, password: string): { recoveryCode: string } {
  const { hash, salt } = hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  db.createUser(email, hash, salt, 'admin', sha256(recoveryCode));
  return { recoveryCode };
}

export function login(email: string, password: string): { token: string; csrfToken: string; user: db.DbUser } | null {
  const user = db.findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash, user.salt)) return null;
  const token = generateToken();
  const csrfToken = generateToken();
  db.createSession(user.id, sha256(token), csrfToken);
  return { token, csrfToken, user };
}

export interface SessionInfo {
  user: db.DbUser;
  csrfToken: string;
}

export function validateSession(token: string): SessionInfo | null {
  const session = db.findSession(sha256(token));
  if (!session) return null;
  const user = db.findUserById(session.user_id);
  if (!user) return null;
  return { user, csrfToken: session.csrf_token };
}

export function logout(token: string): void {
  db.deleteSession(sha256(token));
}

export function register(email: string, password: string, inviteCode: string): { recoveryCode: string; userId: number } | { error: string } {
  const invitation = db.findInvitationByHash(sha256(inviteCode));
  if (!invitation) return { error: 'Code d\'invitation invalide ou expire' };
  if (db.findUserByEmail(email)) return { error: 'Cet email est deja utilise' };

  const { hash, salt } = hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  const userId = db.createUser(email, hash, salt, 'editor', sha256(recoveryCode));

  const collections: number[] = JSON.parse(invitation.collections);
  db.setUserCollections(userId, collections);
  db.markInvitationUsed(invitation.id, userId);

  return { recoveryCode, userId };
}

export function forgotPassword(email: string, recoveryCode: string, newPassword: string): { recoveryCode: string } | { error: string } {
  const user = db.findUserByEmail(email);
  const providedHash = sha256(recoveryCode);
  const storedHash = user?.recovery_code_hash ?? sha256('');
  const hashMatches = safeCompareHex(providedHash, storedHash);
  if (!user || !user.recovery_code_hash || !hashMatches) {
    return { error: 'Email ou code de recuperation incorrect' };
  }

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  db.updateUserPassword(user.id, hash, salt, sha256(newRecoveryCode));
  db.deleteUserSessions(user.id);

  return { recoveryCode: newRecoveryCode };
}

export function createForceReset(userId: number): string {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.createPasswordReset(sha256(token), userId, expiresAt);
  return token;
}

export function executeForceReset(token: string, newPassword: string): { recoveryCode: string } | { error: string } {
  const reset = db.findPasswordReset(sha256(token));
  if (!reset) return { error: 'Lien de reset invalide ou expire' };

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  db.updateUserPassword(reset.user_id, hash, salt, sha256(newRecoveryCode));
  db.markResetUsed(reset.id);
  db.deleteUserSessions(reset.user_id);

  return { recoveryCode: newRecoveryCode };
}

export function changePassword(userId: number, currentPassword: string, newPassword: string): { recoveryCode: string } | { error: string } {
  const user = db.findUserById(userId);
  if (!user) return { error: 'Utilisateur introuvable' };
  if (!verifyPassword(currentPassword, user.password_hash, user.salt)) return { error: 'Mot de passe actuel incorrect' };

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  db.updateUserPassword(user.id, hash, salt, sha256(newRecoveryCode));

  return { recoveryCode: newRecoveryCode };
}

export function createInvitation(createdBy: number, collections: number[], durationDays: number): string {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  db.createInvitation(sha256(code), createdBy, collections, expiresAt);
  return code;
}

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
