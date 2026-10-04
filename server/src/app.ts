import { timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import {
  accept, checkReplay, daysBetween, isMilestoneReached, phaseInfo, evaluate, legOf, exportJwk, INGEST_LIMITS, localDateISO, importPrivate, importPublic, kidOf, newKeyPair, signClaims, summaryFromBundle, verifyClaims,
  type Jwk as JWK, type Protocol, type ProtocolClaims, type SummaryClaims,
} from '@tele/engine';
import { validateBundle } from '@tele/engine/validate';
import { sha, Store, type RecordEntry } from './store';

export interface AppOpts { store: Store; pin?: string; /** Demo only: accept any measurement date (the demo's "+1 day" tool needs it). Default: strict window. */ allowAnyDate?: boolean; https?: { key: Buffer; cert: Buffer }; publicDirs?: { patient: string; portal: string } }

const SUMMARY = 'summary+jws', PROTOCOL = 'protocol+jws';

export async function buildApp(o: AppOpts): Promise<{ app: FastifyInstance; ingest: (jws: string, nowSec?: number, opts?: { skipDateWindow?: boolean }) => Promise<any>; signProtocol: (p: string) => Promise<string> }> {
  const { store } = o;
  const PIN = o.pin ?? '1234';
  const app = Fastify({ bodyLimit: 64 * 1024, https: o.https as any, logger: false });

  if (!store.clinicKey) {
    const k = await newKeyPair(); store.clinicKey = { privateJwk: await exportJwk(k.privateKey), publicJwk: k.publicJwk }; store.save();
  }
  const clinicPriv = await importPrivate(store.clinicKey.privateJwk);
  const clinicPub = store.clinicKey.publicJwk;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer'); reply.header('Cache-Control', 'no-store');
  });

  // ---- SSE for the portal ----
  const clients = new Set<import('node:http').ServerResponse>();
  const emit = (type: string, data: unknown) => { for (const c of clients) c.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };

  const signProtocol = async (pseudonym: string) => {
    const protocol = store.protocols[pseudonym]; if (!protocol) throw new Error('no protocol');
    const claims: ProtocolClaims = { sub: pseudonym, iat: Math.floor(Date.now() / 1000), protocol };
    return signClaims(claims, clinicPriv, 'clinic-1', PROTOCOL);
  };

  /** The ingest pipeline: verify -> replay -> FHIR validate -> recompute rules -> store -> audit. */
  async function ingest(jws: string, nowSec = Math.floor(Date.now() / 1000), opts: { skipDateWindow?: boolean } = {}) {
    const reject = (reason: string, extra: Record<string, unknown> = {}) => {
      const a = store.audit('ingest_rejected', { reason, ...extra }); emit('rejected', { reason, ts: a.ts, ...extra });
      return { ok: false as const, reason };
    };
    if (typeof jws !== 'string' || jws.length > 60_000) return reject('payload_invalid');
    const kid = kidOf(jws); const dev = kid ? store.devices[kid] : undefined;
    if (!dev) return reject('unknown_device', { kid });
    let claims: SummaryClaims;
    try { claims = await verifyClaims<SummaryClaims>(jws, await importPublic(dev.jwk), SUMMARY); }
    catch { return reject('signature_invalid', { kid, pseudonym: dev.pseudonym }); }
    if (claims.sub !== dev.pseudonym) return reject('subject_mismatch', { kid });
    const rp = checkReplay(dev.state, claims, nowSec);
    if (!rp.ok) return reject(rp.reason, { kid, pseudonym: dev.pseudonym });
    const fhirErr = validateBundle(claims.bundle);
    const summary = fhirErr ? undefined : summaryFromBundle(claims.bundle);
    if (fhirErr || !summary) return reject('fhir_invalid', { kid, detail: fhirErr });
    const L = INGEST_LIMITS;
    const inRange = (v: number, [lo, hi]: readonly number[]) => Number.isFinite(v) && v >= lo && v <= hi;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(summary.date) || !inRange(summary.pain, L.pain) || !inRange(summary.flexion, L.flexionDeg) || !inRange(summary.extension, L.extensionDeg))
      return reject('values_out_of_range', { kid });
    // A genuine daily summary is dated today (give or take clock/time-zone skew); this stops back-dating and rewriting history.
    if (!o.allowAnyDate && !opts.skipDateWindow && Math.abs(daysBetween(localDateISO(0, new Date(nowSec * 1000)), summary.date)) > L.maxDateSkewDays)
      return reject('date_out_of_window', { kid, pseudonym: dev.pseudonym, date: summary.date });
    const protocol = store.protocols[dev.pseudonym]; if (!protocol) return reject('no_protocol', { kid });

    // Cross-check: recompute the rules on the server with the same engine and the stored history.
    const history = [...store.history(dev.pseudonym).filter((h) => !(h.date === summary.date && legOf(protocol, h) === legOf(protocol, summary))), summary];
    const evaluation = evaluate(protocol, history, summary);
    const clientAlerts = (claims.bundle.entry ?? []).filter((e) => e.resource?.resourceType === 'DetectedIssue').map((e) => ({ kind: (e.resource as any).code?.text, severity: (e.resource as any).severity, detail: (e.resource as any).detail }));
    const sameKinds = JSON.stringify(clientAlerts.map((a) => a.kind).sort()) === JSON.stringify(evaluation.alerts.map((a) => a.kind).sort());
    dev.state = accept(dev.state, claims);
    const rec: RecordEntry = { pseudonym: dev.pseudonym, summary, clientAlerts: clientAlerts as any, evaluation, crossCheck: sameKinds ? 'match' : 'mismatch', kid: dev.kid, receivedAt: new Date().toISOString(), jwsSha256: sha(jws), signature: 'valid' };
    store.addRecord(rec); store.save();
    store.audit('ingest_accepted', { pseudonym: dev.pseudonym, date: summary.date, alerts: evaluation.alerts.map((a) => a.kind), crossCheck: rec.crossCheck, jwsSha256: rec.jwsSha256 });
    emit('record', { pseudonym: dev.pseudonym, status: evaluation.status, date: summary.date });
    return { ok: true as const, evaluation, crossCheck: rec.crossCheck };
  }

  // ---- patient-facing API ----
  app.post('/api/enroll', async (req, reply) => {
    const b = req.body as { token?: string; jwk?: JWK; kid?: string };
    const pseudonym = b?.token ? store.enrollTokens.get(b.token) : undefined;
    if (!pseudonym || !b.jwk || !b.kid || !/^[\w-]{4,64}$/.test(b.kid) || b.jwk.kty !== 'EC' || b.jwk.crv !== 'P-256') { store.audit('enroll_rejected', {}); return reply.code(400).send({ error: 'invalid_enrollment' }); }
    store.enrollTokens.delete(b.token!); // one-time token
    const { kty, crv, x, y } = b.jwk; // keep only public parameters
    store.devices[b.kid] = { kid: b.kid, pseudonym, jwk: { kty, crv, x, y }, state: { lastSeq: 0, seenJti: [] }, enrolledAt: new Date().toISOString() };
    store.save(); store.audit('device_enrolled', { pseudonym, kid: b.kid }); emit('enrolled', { pseudonym });
    return { pseudonym, clinicPublicJwk: clinicPub, protocolJws: await signProtocol(pseudonym), history: store.history(pseudonym) };
  });
  app.get('/api/protocol/:p', async (req, reply) => { const p = (req.params as any).p; return store.protocols[p] ? { protocolJws: await signProtocol(p) } : reply.code(404).send({ error: 'unknown' }); });
  app.post('/api/ingest', async (req, reply) => {
    const r = await ingest((req.body as any)?.jws);
    return r.ok ? r : reply.code(r.reason === 'signature_invalid' ? 401 : 422).send(r);
  });

  // ---- portal API (demo PIN) ----
  const okPin = (p?: string) => { const a = Buffer.from(String(p ?? '')), b = Buffer.from(PIN); return a.length === b.length && timingSafeEqual(a, b); };
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/api/portal') && !okPin((req.headers['x-portal-pin'] as string) ?? (req.query as any)?.pin)) return reply.code(401).send({ error: 'pin_required' });
  });
  app.get('/api/portal/patients', async () =>
    Object.keys(store.protocols).map((p) => {
      const recs = (store.records[p] ?? []).filter((r) => !r.evaluation.reference); const last = recs.at(-1);
      return { pseudonym: p, name: store.identity[p]?.name ?? '(unknown)', birthYear: store.identity[p]?.birthYear, devices: Object.values(store.devices).filter((d) => d.pseudonym === p).length,
        last: last && { date: last.summary.date, status: last.evaluation.status, alerts: last.evaluation.alerts, milestone: isMilestoneReached(store.protocols[p], last.summary), stage: phaseInfo(store.protocols[p]) && { index: phaseInfo(store.protocols[p])!.index, total: phaseInfo(store.protocols[p])!.total }, week: last.evaluation.week } };
    }));
  app.get('/api/portal/patients/:p', async (req, reply) => {
    const p = (req.params as any).p; if (!store.protocols[p]) return reply.code(404).send({ error: 'unknown' });
    return { pseudonym: p, identity: store.identity[p], protocol: store.protocols[p], records: store.records[p] ?? [] };
  });
  app.post('/api/portal/enroll-token', async (req, reply) => {
    const p = (req.body as any)?.pseudonym; if (!store.protocols[p]) return reply.code(404).send({ error: 'unknown' });
    const token = randomBytes(12).toString('base64url'); store.enrollTokens.set(token, p); store.audit('enroll_token_issued', { pseudonym: p });
    return { token };
  });
  app.put('/api/portal/protocol/:p', async (req, reply) => {
    const p = (req.params as any).p; if (!store.protocols[p]) return reply.code(404).send({ error: 'unknown' });
    const b = req.body as Partial<Protocol>; const cur = store.protocols[p];
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    store.protocols[p] = { ...cur, operatedLeg: b.operatedLeg === 'left' || b.operatedLeg === 'right' ? b.operatedLeg : cur.operatedLeg, painLimit: num(b.painLimit, 0, 10, cur.painLimit), stages: Array.isArray(b.stages) ? b.stages.map((s) => ({ fromWeek: num(s.fromWeek, 1, 52, 1), flexionTargetDeg: num(s.flexionTargetDeg, 0, 150, 0), extensionTargetDeg: num(s.extensionTargetDeg, 0, 30, 0) })) : cur.stages };
    store.save(); store.audit('protocol_updated', { pseudonym: p }); emit('protocol', { pseudonym: p }); return { ok: true };
  });
  // The clinician decides: confirms the checks the app cannot measure, then advances. The app only ever flags readiness.
  app.post('/api/portal/protocol/:p/advance', async (req, reply) => {
    const p = (req.params as any).p; const cur = store.protocols[p]; const ph = cur && phaseInfo(cur);
    if (!cur || !ph) return reply.code(404).send({ error: 'unknown' });
    if (ph.index >= ph.total) return reply.code(400).send({ error: 'last_stage' });
    const confirmed: string[] = Array.isArray((req.body as any)?.confirmed) ? (req.body as any).confirmed : [];
    if (!ph.clinicianChecks.every((c) => confirmed.includes(c))) return reply.code(400).send({ error: 'checks_not_confirmed' });
    const last = (store.records[p] ?? []).filter((r) => !r.evaluation.reference).at(-1);
    if (!last || !isMilestoneReached(cur, last.summary)) return reply.code(400).send({ error: 'angle_criteria_not_met' });
    store.protocols[p] = { ...cur, currentPhase: ph.index + 1 };
    store.save(); store.audit('stage_advanced', { pseudonym: p, from: ph.index, to: ph.index + 1, confirmed }); emit('protocol', { pseudonym: p });
    return { ok: true, currentPhase: ph.index + 1 };
  });
  app.get('/api/portal/audit', async () => store.readAudit());
  app.get('/api/portal/events', (req, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    reply.raw.write('retry: 2000\n\n'); clients.add(reply.raw); req.raw.on('close', () => clients.delete(reply.raw));
  });
  app.get('/api/health', async () => ({ ok: true, secure: !!o.https }));

  // ---- static apps ----
  app.get('/portal', async (_req, reply) => reply.redirect('/portal/'));
  if (o.publicDirs && existsSync(o.publicDirs.patient)) {
    await app.register(fastifyStatic, { root: o.publicDirs.patient, prefix: '/' });
    if (existsSync(o.publicDirs.portal)) await app.register(fastifyStatic, { root: o.publicDirs.portal, prefix: '/portal/', decorateReply: false });
  }
  return { app, ingest, signProtocol };
}
