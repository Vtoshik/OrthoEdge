import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBundle, evaluate, newKeyPair, signClaims, verifyClaims, importPublic, type ProtocolClaims, type SummaryClaims } from '@tele/engine';
import { buildApp } from '../src/app';
import { seed } from '../src/seed';
import { Store } from '../src/store';

let ctx: Awaited<ReturnType<typeof buildApp>>, store: Store;
const pin = { 'x-portal-pin': '1234' };
beforeAll(async () => { store = new Store(mkdtempSync(join(tmpdir(), 'tele-'))); ctx = await buildApp({ store, allowAnyDate: true }); await seed(store, ctx.ingest); }, 60_000);

async function enroll() {
  const t = await ctx.app.inject({ method: 'POST', url: '/api/portal/enroll-token', headers: pin, payload: { pseudonym: 'P-7F3A' } });
  const { token } = t.json(); const k = await newKeyPair(); const kid = 'phone-' + Math.random().toString(36).slice(2, 8);
  const r = await ctx.app.inject({ method: 'POST', url: '/api/enroll', payload: { token, jwk: k.publicJwk, kid } });
  return { r, k, kid, token };
}
const mk = async (k: any, kid: string, seq: number, s: { flexion: number; extension: number; pain: number; date?: string }, alertsFromEngine = true) => {
  const date = s.date ?? new Date().toISOString().slice(0, 10);
  const sum = { date, flexion: s.flexion, extension: s.extension, pain: s.pain };
  const alerts = alertsFromEngine ? evaluate(store.protocols['P-7F3A'], [...store.history('P-7F3A').filter((h) => h.date !== date), sum], sum).alerts : [];
  const claims: SummaryClaims = { sub: 'P-7F3A', seq, iat: Math.floor(Date.now() / 1000), jti: `${kid}-${seq}`, bundle: buildBundle('P-7F3A', sum, alerts) };
  return signClaims(claims, k.privateKey, kid, 'summary+jws');
};

