import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store';

describe('data at rest', () => {
  it('encrypts the identity map, restricts file permissions, and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tele-store-'));
    const a = new Store(dir); a.identity = { 'P-1': { name: 'Jan Przykladowy', birthYear: 1990 } }; a.audit('x', {}); a.save();
    const raw = readFileSync(join(dir, 'identity.json'), 'utf8');
    expect(raw).not.toContain('Przykladowy'); expect(raw).toContain('"tag"');
    for (const f of ['identity.json', 'devices.json', 'records.json', 'protocols.json', 'audit.log']) expect(statSync(join(dir, f)).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(new Store(dir).identity['P-1'].name).toBe('Jan Przykladowy');
  });
  it('migrates a plain identity file from an older run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tele-store-'));
    new Store(dir); // creates key
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ 'P-9': { name: 'Ewa Testowa', birthYear: 1980 } }));
    const s = new Store(dir); expect(s.identity['P-9'].name).toBe('Ewa Testowa');
    s.save(); expect(readFileSync(join(dir, 'identity.json'), 'utf8')).not.toContain('Testowa');
  });
});
