import { createHmac, timingSafeEqual } from 'crypto';

export function generateLicenseKey(userId: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(userId).digest('base64url');
  return `key-${userId}.${sig}`;
}

export function verifyLicenseKey(key: string, secret: string): string | null {
  if (!key.startsWith('key-')) return null;
  const stripped = key.slice(4);
  const dot = stripped.lastIndexOf('.');
  if (dot === -1) return null;
  const userId = stripped.slice(0, dot);
  const sig = stripped.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(userId).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  return userId;
}
