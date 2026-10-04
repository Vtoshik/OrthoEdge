import { describe, expect, it } from 'vitest';
import { ARCHETYPES, EXT_READING_SD, FLEX_READING_SD, FLEX_STANDARD, FLEX_FAST, gauss, interp, mulberry32, PAIN_STANDARD, simulate, type Archetype } from '../src/synthetic';

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

describe('synthetic patients follow the published data', () => {
  it('is deterministic for a given seed and differs between seeds', () => {
    const a = ARCHETYPES['P-7F3A'];
    expect(simulate(a, 6, 15)).toEqual(simulate(a, 6, 15));
    expect(simulate({ ...a, seed: a.seed + 1 }, 6, 15)).not.toEqual(simulate(a, 6, 15));
  });

  it('interpolates the trial means exactly at the published weeks (ClinicalTrials.gov NCT03758755, standard rehab arm)', () => {
    expect(interp(FLEX_STANDARD, 14)).toBeCloseTo(70.0, 5); expect(interp(FLEX_STANDARD, 28)).toBeCloseTo(91.75, 5);
    expect(interp(FLEX_STANDARD, 42)).toBeCloseTo(112.74, 5); expect(interp(FLEX_STANDARD, 84)).toBeCloseTo(130.5, 5);
    expect(interp(FLEX_FAST, 14)).toBeCloseTo(76.4, 5); expect(interp(PAIN_STANDARD, 42)).toBeCloseTo(1.51, 5);
  });

  it('a population of patients averages to the published mean flexion at 2, 4, 6 and 12 weeks', () => {
    const rng = mulberry32(2026), pop = Array.from({ length: 3000 }, () => ({ curve: 'standard', z: gauss(rng), ext: { start: 3, end: 1 }, painOffset: 0, seed: Math.floor(rng() * 1e9) }) as Archetype);
    for (const [day, target] of [[14, 70.0], [28, 91.75], [42, 112.74], [84, 130.5]] as const)
      expect(Math.abs(mean(pop.map((a) => simulate(a, day, day)[0].flexion)) - target)).toBeLessThan(2.5);
  });

  it('the between-patient spread matches the trial (SE x sqrt n) and shrinks over time', () => {
    const rng = mulberry32(5), at = (day: number) => sd(Array.from({ length: 3000 }, () => simulate({ curve: 'standard', z: gauss(rng), ext: { start: 3, end: 1 }, painOffset: 0, seed: Math.floor(rng() * 1e9) }, day, day)[0].flexion));
    expect(at(14)).toBeGreaterThan(20); expect(at(14)).toBeLessThan(28); expect(at(84)).toBeGreaterThan(9); expect(at(84)).toBeLessThan(15);
    expect(at(14)).toBeGreaterThan(at(84));
  });

  it('day-to-day noise of one patient matches the phone test-retest data (about 3-4 degrees flexion)', () => {
    const a = { ...ARCHETYPES['P-7F3A'], z: 0 }, residuals: number[] = [];
    for (let seed = 1; seed <= 300; seed++) for (const d of simulate({ ...a, seed }, 28, 28)) residuals.push(d.flexion - interp(FLEX_STANDARD, 28));
    expect(sd(residuals)).toBeGreaterThan(3); expect(sd(residuals)).toBeLessThan(4.6);
    expect(FLEX_READING_SD).toBeCloseTo(3.07, 1); expect(EXT_READING_SD).toBeCloseTo(2.34, 1);
  });

  it('stays in physical ranges: extension is never negative, pain 0-10, integers', () => {
    for (const a of Object.values(ARCHETYPES)) for (const d of simulate(a, 3, 90)) {
      expect(d.extension).toBeGreaterThanOrEqual(0); expect(d.pain).toBeGreaterThanOrEqual(0); expect(d.pain).toBeLessThanOrEqual(10);
      expect(Number.isInteger(d.flexion) && Number.isInteger(d.extension) && Number.isInteger(d.pain)).toBe(true);
    }
  });

  it('the stiff patient shows a setback after day 13: more pain and extension deficit, less flexion', () => {
    const s = ARCHETYPES['P-2C91'], before = simulate(s, 6, 12), after = simulate(s, 13, 15);
    expect(mean(after.map((d) => d.pain))).toBeGreaterThan(mean(before.map((d) => d.pain)) + 2);
    expect(mean(after.map((d) => d.extension))).toBeGreaterThan(mean(before.map((d) => d.extension)));
    expect(mean(after.map((d) => d.flexion))).toBeLessThan(mean(before.map((d) => d.flexion)));
  });
});
