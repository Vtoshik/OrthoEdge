import { isMilestoneReached, isReference, phaseInfo, type Alert, type DailySummary, type Evaluation, type Protocol, type Stage } from './types';

const DAY = 86_400_000;
const dayNum = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY);

export function weekOf(p: Protocol, date: string): number {
  return Math.max(1, Math.floor((dayNum(date) - dayNum(p.surgeryDate)) / 7) + 1);
}

export function stageFor(p: Protocol, week: number): Stage {
  const sorted = [...p.stages].sort((a, b) => a.fromWeek - b.fromWeek);
  let cur = sorted[0];
  for (const s of sorted) if (week >= s.fromWeek) cur = s;
  return cur;
}

/** Extension is a deficit from full extension (0 = straight): "below target" means deficit above target. */
const flexBelow = (v: number, t: number, tol: number) => v < t - tol;
const extBelow = (v: number, t: number, tol: number) => v > t + tol;

/** Whole days since the last summary (0 = measured today). Informational only: a gap never raises an alert. */
export function missedDays(history: DailySummary[], today: string): number {
  if (!history.length) return 0;
  const last = Math.max(...history.map((h) => dayNum(h.date)));
  return Math.max(0, dayNum(today) - last);
}

/**
 * Deterministic triage. `history` includes today's summary as the last entry. Pure function, config-driven.
 * Alert only when below target by MORE than the tolerance, or below target (within tolerance) on N consecutive days.
 */
export function evaluate(p: Protocol, history: DailySummary[], current?: DailySummary): Evaluation {
  const sortedAll = [...history].sort((a, b) => a.date.localeCompare(b.date));
  // `current` is the reading being judged. It need not be the newest by date: a summary can arrive late (offline queue)
  // and must still be judged against its own date, using only history up to that date.
  const latest = current ?? sortedAll[sortedAll.length - 1];
  const all = sortedAll.filter((h) => h.date <= latest.date);
  if (isReference(p, latest)) { // other knee: stored for comparison, never judged against the operated leg's targets
    const w = weekOf(p, latest.date), s0 = stageFor(p, w);
    return { date: latest.date, week: w, flexionTarget: s0.flexionTargetDeg, extensionTarget: s0.extensionTargetDeg, status: 'on_track', alerts: [], milestoneReached: false, reference: true, stage: (() => { const ph = phaseInfo(p); return ph && { index: ph.index, total: ph.total, name: ph.name }; })(), nextStep: 'Reference reading of your other knee saved. It is only used for comparison.' };
  }
  const sorted = all.filter((h) => !isReference(p, h));
  const today = latest;
  const week = weekOf(p, today.date);
  const st = stageFor(p, week);
  const alerts: Alert[] = [];

  if (flexBelow(today.flexion, st.flexionTargetDeg, p.tolerance.flexionDeg))
    alerts.push({ kind: 'flexion_off_track', severity: 'high', detail: `Flexion ${today.flexion}° vs week target ${st.flexionTargetDeg}° (tolerance ${p.tolerance.flexionDeg}°). Values deviate from the plan.` });
  if (extBelow(today.extension, st.extensionTargetDeg, p.tolerance.extensionDeg))
    alerts.push({ kind: 'extension_off_track', severity: 'high', detail: `Extension deficit ${today.extension}° vs week target ${st.extensionTargetDeg}° (tolerance ${p.tolerance.extensionDeg}°). Values deviate from the plan.` });
  if (today.pain > p.painLimit)
    alerts.push({ kind: 'pain_above_limit', severity: 'high', detail: `Pain ${today.pain}/10 above the clinician-set limit ${p.painLimit}/10.` });

  // Consecutive days (calendar-consecutive measured days) below target but within tolerance.
  const n = p.consecutiveDaysBelow;
  const lastN = sorted.slice(-n);
  const consecutive = lastN.length === n && lastN.every((h, i) => i === 0 || dayNum(h.date) - dayNum(lastN[i - 1].date) === 1);
  if (consecutive) {
    const tgt = (h: DailySummary) => stageFor(p, weekOf(p, h.date));
    const frac = p.trendMarginFraction ?? 0.5;
    const flexMargin = p.tolerance.flexionDeg * frac, extMargin = p.tolerance.extensionDeg * frac;
    if (!alerts.some((a) => a.kind === 'flexion_off_track') && lastN.every((h) => h.flexion < tgt(h).flexionTargetDeg - flexMargin))
      alerts.push({ kind: 'flexion_trend', severity: 'moderate', detail: `Flexion more than ${flexMargin.toFixed(1)}° below the week target on ${n} consecutive days.` });
    if (!alerts.some((a) => a.kind === 'extension_off_track') && lastN.every((h) => h.extension > tgt(h).extensionTargetDeg + extMargin))
      alerts.push({ kind: 'extension_trend', severity: 'moderate', detail: `Extension deficit more than ${extMargin.toFixed(1)}° above the week target on ${n} consecutive days.` });
  }

  const milestoneReached = isMilestoneReached(p, today);
  const ph = phaseInfo(p), stage = ph && { index: ph.index, total: ph.total, name: ph.name };
  return {
    date: today.date, week, flexionTarget: st.flexionTargetDeg, extensionTarget: st.extensionTargetDeg,
    status: alerts.length ? 'alert' : 'on_track', alerts, milestoneReached, stage, nextStep: nextStep(p, today, st, alerts.length > 0),
  };
}

function nextStep(p: Protocol, t: DailySummary, st: Stage, alert: boolean): string {
  if (alert) return 'Your care team has been told. Keep to your plan and bring this up at your next contact.';
  const extGap = t.extension - st.extensionTargetDeg;
  const flexGap = st.flexionTargetDeg - t.flexion;
  if (extGap > 0) return `Extension is ${Math.round(extGap)}° from target. Repeat the heel-prop exercise.`;
  if (flexGap > 0) return `Flexion is ${Math.round(flexGap)}° from target. Repeat your heel-slide exercise.`;
  return 'On track today. Same session tomorrow.';
}
