import { describe, expect, it } from 'vitest';
import { kneeAngle, segmentAngle, StillnessDetector } from '../src/angle';

// Seeded PRNG so noisy tests are deterministic.
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2;
/** Accelerometer reading (incl. gravity) for a segment tilted `phi` degrees in the sagittal plane. */
const accel = (phi: number, noise = 0, r = rng(1)) => {
  const p = (phi * Math.PI) / 180, g = 9.81;
  return { ax: g * Math.sin(p) + noise * r(), ay: g * Math.cos(p) + noise * r(), az: 0.3 * noise * r() };
};

describe('knee angle', () => {
  it.each([[0], [30], [95], [120]])('recovers %i° flexion (thigh/shin, normal orientation)', (flex) => {
    const thigh = segmentAngle(accel(10)), shin = segmentAngle(accel(10 + flex));
    expect(kneeAngle(thigh, shin)).toBeCloseTo(flex, 5);
  });
  it('recovers flexion when the phone is strapped flipped on the shin', () => {
    // flipped phone: +y points the other way => raw angle shifted by 180°; `flipped` compensates
    const thigh = segmentAngle(accel(10)), shin = segmentAngle(accel(10 + 95 + 180), true);
    expect(kneeAngle(thigh, shin)).toBeCloseTo(95, 5);
  });
  it('is insensitive to the gravity sign convention (iOS vs Android)', () => {
    const neg = (a: { ax: number; ay: number }) => ({ ax: -a.ax, ay: -a.ay });
    expect(kneeAngle(segmentAngle(neg(accel(5))), segmentAngle(neg(accel(65))))).toBeCloseTo(60, 5);
  });
  it('stays within 2° with sensor noise after averaging', () => {
    const r = rng(7), d = new StillnessDetector(1000, 3), d2 = new StillnessDetector(1000, 3);
    let a = 0, b = 0;
    for (let t = 0; t <= 1500; t += 20) { a = d.push({ ...accel(5, 0.15, r), t }).angle; b = d2.push({ ...accel(100, 0.15, r), t }).angle; }
    expect(Math.abs(kneeAngle(a, b) - 95)).toBeLessThan(2);
  });
  it('extension deficit near 0 for a straight leg lying down', () => {
    expect(kneeAngle(segmentAngle(accel(88)), segmentAngle(accel(90)))).toBeCloseTo(2, 5);
  });
});

describe('placement checks', () => {
  it('phone lying flat (screen up) is never accepted', () => {
    const d = new StillnessDetector(1000, 1); let r: any;
    for (let t = 0; t <= 2000; t += 20) r = d.push({ ax: 0.05, ay: 0.05, az: 9.81, t });
    expect(r.inPlane).toBe(false); expect(r.stable).toBe(false); expect(r.progress).toBe(0);
  });
  it('phone held with the screen facing sideways is accepted', () => {
    const d = new StillnessDetector(1000, 1); let r: any;
    for (let t = 0; t <= 2000; t += 20) r = d.push({ ...accel(40), t });
    expect(r.inPlane).toBe(true); expect(r.stable).toBe(true);
  });
  it('moved stays false for a phone that never moves and becomes true after a movement', () => {
    const d = new StillnessDetector(1000, 1);
    for (let t = 0; t <= 1500; t += 20) d.push({ ...accel(40), t });
    expect(d.moved).toBe(false);
    d.push({ ...accel(75), t: 1520 });
    expect(d.moved).toBe(true);
    d.reset(); expect(d.moved).toBe(false);
  });
  it('a pose change of a few degrees alone does not count as moved, a large one does', () => {
    const d = new StillnessDetector(1000, 1); d.push({ ...accel(40), t: 0 }); d.push({ ...accel(45), t: 20 });
    expect(d.moved).toBe(false); d.push({ ...accel(60), t: 40 }); expect(d.moved).toBe(true);
  });
});

describe('stillness gate', () => {
  it('is not stable while moving, stable after holding still', () => {
    const d = new StillnessDetector(1000, 1);
    let last = { stable: false, angle: 0, progress: 0 };
    for (let t = 0; t < 1000; t += 20) last = d.push({ ...accel(20 + t / 10), t });
    expect(last.stable).toBe(false);
    for (let t = 1000; t < 2500; t += 20) last = d.push({ ...accel(50), t });
    expect(last.stable).toBe(true);
    expect(last.angle).toBeCloseTo(50, 0);
  });
  it('resets on strong acceleration', () => {
    const d = new StillnessDetector(1000, 1);
    for (let t = 0; t < 900; t += 20) d.push({ ...accel(30), t });
    expect(d.push({ ax: 20, ay: 5, az: 3, t: 920 }).stable).toBe(false);
  });
  it('survives the ±180° seam', () => {
    const d = new StillnessDetector(1000, 1); let r = { stable: false, angle: 0, progress: 0 };
    for (let t = 0; t <= 1200; t += 20) r = d.push({ ...accel(t % 40 ? 179.8 : -179.8), t });
    expect(r.stable).toBe(true);
  });
});

import { checkPair } from '../src/angle';
describe('pair plausibility', () => {
  it('flags a bend reading taken with the phone left in the same place', () => {
    expect(checkPair('flexion', 30, 31)).toBe('bend_not_detected');
    expect(checkPair('flexion', 30, 95)).toBeUndefined();
    expect(checkPair('flexion', 0, 175)).toBe('bend_implausible');
  });
  it('accepts a straight leg and flags a strongly bent one in the extension test', () => {
    expect(checkPair('extension', 88, 90)).toBeUndefined();
    expect(checkPair('extension', 88, 150)).toBe('not_straight');
  });
});
