import { describe, expect, it } from 'vitest';
import { evaluate, missedDays, weekOf } from '../src/rules';
import { isMilestoneReached, phaseInfo } from '../src/types';
import type { DailySummary, Protocol } from '../src/types';

// Fixed fixture: these tests check the RULES, so they must not depend on the sample protocol's numbers.
const p: Protocol = {
  id: 'fixture', label: 'test fixture', surgeryDate: '2026-09-19', tolerance: { flexionDeg: 8.5, extensionDeg: 6.5 }, painLimit: 6, consecutiveDaysBelow: 3, trendMarginFraction: 0.5,
  stages: [{ fromWeek: 1, flexionTargetDeg: 60, extensionTargetDeg: 5 }, { fromWeek: 2, flexionTargetDeg: 75, extensionTargetDeg: 3 }, { fromWeek: 3, flexionTargetDeg: 90, extensionTargetDeg: 0 }, { fromWeek: 5, flexionTargetDeg: 105, extensionTargetDeg: 0 }],
  currentPhase: 1,
  phases: [
    { name: 'Stage 1 · early motion', exit: { flexionDeg: 90, extensionDeg: 0 }, clinicianChecks: ['No quadriceps lag', 'Swelling under control'] },
    { name: 'Stage 2 · building range', exit: { flexionDeg: 120, extensionDeg: 0 }, clinicianChecks: ['Strength adequate', 'Normal gait', 'Swelling under control'] },
    { name: 'Stage 3 · return to activity', clinicianChecks: [] },
  ],
};
// surgery 2026-09-19: week 3 = 2026-10-03..09 ; week 2 = 09-26..10-02
const d = (date: string, flexion: number, extension: number, pain = 2): DailySummary => ({ date, flexion, extension, pain });

describe('rule engine', () => {
  it('computes the week from the surgery date', () => {
    expect(weekOf(p, '2026-09-19')).toBe(1); expect(weekOf(p, '2026-10-03')).toBe(3);
  });
  it('on-plan patient produces no alert', () => {
    const e = evaluate(p, [d('2026-10-04', 92, 0)]);
    expect(e.status).toBe('on_track'); expect(e.alerts).toEqual([]);
  });
  it('within tolerance is not an alert (single day)', () => {
    expect(evaluate(p, [d('2026-10-04', 90 - 8, 0)]).status).toBe('on_track');
  });
  it('below target by more than the tolerance alerts (flexion)', () => {
    const e = evaluate(p, [d('2026-10-04', 90 - 9, 0)]);
    expect(e.alerts.map((a) => a.kind)).toEqual(['flexion_off_track']);
  });
  it('extension deficit above tolerance alerts', () => {
    expect(evaluate(p, [d('2026-10-04', 100, 7)]).alerts.map((a) => a.kind)).toContain('extension_off_track');
  });
  it('pain above the limit alerts, at the limit does not', () => {
    expect(evaluate(p, [d('2026-10-04', 100, 0, 7)]).alerts.map((a) => a.kind)).toEqual(['pain_above_limit']);
    expect(evaluate(p, [d('2026-10-04', 100, 0, 6)]).status).toBe('on_track');
  });
  it('N consecutive days below target (within tolerance) raises a moderate trend alert', () => {
    const h = [d('2026-10-04', 82, 0), d('2026-10-05', 83, 0), d('2026-10-06', 84, 0)];
    const e = evaluate(p, h);
    expect(e.alerts).toEqual([expect.objectContaining({ kind: 'flexion_trend', severity: 'moderate' })]);
  });
  it('sensor noise just below a 0° target does not raise a trend alert, a real shortfall does', () => {
    const noisy = [d('2026-10-04', 95, 2), d('2026-10-05', 95, 1), d('2026-10-06', 95, 2)]; // deficit 1-2° vs target 0°, margin 3.25°
    expect(evaluate(p, noisy).status).toBe('on_track');
    const real = [d('2026-10-04', 95, 4), d('2026-10-05', 95, 5), d('2026-10-06', 95, 4)];
    expect(evaluate(p, real).alerts.map((a) => a.kind)).toEqual(['extension_trend']);
  });
  it('a missed day breaks "consecutive" and never raises an alert by itself', () => {
    const h = [d('2026-10-04', 82, 0), d('2026-10-06', 83, 0), d('2026-10-07', 84, 0)];
    expect(evaluate(p, h).status).toBe('on_track');
    expect(missedDays(h, '2026-10-10')).toBe(3);
    expect(missedDays([], '2026-10-10')).toBe(0);
  });
  it('flags milestone when angle criteria are met, without unlocking anything', () => {
    expect(evaluate(p, [d('2026-10-04', 92, 0)]).milestoneReached).toBe(true);
    expect(evaluate(p, [d('2026-10-04', 92, 3)]).milestoneReached).toBe(false);
  });
  it('reference readings of the other knee never alert and do not disturb the operated leg history', () => {
    const pl: Protocol = { ...p, operatedLeg: 'right' };
    const ref = { ...d('2026-10-04', 40, 20, 9), leg: 'left' as const };
    const e = evaluate(pl, [ref]);
    expect(e.reference).toBe(true); expect(e.alerts).toEqual([]); expect(e.status).toBe('on_track');
    const own = (date: string, f: number) => ({ ...d(date, f, 0), leg: 'right' as const });
    // 3 consecutive operated days below target with a reference reading in between must still be one streak
    const h = [own('2026-10-04', 82), own('2026-10-05', 83), { ...ref, date: '2026-10-05' }, own('2026-10-06', 84)];
    expect(evaluate(pl, h).alerts.map((a) => a.kind)).toEqual(['flexion_trend']);
  });
  it('judges a late-arriving reading against its own date, not against the newest reading', () => {
    const pl: Protocol = { ...p, operatedLeg: 'right' };
    const own = (date: string, f: number, pain = 2) => ({ ...d(date, f, 0, pain), leg: 'right' as const });
    const newer = own('2026-10-06', 100);
    const lateBad = own('2026-10-04', 60);                       // arrives after the newer day was already stored
    const e = evaluate(pl, [lateBad, newer], lateBad);
    expect(e.date).toBe('2026-10-04'); expect(e.alerts.map((a) => a.kind)).toContain('flexion_off_track');
    const lateRef = { ...d('2026-10-03', 40, 20, 9), leg: 'left' as const };
    const r = evaluate(pl, [lateRef, newer], lateRef);
    expect(r.reference).toBe(true); expect(r.alerts).toEqual([]);
  });
  it('milestone follows the CURRENT stage: 90° exits Stage 1, Stage 2 needs 120°', () => {
    expect(phaseInfo(p)).toMatchObject({ index: 1, total: 3 });
    expect(evaluate(p, [d('2026-10-04', 100, 0)]).stage).toEqual({ index: 1, total: 3, name: 'Stage 1 · early motion' });
    const s2: Protocol = { ...p, currentPhase: 2 };
    expect(isMilestoneReached(s2, { flexion: 100, extension: 0 })).toBe(false);
    expect(isMilestoneReached(s2, { flexion: 121, extension: 0 })).toBe(true);
    const last: Protocol = { ...p, currentPhase: 3 };               // last stage has no measurable exit
    expect(isMilestoneReached(last, { flexion: 150, extension: 0 })).toBe(false);
  });
  it('gives one concrete next step', () => {
    expect(evaluate(p, [d('2026-10-04', 95, 3)]).nextStep).toMatch(/heel-prop/);
  });
});
