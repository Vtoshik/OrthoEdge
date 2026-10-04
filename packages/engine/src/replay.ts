import type { SummaryClaims } from './jws';
import { INGEST_LIMITS } from './measurement';

export interface DeviceState { lastSeq: number; seenJti: string[] }
export type ReplayResult = { ok: true } | { ok: false; reason: 'stale_seq' | 'duplicate_jti' | 'iat_out_of_window' };

/** Replay protection: seq must grow, jti must be new, iat must be near server time. Caller persists state on ok. */
export function checkReplay(state: DeviceState, c: Pick<SummaryClaims, 'seq' | 'jti' | 'iat'>, nowSec: number, windowSec: number = INGEST_LIMITS.replayWindowSec): ReplayResult {
  if (Math.abs(nowSec - c.iat) > windowSec) return { ok: false, reason: 'iat_out_of_window' };
  if (state.seenJti.includes(c.jti)) return { ok: false, reason: 'duplicate_jti' };
  if (c.seq <= state.lastSeq) return { ok: false, reason: 'stale_seq' };
  return { ok: true };
}
export function accept(state: DeviceState, c: Pick<SummaryClaims, 'seq' | 'jti'>): DeviceState {
  return { lastSeq: c.seq, seenJti: [...state.seenJti, c.jti].slice(-200) };
}
