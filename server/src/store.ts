import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { legOf, type Alert, type Jwk as JWK, type DailySummary, type DeviceState, type Evaluation, type Protocol } from '@tele/engine';

export interface Device { kid: string; pseudonym: string; jwk: JWK; state: DeviceState; enrolledAt: string; seed?: boolean }
export interface RecordEntry {
  pseudonym: string; summary: DailySummary; clientAlerts: Alert[]; evaluation: Evaluation;
  crossCheck: 'match' | 'mismatch'; kid: string; receivedAt: string; jwsSha256: string; signature: 'valid';
}
export interface AuditEntry { ts: string; event: string; detail: Record<string, unknown>; prev: string; hash: string }
export interface Identity { name: string; birthYear: number }

import { isSealed, loadKey, seal, unseal } from './crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Tiny JSON-file store. Pseudonymous measurements and the identity map live in separate files on purpose. */
export class Store {
  devices: Record<string, Device> = {};
  records: Record<string, RecordEntry[]> = {};
  protocols: Record<string, Protocol> = {};
  identity: Record<string, Identity> = {};
  enrollTokens = new Map<string, string>();
  clinicKey?: { privateJwk: JWK; publicJwk: JWK };
  private key: Buffer;
  constructor(public dir: string, keyDir = join(dir, '.keys')) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.key = loadKey(keyDir); this.load();
  }

  private f = (n: string) => join(this.dir, n);
  private load() {
    const rd = (n: string, d: any) => (existsSync(this.f(n)) ? JSON.parse(readFileSync(this.f(n), 'utf8')) : d);
    for (const n of ['devices.json', 'records.json', 'protocols.json', 'identity.json', 'clinic-key.json', 'audit.log']) if (existsSync(this.f(n))) chmodSync(this.f(n), 0o600); // owner only
    this.devices = rd('devices.json', {}); this.records = rd('records.json', {}); this.protocols = rd('protocols.json', {});
    const id = rd('identity.json', {}); this.identity = isSealed(id) ? unseal(this.key, id) : id; // plain file from an older run is migrated on the next save
    this.clinicKey = rd('clinic-key.json', undefined);
  }
  save() {
    const wr = (n: string, v: unknown) => writeFileSync(this.f(n), JSON.stringify(v, null, 1), { mode: 0o600 });
    wr('devices.json', this.devices); wr('records.json', this.records); wr('protocols.json', this.protocols);
    wr('identity.json', seal(this.key, this.identity)); // names are encrypted at rest (AES-256-GCM) if (this.clinicKey) wr('clinic-key.json', this.clinicKey);
  }
  reset() { for (const n of ['devices.json', 'records.json', 'protocols.json', 'identity.json', 'audit.log']) rmSync(this.f(n), { force: true }); this.devices = {}; this.records = {}; this.protocols = {}; this.identity = {}; this.enrollTokens.clear(); }

  history(p: string): DailySummary[] { return (this.records[p] ?? []).map((r) => r.summary); }
  addRecord(r: RecordEntry) {
    const op = this.protocols[r.pseudonym]; // re-measure of the same leg on the same day replaces
    const list = (this.records[r.pseudonym] ??= []).filter((x) => !(x.summary.date === r.summary.date && legOf(op, x.summary) === legOf(op, r.summary)));
    list.push(r); list.sort((a, b) => a.summary.date.localeCompare(b.summary.date)); this.records[r.pseudonym] = list;
  }

  // Hash-chained audit log: each line commits to the previous one.
  private auditLines(): AuditEntry[] { return existsSync(this.f('audit.log')) ? readFileSync(this.f('audit.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
  audit(event: string, detail: Record<string, unknown>): AuditEntry {
    const lines = this.auditLines(); const prev = lines.at(-1)?.hash ?? 'GENESIS';
    const e = { ts: new Date().toISOString(), event, detail, prev, hash: '' };
    e.hash = sha(prev + JSON.stringify({ ts: e.ts, event, detail }));
    appendFileSync(this.f('audit.log'), JSON.stringify(e) + '\n', { mode: 0o600 }); return e;
  }
  readAudit(limit = 50) {
    const lines = this.auditLines(); let ok = true, prev = 'GENESIS';
    for (const l of lines) { if (l.prev !== prev || l.hash !== sha(prev + JSON.stringify({ ts: l.ts, event: l.event, detail: l.detail }))) { ok = false; break; } prev = l.hash; }
    return { chainValid: ok, total: lines.length, entries: lines.slice(-limit).reverse() };
  }
}
export { sha };
