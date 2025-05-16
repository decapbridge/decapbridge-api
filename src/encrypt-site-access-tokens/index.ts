import type { HookConfig } from '@directus/extensions';
import crypto from 'crypto';



const hook: HookConfig = async ({ filter }, ctx) => {

  // 32-byte key for AES-256
  const keyStr = ctx.env['SECRET'].padEnd(32, '\0');
  const key = Buffer.from(keyStr, 'utf8');

  function encrypt(text: string) {
    const iv = crypto.randomBytes(12); // 12-byte IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag(); // 16-byte auth tag

    // Concatenate IV + Ciphertext + Auth Tag and encode as base64
    encrypted = Buffer.concat([iv, Buffer.from(encrypted, 'base64'), authTag]).toString('base64');

    return `encrypted_${encrypted}`
  }

  const encryptAccessToken = (payload: any) => {
    if (payload.access_token) {
      return {
        ...payload,
        access_token: encrypt(payload.access_token),
      };
    }
    return payload;
  }

  filter('sites.items.create', encryptAccessToken);
  filter('sites.items.update', encryptAccessToken);
};

export default hook;
