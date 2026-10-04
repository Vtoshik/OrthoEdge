import type { Jwk as JWK } from '@tele/engine';

const kv = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    const open = indexedDB.open('kneetrack', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => rej(open.error);
    open.onsuccess = () => { const r = fn(open.result.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); };
  });

export interface DeviceKey { privateKey: CryptoKey; publicJwk: JWK; kid: string }

/** The signing key is generated NON-EXTRACTABLE: page code can use it to sign but can never read the private key. */
export async function getDeviceKey(): Promise<DeviceKey> {
  const have = await kv<DeviceKey | undefined>('readonly', (s) => s.get('devkey'));
  if (have) return have;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const rec: DeviceKey = { privateKey: kp.privateKey, publicJwk: { kty: kty!, crv, x, y }, kid: 'ph-' + crypto.randomUUID().slice(0, 8) };
  await kv('readwrite', (s) => s.put(rec, 'devkey'));
  return rec;
}
export const wipeKey = () => kv('readwrite', (s) => s.delete('devkey'));
