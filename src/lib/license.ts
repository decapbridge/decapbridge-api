import { createPrivateKey, createPublicKey, sign, verify } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export function generateLicenseKey(userId: string, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
  const sig = sign(null, Buffer.from(userId), privateKey).toString('base64url');
  return `key-${userId}.${sig}`;
}

const PUBLIC_KEY = createPublicKey(
  readFileSync(resolve(import.meta.dirname, '../../../license.pub'), 'utf-8')
);

export function verifyLicenseKey(key: string): string {
  if (!key.startsWith('key-')) throw new Error('Invalid key format');
  const stripped = key.slice(4);
  const dot = stripped.lastIndexOf('.');
  if (dot === -1) throw new Error('Invalid key format');
  const userId = stripped.slice(0, dot);
  const sig = Buffer.from(stripped.slice(dot + 1), 'base64url');
  const valid = verify(null, Buffer.from(userId), PUBLIC_KEY, sig);
  if (!valid) throw new Error('Invalid key');
  return userId;
}
