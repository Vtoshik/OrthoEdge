import { describe, expect, it } from 'vitest';
import { accept, checkReplay } from '../src/replay';
import { importPublic, kidOf, newKeyPair, signClaims, verifyClaims, type SummaryClaims } from '../src/jws';
import { buildBundle } from '../src/fhir';

const claims = (seq: number, jti = 'j' + seq, iat = 1000): SummaryClaims =>
  ({ sub: 'P-7F3A', seq, jti, iat, bundle: buildBundle('P-7F3A', { date: '2026-10-04', flexion: 90, extension: 1, pain: 2 }, []) });

describe('signing', () => {
  it('verifies with the matching public key via exported JWK', async () => {
    const k = await newKeyPair(); const jws = await signClaims(claims(1), k.privateKey, 'dev1', 'summary+jws');
    expect(kidOf(jws)).toBe('dev1');
    const pub = await importPublic(k.publicJwk);
    expect((await verifyClaims<SummaryClaims>(jws, pub, 'summary+jws')).seq).toBe(1);
  });
  it('rejects a tampered payload', async () => {
    const k = await newKeyPair(); const jws = await signClaims(claims(1), k.privateKey, 'dev1', 'summary+jws');
    const [h, p, s] = jws.split('.'); const obj = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    obj.bundle.entry[0].resource.valueQuantity.value = 150;
    const forged = [h, btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), s].join('.');
    await expect(verifyClaims(forged, await importPublic(k.publicJwk), 'summary+jws')).rejects.toThrow();
  });
  it('rejects the wrong key and the wrong token type', async () => {
    const a = await newKeyPair(), b = await newKeyPair();
    const jws = await signClaims(claims(1), a.privateKey, 'dev1', 'summary+jws');
    await expect(verifyClaims(jws, await importPublic(b.publicJwk), 'summary+jws')).rejects.toThrow();
    await expect(verifyClaims(jws, await importPublic(a.publicJwk), 'protocol+jws')).rejects.toThrow('wrong token type');
  });
});

describe('replay guard', () => {
  it('accepts fresh, rejects replay / stale seq / old iat', () => {
    let st = { lastSeq: 0, seenJti: [] as string[] };
    const c1 = claims(1);
    expect(checkReplay(st, c1, 1000).ok).toBe(true); st = accept(st, c1);
    expect(checkReplay(st, c1, 1000)).toEqual({ ok: false, reason: 'duplicate_jti' });
    expect(checkReplay(st, claims(1, 'new'), 1000)).toEqual({ ok: false, reason: 'stale_seq' });
    expect(checkReplay(st, claims(2, 'x', 1000), 5000)).toEqual({ ok: false, reason: 'iat_out_of_window' });
    expect(checkReplay(st, claims(2), 1000).ok).toBe(true);
  });
});
