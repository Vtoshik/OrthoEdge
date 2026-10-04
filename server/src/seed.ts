import { readFileSync } from 'node:fs';
import { buildBundle, evaluate, localDateISO, newKeyPair, signClaims, type DailySummary, type Protocol, type SummaryClaims } from '@tele/engine';
import { ARCHETYPES, referenceReading, simulate } from './synthetic';
import type { Store } from './store';

const sample: Protocol = JSON.parse(readFileSync(new URL('../../config/protocol.calgary-sample.json', import.meta.url), 'utf8'));
const iso = (offset: number) => localDateISO(offset);

// Fully synthetic patients. Their numbers come from server/src/synthetic.ts (published recovery curves plus realistic measurement noise).
const PATIENTS = [
  { p: 'P-7F3A', name: 'Jan Przykładowy', birthYear: 1994 },      // live phone patient: recovering on plan
  { p: 'P-2C91', name: 'Ewa Testowa', birthYear: 1988 },          // setback in the last three days
  { p: 'P-B804', name: 'Marek Syntetyczny', birthYear: 1999 },    // fast recovery, ready for stage review
];
const SURGERY_DAYS_AGO = 16;

export async function seed(store: Store, ingest: (jws: string, nowSec?: number, opts?: { skipDateWindow?: boolean }) => Promise<any>) {
  for (const s of PATIENTS) {
    store.identity[s.p] = { name: s.name, birthYear: s.birthYear };
    store.protocols[s.p] = { ...sample, surgeryDate: iso(-SURGERY_DAYS_AGO) };
    const kid = `seed-${s.p}`; const k = await newKeyPair();
    store.devices[kid] = { kid, pseudonym: s.p, jwk: k.publicJwk, state: { lastSeq: 0, seenJti: [] }, enrolledAt: new Date().toISOString(), seed: true };
    const days = simulate(ARCHETYPES[s.p], 6, 15);                                  // post-op days 6..15 = the last 10 days
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const sum: DailySummary = { date: iso(d.day - SURGERY_DAYS_AGO), flexion: d.flexion, extension: d.extension, pain: d.pain, leg: sample.operatedLeg, flexPosture: 'sitting', extPosture: 'lying' };
      const hist = store.history(s.p).filter((h) => h.date !== sum.date).concat(sum);
      const ev = evaluate(store.protocols[s.p], hist, sum);
      const iat = Math.floor(Date.now() / 1000);
      const claims: SummaryClaims = { sub: s.p, seq: i + 1, iat, jti: `${kid}-${i}`, bundle: buildBundle(s.p, sum, ev.alerts) };
      const r = await ingest(await signClaims(claims, k.privateKey, kid, 'summary+jws'), iat, { skipDateWindow: true });
      if (!r.ok) throw new Error(`seed failed: ${r.reason}`);
    }
    // One reference reading of the OTHER knee (healthy side), as the documentation asks for. Never alerts.
    const other = sample.operatedLeg === 'left' ? 'right' : 'left';
    const ref: DailySummary = { date: iso(-5), ...referenceReading(), leg: other, flexPosture: 'sitting', extPosture: 'lying' };
    const refIat = Math.floor(Date.now() / 1000);
    const refClaims: SummaryClaims = { sub: s.p, seq: days.length + 1, iat: refIat, jti: `${kid}-ref`, bundle: buildBundle(s.p, ref, []) };
    const rr = await ingest(await signClaims(refClaims, k.privateKey, kid, 'summary+jws'), refIat, { skipDateWindow: true });
    if (!rr.ok) throw new Error(`seed reference failed: ${rr.reason}`);
  }
  store.save();
}
