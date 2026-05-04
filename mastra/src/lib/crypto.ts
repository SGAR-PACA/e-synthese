import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string, keyHex: string): { encrypted: string; iv: string; tag: string } {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decrypt(encrypted: string, iv: string, tag: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function generateInviteCode(): string {
  const bytes = randomBytes(9);
  const hex = bytes.toString('hex').toUpperCase();
  return 'INV-' + hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + hex.slice(16, 18);
}

export function generateRecoveryCode(): string {
  const bytes = randomBytes(9);
  const hex = bytes.toString('hex').toUpperCase();
  return 'RECUP-' + hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + hex.slice(16, 18);
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return 'Le mot de passe doit contenir au moins 8 caracteres';
  if (!/[0-9]/.test(password)) return 'Le mot de passe doit contenir au moins 1 chiffre';
  if (!/[A-Z]/.test(password)) return 'Le mot de passe doit contenir au moins 1 majuscule';
  return null;
}
