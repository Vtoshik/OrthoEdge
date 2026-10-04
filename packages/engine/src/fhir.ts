import type { Bundle, DetectedIssue, Observation } from '@medplum/fhirtypes';
import type { Alert, DailySummary, Leg, Posture } from './types';

export const LOINC = { flexion: '41379-9', extension: '41377-3', pain: '72514-3' } as const;

const subject = (pseudonym: string) => ({ reference: `Patient/${pseudonym}` });
// Date-only on purpose: we export one daily summary, not a time-stamped measurement event.
const stamp = (date: string) => date;

function obs(pseudonym: string, date: string, code: string, display: string, value: number, unit: string, ucum: string, posture?: Posture, leg?: Leg): Observation {
  return {
    ...(leg ? { bodySite: { text: `${leg} knee` } } : {}),
    ...(posture ? { note: [{ text: `position: ${posture}` }] } : {}),
    resourceType: 'Observation', status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'exam' }] }],
    code: { coding: [{ system: 'http://loinc.org', code, display }] },
    subject: subject(pseudonym), effectiveDateTime: stamp(date),
    valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: ucum },
  };
}

export function buildObservations(pseudonym: string, s: DailySummary): Observation[] {
  return [
    obs(pseudonym, s.date, LOINC.flexion, 'Knee flexion active range of motion', s.flexion, 'degrees', 'deg', s.flexPosture, s.leg),
    obs(pseudonym, s.date, LOINC.extension, 'Knee extension active range of motion', s.extension, 'degrees', 'deg', s.extPosture, s.leg),
    obs(pseudonym, s.date, LOINC.pain, 'Pain severity - 0-10 verbal numeric rating [Score] - Reported', s.pain, 'score', '{score}'),
  ];
}

export function buildDetectedIssue(pseudonym: string, date: string, a: Alert): DetectedIssue {
  return {
    resourceType: 'DetectedIssue', status: 'preliminary', severity: a.severity,
    code: { text: a.kind }, patient: subject(pseudonym), identifiedDateTime: stamp(date), detail: a.detail,
  };
}

/** One collection bundle per daily export: three Observations plus a DetectedIssue per alert. */
export function buildBundle(pseudonym: string, s: DailySummary, alerts: Alert[]): Bundle {
  const resources = [...buildObservations(pseudonym, s), ...alerts.map((a) => buildDetectedIssue(pseudonym, s.date, a))];
  return { resourceType: 'Bundle', type: 'collection', entry: resources.map((resource) => ({ resource })) };
}

/** Reads the daily summary back from a bundle (used by the server to re-run the rules). */
export function summaryFromBundle(b: Bundle): DailySummary | undefined {
  const get = (c: string) => (b.entry ?? []).map((e) => e.resource).find((r): r is Observation => r?.resourceType === 'Observation' && r.code?.coding?.[0]?.code === c);
  const f = get(LOINC.flexion), e = get(LOINC.extension), p = get(LOINC.pain);
  if (!f || !e || !p || !f.effectiveDateTime) return undefined;
  const pos = (o: Observation): Posture | undefined => { const t = o.note?.[0]?.text; return t === 'position: lying' ? 'lying' : t === 'position: sitting' ? 'sitting' : undefined; };
  const out: DailySummary = { date: f.effectiveDateTime.slice(0, 10), flexion: f.valueQuantity!.value!, extension: e.valueQuantity!.value!, pain: p.valueQuantity!.value! };
  if (pos(e)) out.extPosture = pos(e); if (pos(f)) out.flexPosture = pos(f);
  const legTxt = f.bodySite?.text; if (legTxt === 'left knee') out.leg = 'left'; else if (legTxt === 'right knee') out.leg = 'right';
  return out;
}
