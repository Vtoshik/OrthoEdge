import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Sealed { v: 1; iv: string; tag: string; data: string }
export const isSealed = (x: any): x is Sealed => x && x.v === 1 && typeof x.iv === 'string' && typeof x.tag === 'string' && typeof x.data === 'string';

/** Key from IDENTITY_KEY (passphrase) if set; otherwise a random key file in a private directory next to the data. */
export function loadKey(keyDir: string, passphrase = process.env.IDENTITY_KEY): Buffer {
  if (passphrase) return scryptSync(passphrase, 'kneetrack-identity', 32);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 }); chmodSync(keyDir, 0o700);
  const f = join(keyDir, 'identity.key');
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
  chmodSync(f, 0o600);
  return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
}

export function seal(key: Buffer, obj: unknown): Sealed {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal<T>(key: Buffer, s: Sealed): T {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64')); d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
}
