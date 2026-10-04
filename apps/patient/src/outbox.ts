import { signClaims, type SummaryClaims } from '@tele/engine';
import { getDeviceKey } from './keystore';
import { load, save, type Persist } from './state';

type Bundle = SummaryClaims['bundle'];
export type SendOutcome = { ok: true; crossCheck?: string } | { ok: false; reason: string; network?: boolean };

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

/** Local storage is the single source of truth for seq/outbox, so a background flush and a new session never clobber each other. */
const patchStore = (fn: (p: Persist) => Partial<Persist>) => { const cur = load(); if (!cur) return undefined; const n = { ...cur, ...fn(cur) }; save(n); return n; };

/** Signs the bundle with the device key (fresh seq/iat/jti at send time) and posts it. `tamper` is a demo tool: alters a value after signing. */
export async function signAndSend(bundle: Bundle, tamper = false): Promise<{ outcome: SendOutcome; jws: string; seq: number }> {
  const cur = patchStore((p) => ({ seq: p.seq + 1 }))!;
  const claims: SummaryClaims = { sub: cur.pseudonym, seq: cur.seq, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), bundle };
  const key = await getDeviceKey();
  let jws = await signClaims(claims, key.privateKey, key.kid, 'summary+jws');
  if (tamper) { const [h, pl, s] = jws.split('.'); const o = JSON.parse(unb64(pl)); o.bundle.entry[0].resource.valueQuantity.value += 40; jws = [h, b64(JSON.stringify(o)), s].join('.'); }
  try {
    const r = await fetch('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jws }) });
    if (r.status >= 500) return { outcome: { ok: false, reason: 'server_unavailable', network: true }, jws, seq: cur.seq };
    const body = await r.json();
    return { outcome: body.ok ? { ok: true, crossCheck: body.crossCheck } : { ok: false, reason: body.reason ?? 'rejected' }, jws, seq: cur.seq };
  } catch { return { outcome: { ok: false, reason: 'offline', network: true }, jws, seq: cur.seq }; }
}

export const queue = (bundle: Bundle) => patchStore((p) => ({ outbox: [...(p.outbox ?? []), { bundle, queuedAt: Date.now() }] }));

let flushing = false;
/** Sends queued days in order. Stops at the first network failure (keeps the rest). A rejection by the clinic drops that item and is reported, never silently ignored. */
export async function flushOutbox(): Promise<{ sent: number; rejected: string[]; pending: number }> {
  const res = { sent: 0, rejected: [] as string[], pending: load()?.outbox?.length ?? 0 };
  if (flushing) return res; flushing = true;
  try {
    for (;;) {
      const next = load()?.outbox?.[0]; if (!next) break;
      const { outcome } = await signAndSend(next.bundle);
      if (!outcome.ok && outcome.network) break;
      patchStore((p) => ({ outbox: (p.outbox ?? []).slice(1) }));
      if (outcome.ok) res.sent++; else res.rejected.push(outcome.reason);
    }
  } finally { flushing = false; }
  res.pending = load()?.outbox?.length ?? 0;
  if (res.rejected.length) patchStore(() => ({ note: `${res.rejected.length} saved day(s) could not be delivered (${[...new Set(res.rejected)].join(', ')}).` }));
  return res;
}
