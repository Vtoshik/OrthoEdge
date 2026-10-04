import type { ProtocolClaims } from './jws';

export type ProtocolRejection = 'wrong_patient' | 'older_than_current' | 'from_the_future';

/**
 * Decides whether a (signature-verified) protocol may replace the current one. A valid signature alone is not enough:
 * an old signed protocol with laxer targets, or another patient's protocol, must be refused.
 */
export function acceptProtocolUpdate(
  current: Pick<ProtocolClaims, 'iat'> | undefined, next: ProtocolClaims, pseudonym: string, nowSec = Math.floor(Date.now() / 1000), skewSec = 300,
): { ok: true } | { ok: false; reason: ProtocolRejection } {
  if (next.sub !== pseudonym) return { ok: false, reason: 'wrong_patient' };
  if (next.iat > nowSec + skewSec) return { ok: false, reason: 'from_the_future' };
  if (current && next.iat < current.iat) return { ok: false, reason: 'older_than_current' };
  return { ok: true };
}
