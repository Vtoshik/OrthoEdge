import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import type { Bundle } from '@medplum/fhirtypes';
import type { Protocol } from './types';

/** Works in the browser and in Node: Web Crypto ECDSA P-256, JWS ES256 (raw r||s). */
export async function newKeyPair() {
  // Used by the server (clinic key) and tests. The phone creates its own NON-extractable key in the browser keystore.
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { privateKey, publicKey, publicJwk: await exportJWK(publicKey) };
}
export const importPublic = (jwk: JWK) => importJWK(jwk, 'ES256');

export interface SummaryClaims { sub: string; seq: number; iat: number; jti: string; bundle: Bundle }
export interface ProtocolClaims { sub: string; iat: number; protocol: Protocol }

const enc = new TextEncoder(), dec = new TextDecoder();

export type SigningKey = Parameters<CompactSign['sign']>[0];
export type Jwk = JWK;
export const exportJwk = (k: SigningKey) => exportJWK(k as any);
export const importPrivate = (jwk: JWK) => importJWK(jwk, 'ES256');

export async function signClaims(claims: object, key: SigningKey, kid: string, typ: string): Promise<string> {
  return new CompactSign(enc.encode(JSON.stringify(claims))).setProtectedHeader({ alg: 'ES256', kid, typ }).sign(key);
}

export async function verifyClaims<T>(jws: string, key: SigningKey, typ: string): Promise<T> {
  const { payload, protectedHeader } = await compactVerify(jws, key, { algorithms: ['ES256'] });
  if (protectedHeader.typ !== typ) throw new Error('wrong token type');
  return JSON.parse(dec.decode(payload)) as T;
}

export const kidOf = (jws: string): string | undefined => {
  try { return JSON.parse(atob(jws.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).kid; } catch { return undefined; }
};
