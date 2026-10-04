export interface AccelSample { ax: number; ay: number; az: number; t: number }

import { MEASUREMENT as M } from './measurement';

const G = 9.81;
const deg = (r: number) => (r * 180) / Math.PI;
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Inclination of the phone's long axis in the sagittal plane, from the gravity direction (x-y plane).
 * Protocol: the +y axis points along the hip -> knee -> ankle direction. If the phone is strapped the other
 * way round (`flipped`), the angle is shifted by 180 degrees. A common sign convention of the gravity vector
 * (iOS vs Android) shifts both segments equally, so it cancels in the knee angle.
 */
export function segmentAngle(s: { ax: number; ay: number }, flipped = false): number {
  const a = deg(Math.atan2(s.ax, s.ay));
  return wrap180(flipped ? a + 180 : a);
}

/** Knee angle = relative angle between thigh and shin readings, 0 = straight leg. Always >= 0. */
export function kneeAngle(thigh: number, shin: number): number {
  return Math.abs(wrap180(shin - thigh));
}

/** Collects samples and reports a stable reading once the phone has been still for `windowMs`. */
/** Tilt of the phone's screen normal out of the sagittal plane: 0 = screen facing sideways (phone on the outer leg), 90 = lying flat. */
export function outOfPlaneDeg(s: AccelSample): number {
  const mag = Math.hypot(s.ax, s.ay, s.az) || 1;
  return deg(Math.asin(Math.min(1, Math.abs(s.az) / mag)));
}

export interface StillnessResult { stable: boolean; angle: number; progress: number; inPlane: boolean; moved: boolean; outOfPlane: number }

export class StillnessDetector {
  private buf: { t: number; a: number }[] = [];
  private firstAngle?: number;
  private _moved = false;
  /** `maxOutOfPlaneDeg`: reject readings where the phone is not held with its screen facing sideways (e.g. lying flat). */
  constructor(private windowMs: number = M.holdMs, private maxStdDeg: number = M.maxStdDeg, private flipped = false, private maxOutOfPlaneDeg: number = M.maxOutOfPlaneDeg) {}

  /** True once the phone has been seen moving (acceleration or a clear angle change) since construction/reset. */
  get moved() { return this._moved; }

  push(s: AccelSample): StillnessResult {
    const mag = Math.hypot(s.ax, s.ay, s.az);
    const a = segmentAngle(s, this.flipped);
    const oop = outOfPlaneDeg(s);
    if (Math.abs(mag - G) > M.motionAccel) this._moved = true;
    this.firstAngle ??= a;
    if (Math.abs(wrap180(a - this.firstAngle)) > M.motionAngleDeg) this._moved = true;
    // Reject samples where the phone is accelerating (magnitude far from 1 g): reset the window.
    if (Math.abs(mag - G) > 1.5) this.buf = [];
    this.buf.push({ t: s.t, a });
    while (this.buf.length && s.t - this.buf[0].t > this.windowMs) this.buf.shift();
    const span = this.buf.length ? s.t - this.buf[0].t : 0;
    const ref = this.buf[0].a; // unwrap around first value to survive the +-180 seam
    const vals = this.buf.map((b) => ref + wrap180(b.a - ref));
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / vals.length);
    const inPlane = oop <= this.maxOutOfPlaneDeg;
    const stable = inPlane && span >= this.windowMs * 0.9 && this.buf.length >= 5 && std <= this.maxStdDeg;
    return { stable, angle: wrap180(mean), progress: inPlane ? Math.min(1, span / this.windowMs) : 0, inPlane, moved: this._moved, outOfPlane: oop };
  }
  reset() { this.buf = []; this.firstAngle = undefined; this._moved = false; }
}

export type PairProblem = 'bend_not_detected' | 'bend_implausible' | 'not_straight';
/**
 * Plausibility of a thigh+shin reading pair. Catches the common mistakes: phone left in the same place for both
 * readings (bend ~0), or readings that cannot be a knee. It cannot prove the phone was on the leg.
 */
export function checkPair(kind: 'flexion' | 'extension', thigh: number, shin: number, limits: { minBendDeg: number; maxBendDeg: number; maxExtensionDeficitDeg: number } = M): PairProblem | undefined {
  const k = kneeAngle(thigh, shin);
  if (kind === 'flexion') return k < limits.minBendDeg ? 'bend_not_detected' : k > limits.maxBendDeg ? 'bend_implausible' : undefined;
  return k > limits.maxExtensionDeficitDeg ? 'not_straight' : undefined;
}
