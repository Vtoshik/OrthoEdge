import { localDateISO, type DailySummary, type Jwk as JWK, type Protocol, type SummaryClaims } from '@tele/engine';

export interface Persist {
  pseudonym: string; kid: string; clinicPub: JWK; protocolJws: string;
  history: DailySummary[]; seq: number; dayOffset: number; lastJws?: string;
  sim: boolean; preset: 'normal' | 'redflag';
  /** Days measured while offline: re-signed and sent when the clinic is reachable again. */
  outbox?: { bundle: SummaryClaims['bundle']; queuedAt: number }[];
  note?: string;
}
const KEY = 'kneetrack.v1';
export const load = (): Persist | undefined => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined; } catch { return undefined; } };
export const save = (p: Persist) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: app still works for this session */ } };
export const wipe = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

/** The patient's local calendar day (not the UTC day). */
export const todayISO = (offset: number) => localDateISO(offset);
export type { Protocol };
