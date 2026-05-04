import { randomBytes, timingSafeEqual } from 'node:crypto';

let proxyApiKey: string | null = null;

export function getProxyApiKey(): string {
  if (proxyApiKey) return proxyApiKey;
  const envKey = process.env.PROXY_API_KEY;
  if (envKey && envKey.length >= 16) {
    proxyApiKey = envKey;
    return proxyApiKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PROXY_API_KEY is required in production. Generate with: node -e "console.log(\'sk-proxy-\' + require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  proxyApiKey = 'sk-proxy-' + randomBytes(32).toString('hex');
  console.warn(`[WARNING] No PROXY_API_KEY set. Temporary key: ${proxyApiKey}`);
  console.warn('[WARNING] Regenerated at each restart. Set PROXY_API_KEY in .env to persist.');
  return proxyApiKey;
}

export function verifyApiKey(provided: string): boolean {
  const expected = getProxyApiKey();
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
