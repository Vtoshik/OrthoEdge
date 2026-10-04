import { describe, expect, it } from 'vitest';
import { acceptProtocolUpdate } from '../src/protocolGuard';
import { daysBetween, localDateISO } from '../src/dates';

const claims = (sub: string, iat: number) => ({ sub, iat, protocol: {} as any });
describe('protocol update guard', () => {
  it('accepts the first protocol and newer ones', () => {
    expect(acceptProtocolUpdate(undefined, claims('P-1', 1000), 'P-1', 1000).ok).toBe(true);
    expect(acceptProtocolUpdate({ iat: 1000 }, claims('P-1', 1000), 'P-1', 1000).ok).toBe(true);
    expect(acceptProtocolUpdate({ iat: 1000 }, claims('P-1', 2000), 'P-1', 2000).ok).toBe(true);
  });
  it('refuses another patient, an older protocol (rollback) and one from the future', () => {
    expect(acceptProtocolUpdate(undefined, claims('P-2', 1000), 'P-1', 1000)).toEqual({ ok: false, reason: 'wrong_patient' });
    expect(acceptProtocolUpdate({ iat: 2000 }, claims('P-1', 1000), 'P-1', 2000)).toEqual({ ok: false, reason: 'older_than_current' });
    expect(acceptProtocolUpdate(undefined, claims('P-1', 9999), 'P-1', 1000)).toEqual({ ok: false, reason: 'from_the_future' });
  });
});

describe('local dates', () => {
  it('uses the local calendar day (00:30 local is still that local day, whatever the UTC date is)', () => {
    expect(localDateISO(0, new Date(2026, 9, 4, 0, 30))).toBe('2026-10-04');
    expect(localDateISO(0, new Date(2026, 9, 4, 23, 59))).toBe('2026-10-04');
    expect(localDateISO(1, new Date(2026, 9, 4, 0, 30))).toBe('2026-10-05');
    expect(localDateISO(-10, new Date(2026, 9, 4, 12, 0))).toBe('2026-09-24');
  });
  it('counts days between dates across a month end', () => { expect(daysBetween('2026-09-30', '2026-10-02')).toBe(2); });
});
