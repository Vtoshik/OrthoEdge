export type Posture = 'lying' | 'sitting';
export type Leg = 'left' | 'right';
/** extension = deficit from full extension in degrees (0 = straight). Postures are recorded because repeatability differs by position. */
export interface DailySummary { date: string; flexion: number; extension: number; pain: number; extPosture?: Posture; flexPosture?: Posture; leg?: Leg }

/** Range of motion, derived: the arc from the extension deficit up to flexion. Not a separate measurement. */
export const rom = (s: Pick<DailySummary, 'flexion' | 'extension'>): number => Math.max(0, Math.round(s.flexion - s.extension));

export interface Stage { fromWeek: number; flexionTargetDeg: number; extensionTargetDeg: number }

/** All thresholds live in config/protocol.*.json; they are labelled examples, never clinical advice. */
export interface Protocol {
  id: string;
  label: string;
  surgeryDate: string;
  /** The leg the targets apply to. Readings of the other leg are stored as reference readings and never alert. */
  operatedLeg?: Leg;
  tolerance: { flexionDeg: number; extensionDeg: number };
  painLimit: number;
  consecutiveDaysBelow: number;
  /** Trend alert needs the shortfall to exceed this fraction of the tolerance on every one of the N days (default 0.5), so sensor noise around the target does not alert. */
  trendMarginFraction?: number;
  /** Display only: gap to the other knee (reference) that the portal flags. Never raises an alert. */
  referenceGapDeg?: number;
  stages: Stage[];
  /** Fallback exit criterion when no `phases` are defined. */
  milestone?: { flexionDeg: number; extensionDeg: number };
  /** Rehabilitation stages. The app only FLAGS that the measurable exit criteria are met; the clinician checks `clinicianChecks` and advances. */
  phases?: Phase[];
  /** 1-based index into `phases`. Only a clinician action changes it. */
  currentPhase?: number;
}

export interface Phase {
  name: string;
  /** Angle criteria the app can measure. Absent on the last stage. */
  exit?: { flexionDeg: number; extensionDeg: number };
  /** Criteria the app cannot measure; the clinician confirms them before advancing. */
  clinicianChecks: string[];
}

export const phaseInfo = (p: Protocol) => p.phases?.length
  ? { index: Math.min(p.currentPhase ?? 1, p.phases.length), total: p.phases.length, ...p.phases[Math.min(p.currentPhase ?? 1, p.phases.length) - 1] }
  : undefined;
export const currentExit = (p: Protocol) => phaseInfo(p) ? phaseInfo(p)!.exit : p.milestone;
/** True when the latest operated-knee reading meets the CURRENT stage's measurable exit criteria. Flag only: never unlocks anything. */
export const isMilestoneReached = (p: Protocol, s: Pick<DailySummary, 'flexion' | 'extension'>): boolean => { const e = currentExit(p); return !!e && s.flexion >= e.flexionDeg && s.extension <= e.extensionDeg; };

export type AlertKind = 'flexion_off_track' | 'extension_off_track' | 'pain_above_limit' | 'flexion_trend' | 'extension_trend';
export interface Alert { kind: AlertKind; severity: 'moderate' | 'high'; detail: string }

export interface Evaluation {
  date: string;
  week: number;
  flexionTarget: number;
  extensionTarget: number;
  status: 'on_track' | 'alert';
  alerts: Alert[];
  milestoneReached: boolean;
  nextStep: string;
  /** True when the evaluated reading is of the non-operated knee (reference only). */
  reference?: boolean;
  stage?: { index: number; total: number; name: string };
}

export const legOf = (p: { operatedLeg?: Leg }, s: { leg?: Leg }): Leg | undefined => s.leg ?? p.operatedLeg;
export const isReference = (p: { operatedLeg?: Leg }, s: { leg?: Leg }): boolean => !!p.operatedLeg && !!s.leg && s.leg !== p.operatedLeg;
/** Readings of the operated leg only: what the rules, trend charts and targets use. */
export const operatedHistory = <T extends { leg?: Leg }>(p: { operatedLeg?: Leg }, h: T[]): T[] => h.filter((x) => !isReference(p, x));
