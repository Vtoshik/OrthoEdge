import { describe, expect, it } from 'vitest';
import { rom } from '../src/types';
import { buildBundle, buildObservations, summaryFromBundle, LOINC } from '../src/fhir';
import { validateBundle, validateFhir } from '../src/validate';

const s = { date: '2026-10-04', flexion: 92, extension: 2, pain: 3 };
describe('FHIR (Medplum validation)', () => {
  it('Observations use the confirmed LOINC codes and validate', () => {
    const o = buildObservations('P-7F3A', s);
    expect(o.map((x) => x.code!.coding![0].code)).toEqual([LOINC.flexion, LOINC.extension, LOINC.pain]);
    for (const x of o) expect(validateFhir(x)).toBeUndefined();
  });
  it('bundle with DetectedIssue validates and round-trips the summary', () => {
    const b = buildBundle('P-7F3A', s, [{ kind: 'pain_above_limit', severity: 'high', detail: 'Pain 8/10 above limit' }]);
    expect(validateBundle(b)).toBeUndefined();
    expect(b.entry!.some((e) => e.resource!.resourceType === 'DetectedIssue')).toBe(true);
    expect(summaryFromBundle(b)).toEqual(s);
  });
  it('records the measurement position and derives ROM', () => {
    const w = { ...s, extPosture: 'lying' as const, flexPosture: 'sitting' as const, leg: 'left' as const };
    const b = buildBundle('P-7F3A', w, []);
    expect(validateBundle(b)).toBeUndefined(); expect(summaryFromBundle(b)).toEqual(w);
    expect(rom(s)).toBe(90); expect(rom({ flexion: 10, extension: 30 })).toBe(0);
  });
  it('rejects broken resources', () => {
    const o: any = buildObservations('P-7F3A', s)[0];
    expect(validateFhir({ ...o, status: undefined })).toBeTruthy();
    expect(validateFhir({ ...o, valueQuantity: { ...o.valueQuantity, value: '92' } })).toBeTruthy();
    expect(validateFhir({ ...o, extra: 1 })).toBeTruthy();
    expect(validateBundle({ entry: [] })).toBeTruthy();
  });
});