describe('server pipeline', () => {
  it('portal needs the PIN', async () => { expect((await ctx.app.inject({ url: '/api/portal/patients' })).statusCode).toBe(401); expect((await ctx.app.inject({ url: '/api/portal/patients', headers: pin })).statusCode).toBe(200); });
  it('seeded patients: on-track, deviating and milestone', async () => {
    const p = (await ctx.app.inject({ url: '/api/portal/patients', headers: pin })).json();
    const by = Object.fromEntries(p.map((x: any) => [x.pseudonym, x.last]));
    expect(by['P-7F3A'].status).toBe('on_track'); expect(by['P-2C91'].status).toBe('alert'); expect(by['P-B804'].milestone).toBe(true);
  });
  it('enroll is one-time and returns a clinic-signed protocol', async () => {
    const { r, token, k } = await enroll(); expect(r.statusCode).toBe(200);
    const body = r.json(); const c = await verifyClaims<ProtocolClaims>(body.protocolJws, await importPublic(body.clinicPublicJwk), 'protocol+jws');
    expect(c.sub).toBe('P-7F3A');
    const again = await ctx.app.inject({ method: 'POST', url: '/api/enroll', payload: { token, jwk: k.publicJwk, kid: 'x-again' } });
    expect(again.statusCode).toBe(400);
  });
  it('accepts a good summary; rejects replay, tamper, unknown device, bad FHIR', async () => {
    const { k, kid } = await enroll();
    const good = await mk(k, kid, 1, { flexion: 96, extension: 0, pain: 2 });
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: good } });
    expect(ok.statusCode).toBe(200); expect(ok.json().crossCheck).toBe('match');
    const replay = await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: good } });
    expect(replay.json().reason).toBe('duplicate_jti');
    const [h, p, s] = (await mk(k, kid, 2, { flexion: 96, extension: 0, pain: 2 })).split('.');
    const obj = JSON.parse(Buffer.from(p, 'base64url').toString()); obj.bundle.entry[0].resource.valueQuantity.value = 150;
    const forged = [h, Buffer.from(JSON.stringify(obj)).toString('base64url'), s].join('.');
    const t = await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: forged } });
    expect(t.statusCode).toBe(401); expect(t.json().reason).toBe('signature_invalid');
    const other = await newKeyPair();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: await mk(other, 'nobody', 1, { flexion: 90, extension: 0, pain: 1 }) } })).json().reason).toBe('unknown_device');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: 'garbage' } })).json().reason).toBe('unknown_device');
  });
  it('server recomputes rules: a client that hides an alert is flagged as mismatch', async () => {
    const { k, kid } = await enroll();
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const hidden = await mk(k, kid, 1, { flexion: 70, extension: 0, pain: 8, date }, false); // pain way above limit, client sends no DetectedIssue
    const r = (await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: hidden } })).json();
    expect(r.crossCheck).toBe('mismatch'); expect(r.evaluation.status).toBe('alert');
  });
  it('stores the other knee as a reference: no alert, and the portal status keeps reflecting the operated leg', async () => {
    const { k, kid } = await enroll();
    const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const sum = { date, flexion: 30, extension: 25, pain: 9, leg: 'left' as const }; // would alert badly if it were the operated (right) knee
    const claims: SummaryClaims = { sub: 'P-7F3A', seq: 1, iat: Math.floor(Date.now() / 1000), jti: `${kid}-ref`, bundle: buildBundle('P-7F3A', sum, []) };
    const r = (await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: await signClaims(claims, k.privateKey, kid, 'summary+jws') } })).json();
    expect(r.ok).toBe(true); expect(r.evaluation.reference).toBe(true); expect(r.evaluation.alerts).toEqual([]); expect(r.crossCheck).toBe('match');
    const list = (await ctx.app.inject({ url: '/api/portal/patients', headers: pin })).json();
    expect(list.find((x: any) => x.pseudonym === 'P-7F3A').last.date).not.toBe(date); // reference reading is not the "last" status record
  });
  it('rejects out-of-range values and audit chain stays valid', async () => {
    const { k, kid } = await enroll();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: await mk(k, kid, 1, { flexion: 400, extension: 0, pain: 2 }) } })).json().reason).toBe('values_out_of_range');
    const a = (await ctx.app.inject({ url: '/api/portal/audit', headers: pin })).json();
    expect(a.chainValid).toBe(true); expect(a.total).toBeGreaterThan(5);
  });
  it('strict mode rejects back-dated and far-future summaries, accepts today', async () => {
    const strict = await buildApp({ store }); // no allowAnyDate
    const { k, kid } = await enroll();
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const post = async (seq: number, date: string) => (await strict.app.inject({ method: 'POST', url: '/api/ingest', payload: { jws: await mk(k, kid, seq, { flexion: 96, extension: 0, pain: 2, date }) } })).json();
    expect((await post(1, day(-30))).reason).toBe('date_out_of_window');   // rewriting history
    expect((await post(2, day(10))).reason).toBe('date_out_of_window');    // far future
    expect((await post(3, day(0))).ok).toBe(true);
  });
  it('seeded patients each have a reference reading of the other knee that never alerts', async () => {
    for (const p of ['P-7F3A', 'P-2C91', 'P-B804']) {
      const refs = (await ctx.app.inject({ url: `/api/portal/patients/${p}`, headers: pin })).json().records.filter((r: any) => r.summary.leg === 'left');
      expect(refs.length).toBeGreaterThanOrEqual(1); // (another test may add one more for P-7F3A)
      for (const r of refs) { expect(r.evaluation.reference).toBe(true); expect(r.evaluation.alerts).toEqual([]); }
    }
  });
  it('stage advance is clinician-only: needs the confirmed checks and met angle criteria, is audited, and resets the flag', async () => {
    const adv = (body: object, p = 'P-B804') => ctx.app.inject({ method: 'POST', url: `/api/portal/protocol/${p}/advance`, headers: pin, payload: body });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/portal/protocol/P-B804/advance', payload: {} })).statusCode).toBe(401);
    const row = async () => (await ctx.app.inject({ url: '/api/portal/patients', headers: pin })).json().find((x: any) => x.pseudonym === 'P-B804');
    expect((await row()).last.milestone).toBe(true);                                   // app flags readiness...
    expect((await adv({ confirmed: [] })).json().error).toBe('checks_not_confirmed');   // ...but cannot advance without the clinician
    expect((await adv({ confirmed: ['No quadriceps lag'] })).json().error).toBe('checks_not_confirmed');
    const ok = await adv({ confirmed: ['No quadriceps lag', 'Swelling under control'] });
    expect(ok.json()).toEqual({ ok: true, currentPhase: 2 });
    expect((await row()).last.milestone).toBe(false);                                  // Stage 2 needs 120°, flag is recomputed
    expect((await row()).last.stage).toMatchObject({ index: 2, total: 3 });
    expect((await adv({ confirmed: ['Strength adequate', 'Normal gait', 'Swelling under control'] })).json().error).toBe('angle_criteria_not_met');
    const audit = (await ctx.app.inject({ url: '/api/portal/audit', headers: pin })).json();
    expect(audit.entries.some((e: any) => e.event === 'stage_advanced' && e.detail.pseudonym === 'P-B804' && e.detail.to === 2)).toBe(true);
    expect((await adv({ confirmed: [] }, 'P-NOPE')).statusCode).toBe(404);
  });
  it('sends a strict CSP', async () => { expect((await ctx.app.inject({ url: '/api/health' })).headers['content-security-policy']).toContain("default-src 'self'"); });
});
