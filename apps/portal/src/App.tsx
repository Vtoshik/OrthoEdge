import { useCallback, useEffect, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { daysBetween, isMilestoneReached, isReference, phaseInfo, rom, stageFor, weekOf, type Alert, type DailySummary, type Protocol } from '@tele/engine';

interface PatientRow { pseudonym: string; name: string; birthYear?: number; devices: number; last?: { date: string; status: 'on_track' | 'alert'; alerts: Alert[]; milestone: boolean; week: number; stage?: { index: number; total: number } } }
interface Rec { summary: DailySummary; evaluation: { status: string; alerts: Alert[]; milestoneReached: boolean; week: number; nextStep: string }; crossCheck: 'match' | 'mismatch'; signature: string; kid: string; receivedAt: string; jwsSha256: string }
interface Detail { pseudonym: string; identity?: { name: string; birthYear: number }; protocol: Protocol; records: Rec[] }
interface Audit { chainValid: boolean; total: number; entries: { ts: string; event: string; detail: Record<string, any>; hash: string }[] }

let PIN = ''; try { PIN = sessionStorage.getItem('pin') ?? ''; } catch { /* ignore */ }
const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(`/api/portal/${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-portal-pin': PIN, ...(init.headers ?? {}) } });
  if (r.status === 401) throw new Error('pin');
  return r.json();
};
const REASONS: Record<string, string> = { date_out_of_window: 'Measurement date outside the allowed window (possible back-dating)', signature_invalid: 'Signature invalid (message altered or wrong key)', duplicate_jti: 'Replay: message already received', stale_seq: 'Replay: old sequence number', iat_out_of_window: 'Message timestamp outside allowed window', unknown_device: 'Unknown device', fhir_invalid: 'FHIR validation failed', values_out_of_range: 'Values out of range', payload_invalid: 'Malformed payload', subject_mismatch: 'Subject does not match device' };

export function App() {
  const [authed, setAuthed] = useState(!!PIN); const [pin, setPin] = useState(''); const [bad, setBad] = useState(false);
  const [list, setList] = useState<PatientRow[]>([]); const [sel, setSel] = useState<string>(); const [detail, setDetail] = useState<Detail>();
  const [audit, setAudit] = useState<Audit>(); const [toast, setToast] = useState<{ text: string; kind: 'alert' | 'reject' | 'info' }>();

  const refresh = useCallback(async () => {
    try {
      const l = await api<PatientRow[]>('patients'); l.sort((a, b) => rank(a) - rank(b) || a.pseudonym.localeCompare(b.pseudonym)); setList(l);
      setAudit(await api<Audit>('audit'));
      if (sel) setDetail(await api<Detail>(`patients/${sel}`));
    } catch (e: any) { if (e.message === 'pin') { setAuthed(false); PIN = ''; } }
  }, [sel]);
  useEffect(() => { if (authed) refresh(); }, [authed, sel]);
  useEffect(() => {
    if (!authed) return;
    const es = new EventSource(`/api/portal/events?pin=${encodeURIComponent(PIN)}`);
    es.addEventListener('record', async (e) => { const d = JSON.parse((e as MessageEvent).data); await refresh(); setToast(d.status === 'alert' ? { text: `Red flag: ${d.pseudonym} deviates from the plan`, kind: 'alert' } : { text: `${d.pseudonym}: new daily summary, on plan`, kind: 'info' }); });
    es.addEventListener('rejected', (e) => { const d = JSON.parse((e as MessageEvent).data); refresh(); setToast({ text: `Rejected message: ${REASONS[d.reason] ?? d.reason}`, kind: 'reject' }); });
    es.addEventListener('enrolled', () => refresh()); es.addEventListener('protocol', () => refresh());
    return () => es.close();
  }, [authed, refresh]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(undefined), 6000); return () => clearTimeout(t); } }, [toast]);

  if (!authed) return (
    <main class="login"><SwitchNav /><h1>KneeTrack Clinic</h1><p class="muted">Demo access. Synthetic patients only.</p>
      <form onSubmit={async (e) => { e.preventDefault(); PIN = pin; try { await api('patients'); sessionStorage.setItem('pin', pin); setAuthed(true); } catch { PIN = ''; setBad(true); } }}>
        <label>Demo PIN<input type="password" inputMode="numeric" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} autofocus /></label>
        <button class="btn primary">Open portal</button>{bad && <p class="error">Wrong PIN.</p>}</form></main>
  );

  const exceptions = list.filter((p) => p.last?.status === 'alert').length;
  return (
    <div class="app">
      <header class="top"><SwitchNav /><span class="muted hint">Only exceptions need your attention</span>
        <span class="sp" /><AuditBadge audit={audit} /></header>
      {toast && <div class={`toast ${toast.kind}`} role="status">{toast.text}</div>}
      <div class="cols">
        <nav class="list" aria-label="Patients">
          <h2>Patients <small>{exceptions} need review</small></h2>
          {list.map((p) => (
            <button class={`prow ${sel === p.pseudonym ? 'sel' : ''}`} onClick={() => setSel(p.pseudonym)}>
              <span><b>{p.name}</b><small>{p.pseudonym} · week {p.last?.week ?? '–'}{p.last?.stage && ` · stage ${p.last.stage.index}/${p.last.stage.total}`}</small></span>
              {p.last?.status === 'alert' ? <span class="chip red">Red flag</span> : p.last?.milestone ? <span class="chip blue">May be ready for review</span> : <span class="chip green">On plan</span>}
            </button>))}
          <p class="muted tiny">Names are synthetic and joined to pseudonyms only in this view. Measurements are stored under the pseudonym.</p>
        </nav>
        <section class="detail">{detail && sel ? <DetailView d={detail} onChange={refresh} /> : <div class="empty"><h2>Select a patient</h2><p class="muted">Patients on plan produce no alerts. Red flags appear here live.</p></div>}
          <AuditPanel audit={audit} /></section>
      </div>
      <footer class="muted tiny">Demonstration prototype with synthetic data. Not a medical device. Alerts say values deviate from the plan, never what the cause is.</footer>
    </div>
  );
}
/** Demo navigation between the two views, as in the design. */
const SwitchNav = () => <nav class="switch" aria-label="View"><a href="/">Patient</a><span class="on" aria-current="page">Clinician</span></nav>;
const FlagIcon = () => <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#b3261e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 25V4M6 5h15l-3 5.5 3 5.5H6" /></svg>;
const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const rank = (p: PatientRow) => (p.last?.status === 'alert' ? 0 : p.last?.milestone ? 1 : 2);
const AuditBadge = ({ audit }: { audit?: Audit }) => audit ? <span class={`chip ${audit.chainValid ? 'green' : 'red'}`} title="Hash-chained audit log">{audit.chainValid ? '✔' : '✘'} audit log {audit.chainValid ? 'intact' : 'BROKEN'} · {audit.total}</span> : null;

// ------------------------------------------------------------------ detail
function DetailView({ d: full, onChange }: { d: Detail; onChange: () => void }) {
  // Charts and the status banners use the operated leg only; reference readings of the other knee appear in the timeline.
  const d: Detail = { ...full, records: full.records.filter((r) => !isReference(full.protocol, r.summary)) };
  const refs = full.records.filter((r) => isReference(full.protocol, r.summary));
  const last = d.records.at(-1);
  const redFlags = last ? d.records.filter((r) => daysBetween(r.summary.date, last.summary.date) <= 6 && r.evaluation.status === 'alert').length : 0;
  return (
    <>
      <p class="lead">Week {last?.evaluation.week ?? '–'}{phaseInfo(d.protocol) && ` · ${phaseInfo(d.protocol)!.name}`}</p>
      <h1 class="pname">{d.identity?.name ?? d.pseudonym}</h1>
      <p class="flagcount">{redFlags > 0 ? <><b class="red">{redFlags} red flag{redFlags > 1 ? 's' : ''}</b> in the last 7 days.</> : 'No red flags in the last 7 days.'}</p>
      <p class="muted tiny">{d.pseudonym}{d.identity && ` · born ${d.identity.birthYear}`} · operated leg: {d.protocol.operatedLeg ?? 'not set'}</p>
      {last && isMilestoneReached(d.protocol, last.summary) && <MilestoneCard d={d} onAdvanced={onChange} />}
      {last?.crossCheck === 'mismatch' && <div class="flagcard"><b>Rule cross-check mismatch</b><p>The phone's alert set differs from the server's recomputation. The server's result is shown.</p></div>}
      <ReferenceCard last={last} ref0={refs.at(-1)} gap={d.protocol.referenceGapDeg} />
      <div class="charts">
        <Chart title="Flexion (bend)" unit="°" d={d} pick={(r) => r.summary.flexion} target={(w) => stageFor(d.protocol, w).flexionTargetDeg} tol={d.protocol.tolerance.flexionDeg} lo={40} hi={130} below />
        <Chart title="Extension deficit (0 = straight)" unit="°" d={d} pick={(r) => r.summary.extension} target={(w) => stageFor(d.protocol, w).extensionTargetDeg} tol={d.protocol.tolerance.extensionDeg} lo={0} hi={20} />
        <Chart title="Range of motion (flexion − extension deficit)" unit="°" d={d} pick={(r) => rom(r.summary)} lo={0} hi={140} />
        <Chart title="Pain (0–10)" unit="" d={d} pick={(r) => r.summary.pain} limit={d.protocol.painLimit} lo={0} hi={10} />
      </div>
      <h3>Timeline</h3>
      <ol class="tl">
        {[...full.records].reverse().map((r) => {
          const ref = isReference(full.protocol, r.summary); const bad = r.evaluation.status === 'alert' && !ref;
          return (
            <li class={bad ? 'bad' : ref ? 'ref' : ''}>
              <i class="mk" />
              <div class="dt" title={`${r.summary.leg ?? ''} knee · extension: ${r.summary.extPosture ?? '?'} · flexion: ${r.summary.flexPosture ?? '?'}`}>{fmtDate(r.summary.date)}{ref && <span class="refTag">other knee · reference</span>}</div>
              <div class="mv">Flexion {r.summary.flexion}° · Pain {r.summary.pain}/10 · ROM {rom(r.summary)}°</div>
              <div class="meter"><i style={{ width: `${Math.min(100, (r.summary.flexion / 130) * 100)}%` }} /></div>
              {bad && <div class="flagcard" role="alert"><FlagIcon /><div><b>{r.evaluation.alerts.some((a) => a.severity === 'high') ? 'Red Flag' : 'Trend'}</b>{r.evaluation.alerts.map((a) => <p>{a.detail}</p>)}</div></div>}
              <div class="int" title={`device ${r.kid} · sha256 ${r.jwsSha256.slice(0, 12)}…`}>✔ signed{r.crossCheck === 'mismatch' ? ' · ⚠ cross-check' : ' · ✔ rules match'}</div>
            </li>
          );
        })}
      </ol>
      <ProtocolEditor d={full} onSaved={onChange} />
    </>
  );
}

/** The app only flags that the measurable criteria are met. The clinician confirms the rest and advances. */
function MilestoneCard({ d, onAdvanced }: { d: Detail; onAdvanced: () => void }) {
  const ph = phaseInfo(d.protocol)!; const [ticked, setTicked] = useState<string[]>([]); const [err, setErr] = useState('');
  useEffect(() => { setTicked([]); setErr(''); }, [d.pseudonym, ph.index]);
  const all = ph.clinicianChecks.every((c) => ticked.includes(c)); const last = ph.index >= ph.total;
  const advance = async () => { const r = await api<{ ok?: boolean; error?: string }>(`protocol/${d.pseudonym}/advance`, { method: 'POST', body: JSON.stringify({ confirmed: ticked }) }); if (r.ok) onAdvanced(); else setErr(r.error ?? 'failed'); };
  return (
    <div class="milestone"><b>May be ready for review · {ph.name}</b>
      <p>Angle criteria for this stage are met ({ph.exit!.flexionDeg}° flexion, extension deficit ≤ {ph.exit!.extensionDeg}°). The app never unlocks a stage by itself: please confirm what it cannot measure, then decide.</p>
      {ph.clinicianChecks.map((c) => <label class="check"><input type="checkbox" checked={ticked.includes(c)} onChange={(e) => setTicked((t) => ((e.target as HTMLInputElement).checked ? [...t, c] : t.filter((x) => x !== c)))} /> {c}</label>)}
      {!last && <button class="btn primary" disabled={!all} onClick={advance}>Advance to {d.protocol.phases![ph.index].name}</button>}
      {err && <p class="error">{err.replace(/_/g, ' ')}</p>}
    </div>
  );
}

/** Compares the latest operated-knee reading with the other knee. Display only: it never raises an alert. */
function ReferenceCard({ last, ref0, gap }: { last?: Rec; ref0?: Rec; gap?: number }) {
  if (!ref0) return <div class="refcard muted">No reference reading of the other knee yet. The patient can record one in the app.</div>;
  const diff = last ? Math.round(ref0.summary.flexion - last.summary.flexion) : undefined;
  const within = diff !== undefined && gap !== undefined ? diff <= gap : undefined;
  return (
    <div class="refcard">
      <b>Other knee (reference, {ref0.summary.date})</b>: flexion {ref0.summary.flexion}°, extension deficit {ref0.summary.extension}°.
      {diff !== undefined && <> Operated knee flexion is <b>{diff <= 0 ? 'at or above' : `${diff}° below`}</b> the other knee{within !== undefined && <> · <span class={`chip ${within ? 'green' : 'blue'}`}>{within ? `within ${gap}°` : `more than ${gap}° apart`}</span></>}.</>}
      <small class="muted"> Display only, no alert. The gap is an example value from the protocol configuration.</small>
    </div>
  );
}

function Chart({ title, unit, d, pick, target, tol, limit, lo, hi, below }: { title: string; unit: string; d: Detail; pick: (r: Rec) => number; target?: (week: number) => number; tol?: number; limit?: number; lo: number; hi: number; below?: boolean }) {
  const recs = d.records.slice(-21); if (recs.length < 2) return null;
  const W = 340, H = 120, px = 28, py = 14;
  const x = (i: number) => px + (i * (W - px - 8)) / (recs.length - 1), y = (v: number) => H - py - ((Math.min(hi, Math.max(lo, v)) - lo) * (H - 2 * py)) / (hi - lo);
  const tg = target ? recs.map((r) => target(weekOf(d.protocol, r.summary.date))) : [];
  const stepPath = tg.map((t, i) => `${i ? 'L' : 'M'}${x(i)},${y(t)}`).join(' ');
  const edge = tg.map((t) => (below ? t - tol! : t + tol!));
  const band = tg.length ? `${edge.map((t, i) => `${i ? 'L' : 'M'}${x(i)},${y(t)}`).join(' ')} L${x(recs.length - 1)},${y(below ? lo : hi)} L${x(0)},${y(below ? lo : hi)} Z` : '';
  return (
    <figure><figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {[lo, (lo + hi) / 2, hi].map((t) => <g><line x1={px} x2={W - 8} y1={y(t)} y2={y(t)} class="grid" /><text x={px - 4} y={y(t) + 4} class="axis" text-anchor="end">{Math.round(t)}</text></g>)}
        {band && <path d={band} class="band" />}
        {limit !== undefined && <line x1={px} x2={W - 8} y1={y(limit)} y2={y(limit)} class="limit" />}
        {tg.length > 0 && <path d={stepPath} class="tgt" />}
        <path d={recs.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${y(pick(r))}`).join(' ')} class="ln" />
        {recs.map((r, i) => <circle cx={x(i)} cy={y(pick(r))} r="3.5" class={r.evaluation.status === 'alert' ? 'pt bad' : 'pt'}><title>{r.summary.date}: {pick(r)}{unit}</title></circle>)}
      </svg>
      <small class="muted">{below ? 'Shaded = more than tolerance below the weekly target (alert zone)' : limit !== undefined ? 'Red line = clinician-set pain limit' : target ? 'Shaded = more than tolerance above the weekly target (alert zone)' : 'Derived: flexion minus extension deficit'}</small>
    </figure>
  );
}

