import { readFileSync } from 'node:fs';
import { buildBundle, evaluate, localDateISO, newKeyPair, signClaims, type DailySummary, type Protocol, type SummaryClaims } from '@tele/engine';
import type { Store } from './store';

const sample: Protocol = JSON.parse(readFileSync(new URL('../../config/protocol.calgary-sample.json', import.meta.url), 'utf8'));
const iso = (offset: number) => localDateISO(offset);

// Fully synthetic patients. Index 0 = day -10 ... index 9 = day -1.
const PATIENTS = [
  { p: 'P-7F3A', name: 'Jan Przykładowy', birthYear: 1994, flex: [62, 66, 70, 76, 79, 83, 86, 90, 92, 94], ext: [4, 3, 3, 3, 2, 2, 1, 0, 0, 0], pain: [4, 4, 3, 3, 3, 2, 2, 2, 2, 2] }, // live phone patient: on track
  { p: 'P-2C91', name: 'Ewa Testowa', birthYear: 1988, flex: [62, 66, 70, 72, 73, 72, 70, 68, 66, 64], ext: [5, 5, 5, 5, 6, 6, 7, 8, 9, 9], pain: [3, 3, 4, 4, 4, 5, 5, 6, 7, 7] }, // deviating
  { p: 'P-B804', name: 'Marek Syntetyczny', birthYear: 1999, flex: [65, 70, 76, 82, 86, 90, 93, 96, 98, 100], ext: [3, 2, 2, 1, 1, 0, 0, 0, 0, 0], pain: [2, 2, 2, 1, 1, 1, 1, 0, 0, 0] }, // milestone
];

export async function seed(store: Store, ingest: (jws: string, nowSec?: number, opts?: { skipDateWindow?: boolean }) => Promise<any>) {
  for (const s of PATIENTS) {
    store.identity[s.p] = { name: s.name, birthYear: s.birthYear };
    store.protocols[s.p] = { ...sample, surgeryDate: iso(-16) };
    const kid = `seed-${s.p}`; const k = await newKeyPair();
    store.devices[kid] = { kid, pseudonym: s.p, jwk: k.publicJwk, state: { lastSeq: 0, seenJti: [] }, enrolledAt: new Date().toISOString(), seed: true };
    for (let i = 0; i < 10; i++) {
      const sum: DailySummary = { date: iso(i - 10), flexion: s.flex[i], extension: s.ext[i], pain: s.pain[i], leg: sample.operatedLeg };
      const hist = store.history(s.p).filter((h) => h.date !== sum.date).concat(sum);
      const ev = evaluate(store.protocols[s.p], hist, sum);
      const iat = Math.floor(Date.now() / 1000);
      const claims: SummaryClaims = { sub: s.p, seq: i + 1, iat, jti: `${kid}-${i}`, bundle: buildBundle(s.p, sum, ev.alerts) };
      const r = await ingest(await signClaims(claims, k.privateKey, kid, 'summary+jws'), iat, { skipDateWindow: true });
      if (!r.ok) throw new Error(`seed failed: ${r.reason}`);
    }
    // One reference reading of the OTHER knee (healthy side), as the documentation asks for. Never alerts.
    const other = sample.operatedLeg === 'left' ? 'right' : 'left';
    const ref: DailySummary = { date: iso(-5), flexion: 132, extension: 0, pain: 0, leg: other };
    const refIat = Math.floor(Date.now() / 1000);
    const refClaims: SummaryClaims = { sub: s.p, seq: 11, iat: refIat, jti: `${kid}-ref`, bundle: buildBundle(s.p, ref, []) };
    const rr = await ingest(await signClaims(refClaims, k.privateKey, kid, 'summary+jws'), refIat, { skipDateWindow: true });
    if (!rr.ok) throw new Error(`seed reference failed: ${rr.reason}`);
  }
  store.save();
}
