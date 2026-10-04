/**
 * Measurement-quality tunables. These are NOT clinical thresholds (those live in config/protocol.*.json);
 * they control how strictly a reading is accepted and are meant to be tuned after testing on real phones.
 */
export const MEASUREMENT = {
  graceMs: 3000,            // time to place the phone after tapping Start; nothing is captured earlier
  holdMs: 1200,             // how long the phone must be still
  maxStdDeg: 1.2,           // allowed angle jitter while "still"
  maxOutOfPlaneDeg: 30,     // screen must face sideways; lying flat = 90
  motionAccel: 1.2,         // m/s² away from 1 g that counts as "the phone was moved"
  motionAngleDeg: 8,        // angle change that counts as "the phone was moved"
  minBendDeg: 20,           // a smaller thigh/shin difference is not a bend (phone left in place)
  maxBendDeg: 160,          // not possible for a knee
  maxExtensionDeficitDeg: 45,
} as const;

/** Server-side acceptance limits for incoming summaries. */
export const INGEST_LIMITS = {
  replayWindowSec: 300,
  maxDateSkewDays: 2,
  flexionDeg: [-10, 180],
  extensionDeg: [-20, 90],
  pain: [0, 10],
} as const;
