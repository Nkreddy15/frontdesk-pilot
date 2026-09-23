import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../core/src/config.js';
function key() {
  if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey))
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as hex.');
  return Buffer.from(config.encryptionKey, 'hex');
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    bytes.toString('base64'),
  ].join('.');
}
export function decrypt(value: string) {
  const [version, iv, tag, bytes] = value.split('.');
  if (version !== 'v1') throw new Error('Unknown encrypted token version');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(bytes, 'base64')), cipher.final()]).toString('utf8'),
  );
}