function ProtocolEditor({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const [pr, setPr] = useState<Protocol>(d.protocol); const [qr, setQr] = useState<{ url: string; img: string }>(); const [saved, setSaved] = useState(false);
  useEffect(() => setPr(d.protocol), [d.pseudonym]);
  const setStage = (i: number, k: 'flexionTargetDeg' | 'extensionTargetDeg', v: number) => setPr({ ...pr, stages: pr.stages.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  const save = async () => { await api(`protocol/${d.pseudonym}`, { method: 'PUT', body: JSON.stringify({ painLimit: pr.painLimit, stages: pr.stages, operatedLeg: pr.operatedLeg }) }); setSaved(true); setTimeout(() => setSaved(false), 2000); onSaved(); };
  const invite = async () => { const { token } = await api<{ token: string }>('enroll-token', { method: 'POST', body: JSON.stringify({ pseudonym: d.pseudonym }) }); const url = `${location.origin}/?enroll=${token}`; setQr({ url, img: await QRCode.toDataURL(url, { margin: 1, width: 220 }) }); };
  return (
    <details class="proto"><summary>Edit protocol <span class="muted">(mock e-referral) and invite patient</span></summary>
      <p class="muted tiny">{pr.label}. Targets are examples set by the clinician; the signed protocol is pushed to the phone, which rejects anything not signed by this clinic.</p>
      <div class="grid2">{pr.stages.map((s, i) => (
        <div class="stage"><b>From week {s.fromWeek}</b>
          <label>Flexion target °<input type="number" value={s.flexionTargetDeg} onInput={(e) => setStage(i, 'flexionTargetDeg', +(e.target as HTMLInputElement).value)} /></label>
          <label>Extension deficit °<input type="number" value={s.extensionTargetDeg} onInput={(e) => setStage(i, 'extensionTargetDeg', +(e.target as HTMLInputElement).value)} /></label></div>))}
        <div class="stage"><b>Operated leg</b><label>Targets apply to<select value={pr.operatedLeg ?? 'right'} onChange={(e) => setPr({ ...pr, operatedLeg: (e.target as HTMLSelectElement).value as 'left' | 'right' })}><option value="left">Left</option><option value="right">Right</option></select></label></div>
        <div class="stage"><b>Pain limit</b><label>0–10<input type="number" min="0" max="10" value={pr.painLimit} onInput={(e) => setPr({ ...pr, painLimit: +(e.target as HTMLInputElement).value })} /></label></div></div>
      <div class="row"><button class="btn primary" onClick={save}>{saved ? 'Saved and signed ✔' : 'Save protocol'}</button><button class="btn" onClick={invite}>Invite patient (setup QR)</button></div>
      {qr && <div class="qr"><img src={qr.img} width="220" height="220" alt="Setup QR code" /><div><p><b>One-time setup link</b></p><code>{qr.url}</code><p class="muted tiny">Scan with the patient phone. Link works once; the phone then registers its own signing key.</p></div></div>}
    </details>
  );
}

function AuditPanel({ audit }: { audit?: Audit }) {
  if (!audit) return null;
  return (
    <details class="audit"><summary>Security log <AuditBadge audit={audit} /></summary>
      <ul>{audit.entries.slice(0, 15).map((e) => <li class={e.event.includes('rejected') ? 'bad' : ''}><time>{e.ts.slice(11, 19)}</time> <b>{e.event.replace(/_/g, ' ')}</b> {e.detail.reason ? `— ${REASONS[e.detail.reason] ?? e.detail.reason}` : ''} {e.detail.pseudonym ? `· ${e.detail.pseudonym}` : ''} <code>{e.hash.slice(0, 8)}</code></li>)}</ul>
    </details>
  );
}
