import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  acceptProtocolUpdate, buildBundle, checkPair, evaluate, importPublic, kneeAngle, legOf, MEASUREMENT, missedDays, operatedHistory, phaseInfo, rom, stageFor, StillnessDetector, verifyClaims, weekOf,
  type Leg, type Posture,
  type DailySummary, type Evaluation, type Protocol, type ProtocolClaims, type SummaryClaims,
} from '@tele/engine';
import { getDeviceKey, wipeKey } from './keystore';
import { load, save, todayISO, wipe, type Persist } from './state';
import { flushOutbox, queue, signAndSend } from './outbox';
import { RealSensor, requestMotionPermission, SimSensor, type Sensor } from './sensor';

// Position illustrations: <posture>-<step>.svg (8 files, made by scripts/gen-illustrations.mjs).
const POSES = import.meta.glob('./assets/poses/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const poseFor = (posture: Posture, step: string) => ({
  src: POSES[`./assets/poses/${posture}-${step}.svg`],
  alt: `${posture === 'lying' ? 'Lying on your back' : 'Sitting on a chair'}, ${step.startsWith('flex') ? 'knee bent' : 'leg straight'}, phone on the ${step.endsWith('thigh') ? 'thigh with its top edge toward the knee' : 'shin with its top edge toward the ankle'}`,
});

// Demo presets for week 3 (plan goal 78° flexion, pain limit 6): a typical good day, and a setback day like the stiff patient's.
const PRESETS = { normal: { flexion: 82, extension: 1, pain: 3 }, redflag: { flexion: 62, extension: 9, pain: 7 } } as const;
/** Verifies the clinic signature with the key pinned at enrolment. Returns the claims (or undefined). */
async function protocolClaims(jws: string, p: Persist): Promise<ProtocolClaims | undefined> {
  try { return await verifyClaims<ProtocolClaims>(jws, await importPublic(p.clinicPub), 'protocol+jws'); } catch { return undefined; }
}

export function App() {
  const [p, setP] = useState<Persist | undefined>(() => load());
  const [protocol, setProtocol] = useState<Protocol>();
  const [screen, setScreen] = useState<'home' | 'session' | 'result'>('home');
  const [result, setResult] = useState<Result>();
  const [tamper, setTamper] = useState(false);
  const [bootErr, setBootErr] = useState<string>();
  const enrollToken = useMemo(() => new URLSearchParams(location.search).get('enroll'), []);

  const [planNote, setPlanNote] = useState('');
  // Storage is the source of truth (the outbox flush also writes to it), so merge from storage, not from stale state.
  const update = (patch: Partial<Persist>) => setP((cur) => { const n = { ...(load() ?? cur!), ...patch }; save(n); return n; });
  const refresh = () => setP(load());

  useEffect(() => { // verify the clinic-signed protocol on every start and whenever the patient returns home, then try to refresh it
    if (!p || screen !== 'home') return;
    (async () => {
      const cur = await protocolClaims(p.protocolJws, p);
      if (!cur || cur.sub !== p.pseudonym) { setBootErr('Care plan signature is invalid. Ask your clinic for a new setup link.'); return; }
      setProtocol(cur.protocol);
      try {
        const r = await fetch(`/api/protocol/${p.pseudonym}`); if (!r.ok) return;
        const { protocolJws } = await r.json(); const next = await protocolClaims(protocolJws, p);
        if (!next) { setPlanNote('A care-plan update was ignored: its signature is not valid.'); return; }
        // A valid signature is not enough: refuse another patient's plan and any plan older than the one we already have.
        const verdict = acceptProtocolUpdate(cur, next, p.pseudonym);
        if (verdict.ok) { setProtocol(next.protocol); update({ protocolJws }); setPlanNote(''); }
        else setPlanNote(`A care-plan update was ignored (${verdict.reason.replace(/_/g, ' ')}). Your last verified plan is still in use.`);
      } catch { /* offline: keep the verified plan */ }
    })();
  }, [p?.pseudonym, screen]);

  useEffect(() => { // send days that were measured offline, now and whenever the connection comes back
    if (!p) return;
    const go = () => flushOutbox().then(refresh);
    go(); window.addEventListener('online', go); return () => window.removeEventListener('online', go);
  }, [p?.pseudonym]);

  if (!window.isSecureContext) return <Shell center><h1>Secure connection needed</h1><p class="muted">This app needs HTTPS to read motion sensors and sign data. Open the https:// link from your clinic.</p></Shell>;
  if (!p) return <Enroll token={enrollToken} onDone={(np) => { save(np); setP(np); history.replaceState(null, '', '/'); }} />;
  if (bootErr) return <Shell center><h1>Care plan problem</h1><p class="muted">{bootErr}</p><div class="bar"><button class="btn ghost" onClick={() => { wipe(); wipeKey(); setP(undefined); }}>Reset this phone</button></div></Shell>;
  if (!protocol) return <Shell center><p class="muted">Checking your care plan…</p></Shell>;

  const today = todayISO(p.dayOffset);
  if (screen === 'session') return (
    <Session p={p} protocol={protocol} today={today} tamper={tamper}
      onCancel={() => setScreen('home')}
      onDone={(r) => { setResult(r); setTamper(false); setScreen('result'); }}
      update={update} />
  );
  const resetPhone = () => { wipe(); wipeKey(); setP(undefined); setProtocol(undefined); setScreen('home'); };
  if (screen === 'result' && result) return <ResultView r={result} p={p} protocol={protocol} onHome={() => setScreen('home')} onReset={resetPhone} />;
  return (
    <Home p={p} protocol={protocol} today={today} planNote={planNote} onStart={() => setScreen('session')}
      tools={<DemoTools p={p} update={update} tamper={tamper} setTamper={setTamper} reset={resetPhone} />} />
  );
}

// ---------------------------------------------------------------- shell
/** Top switch between the two views (demo navigation, as in the design), content column, and room for a sticky bottom bar. */
function Shell({ children, center }: { children?: any; center?: boolean }) {
  return (
    <div class="shell">
      <nav class="switch" aria-label="View"><span class="on" aria-current="page">Patient</span><a href="/portal/">Clinician</a></nav>
      <main class={`content ${center ? 'center' : ''}`}>{children}</main>
    </div>
  );
}
const Disclaimer = () => <p class="disclaimer">Demonstration prototype with synthetic data. Not a medical device. It does not diagnose or change treatment.</p>;
const FlagIcon = () => <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#b3261e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 25V4M6 5h15l-3 5.5 3 5.5H6" /></svg>;

// ---------------------------------------------------------------- week comparison
const shift = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const letter = (d: string) => 'SMTWTFS'[new Date(d + 'T00:00:00Z').getUTCDay()];
/** This week = the 7 days ending today, last week = the 7 days before; flexion per day (undefined = no reading). */
function weekCompare(own: DailySummary[], today: string) {
  const days = Array.from({ length: 7 }, (_, i) => shift(today, i - 6));
  const at = (d: string) => own.find((h) => h.date === d)?.flexion;
  return { days, now: days.map(at), before: days.map((d) => at(shift(d, -7))) };
}
function WeekChart({ days, now, before, goal }: { days: string[]; now: (number | undefined)[]; before: (number | undefined)[]; goal?: number }) {
  const vals = [...now, ...before, goal].filter((v): v is number => v !== undefined);
  if (!now.some((v) => v !== undefined)) return null;
  const lo = Math.floor((Math.min(...vals) - 5) / 10) * 10, hi = Math.max(lo + 30, Math.ceil((Math.max(...vals) + 5) / 10) * 10);
  const W = 354, H = 215, L = 44, R = 10, T = 10, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / 6, y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (a: (number | undefined)[]) => a.map((v, i) => (v === undefined ? '' : `${i === 0 || a[i - 1] === undefined ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(' ');
  const ticks: number[] = []; for (let t = lo; t <= hi; t += 10) ticks.push(t);
  const lastI = now.map((v) => v !== undefined).lastIndexOf(true);
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Knee bend by day, this week compared with last week">
      {ticks.map((t) => <g><line class="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text class="ax" x={L - 8} y={y(t) + 5} text-anchor="end">{t}°</text></g>)}
      {goal !== undefined && goal >= lo && goal <= hi && <line class="goalline" x1={L} x2={W - R} y1={y(goal)} y2={y(goal)} />}
      <path class="before" d={path(before)} /><path class="now" d={path(now)} />
      {days.map((d, i) => <text class="ax" x={x(i)} y={H - 6} text-anchor="middle">{letter(d)}</text>)}
      {lastI >= 0 && <circle class="dot" cx={x(lastI)} cy={y(now[lastI]!)} r="7" />}
    </svg>
  );
}
const Legend = () => <div class="legend"><span><i /> This week</span><span><i class="d" /> Last week</span></div>;
const Stat = ({ label, v, sub }: { label: string; v: number; sub?: string }) => <div class="stat"><b>{Math.round(v)}°</b><span>{label}</span>{sub && <small>{sub}</small>}</div>;

// ---------------------------------------------------------------- enroll
function Enroll({ token, onDone }: { token: string | null; onDone: (p: Persist) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'err'>('idle'); const [msg, setMsg] = useState('');
  if (!token) return <Shell center><h1>Welcome</h1><p class="muted">Your clinic gives you a setup link or QR code. Open it on this phone to start.</p></Shell>;
  const go = async () => {
    setState('busy');
    try {
      const k = await getDeviceKey();
      const r = await fetch('/api/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, jwk: k.publicJwk, kid: k.kid }) });
      if (!r.ok) throw new Error('This setup link was already used or is not valid. Ask your clinic for a new one.');
      const b = await r.json();
      // Pin the clinic key and verify the care plan before accepting anything.
      const c = await verifyClaims<ProtocolClaims>(b.protocolJws, await importPublic(b.clinicPublicJwk), 'protocol+jws');
      if (c.sub !== b.pseudonym) throw new Error('Care plan does not match this patient.');
      onDone({ pseudonym: b.pseudonym, kid: k.kid, clinicPub: b.clinicPublicJwk, protocolJws: b.protocolJws, history: b.history, seq: 0, dayOffset: 0, sim: !('ontouchstart' in window), preset: 'normal' });
    } catch (e: any) { setMsg(e.message ?? 'Setup failed'); setState('err'); }
  };
  return (
    <Shell>
      <div class="mid"><h1>Set up this phone</h1>
      <p class="muted">This links your phone to your care team. A private signing key is created on this phone and never leaves it.</p>
      {state === 'err' && <p class="error">{msg}</p>}</div>
      <div class="bar"><button class="btn primary" disabled={state === 'busy'} onClick={go}>{state === 'busy' ? 'Setting up…' : 'Set up'}</button></div>
    </Shell>
  );
}

// ---------------------------------------------------------------- home
function Home({ p, protocol, today, planNote, onStart, tools }: { p: Persist; protocol: Protocol; today: string; planNote: string; onStart: () => void; tools: any }) {
  const own = operatedHistory(protocol, p.history); // reference readings of the other knee are not part of the trend
  const done = own.some((h) => h.date === today);
  const gap = missedDays(own, today);
  const last = own.at(-1);
  const week = weekOf(protocol, today); const st = stageFor(protocol, week);
  const wk = weekCompare(own, today);
  return (
    <Shell>
      <h1>{gap >= 3 ? 'Welcome back' : 'Good to see you'}</h1>
      <p class="lead">{gap >= 3 ? 'Glad you are here. Your progress is exactly where you left it.' : `Week ${week}${phaseInfo(protocol) ? ` · ${phaseInfo(protocol)!.name}` : ''}`}</p>
      {planNote && <p class="muted tiny" role="status">{planNote}</p>}
      {last && (
        <div class="stats">
          <Stat label="Bend" v={last.flexion} sub={`plan goal ${st.flexionTargetDeg}°`} />
          <Stat label="Straighten" v={last.extension} sub={`plan goal ${st.extensionTargetDeg}°`} />
          <Stat label="Range" v={rom(last)} />
        </div>
      )}
      {last && <div class="caption center-t">Plan goals are examples set by your clinician.</div>}
      {!!p.outbox?.length && <p class="muted" role="status">{p.outbox.length} day(s) saved on this phone, waiting to be sent.</p>}
      {p.note && <p class="error" role="status">{p.note}</p>}
      <WeekChart {...wk} goal={st.flexionTargetDeg} />
      {wk.now.some((v) => v !== undefined) && <Legend />}
      {tools}
      <Disclaimer />
      <div class="bar"><button class="btn primary" onClick={onStart}>{done ? 'Measure again' : 'Start today’s session'}</button></div>
    </Shell>
  );
}

// ---------------------------------------------------------------- session
type Step = 'guide' | 'ext-thigh' | 'ext-shin' | 'flex-thigh' | 'flex-shin' | 'pain';
const STEPS: Step[] = ['guide', 'flex-thigh', 'flex-shin', 'ext-thigh', 'ext-shin', 'pain'];
const pos = (po: Posture) => (po === 'lying' ? 'Lie on your back' : 'Sit');
function copy(step: Exclude<Step, 'guide' | 'pain'>, ext: Posture, flex: Posture): { title: string; body: string } {
  switch (step) {
    case 'ext-thigh': return { title: 'Straighten: thigh', body: `${pos(ext)}, leg as straight as is comfortable${ext === 'lying' ? ', heel propped' : ', heel on the floor or a stool'}. Strap the phone on your thigh, just above the knee, top edge toward the knee.` };
    case 'ext-shin': return { title: 'Straighten: shin', body: 'Keep your leg still. Move the phone to your shin, just below the knee, top edge toward your foot.' };
    case 'flex-thigh': return { title: 'Bend: thigh', body: `${pos(flex)} and bend the knee as far as is comfortable. Strap the phone on your thigh, just above the knee, top edge toward the knee.` };
    case 'flex-shin': return { title: 'Bend: shin', body: 'Keep your knee bent and still. Move the phone to your shin, just below the knee, top edge toward your foot.' };
  }
}
/** Why the clinic refused a message, in words a patient can act on. */
const REFUSED: Record<string, { text: string; reset?: boolean }> = {
  unknown_device: { text: 'This phone is not registered with the clinic any more (their demo data may have been reset). Set it up again with a new setup link.', reset: true },
  signature_invalid: { text: 'The message was changed on the way, so the clinic refused it. Nothing was saved.' },
  duplicate_jti: { text: 'The clinic already has this message.' }, stale_seq: { text: 'The clinic already has a newer message from this phone.' },
  iat_out_of_window: { text: 'This phone’s clock is more than 5 minutes off. Turn on automatic date and time in the phone settings, then measure again.' },
  date_out_of_window: { text: 'The date on this phone is too far from today’s date for the clinic to accept. Check the phone’s date and time.' },
  values_out_of_range: { text: 'The values looked impossible. Please measure again.' }, fhir_invalid: { text: 'The result could not be read by the clinic. Please measure again.' },
  no_protocol: { text: 'The clinic has no care plan for you yet. Ask them to set it up.' }, subject_mismatch: { text: 'This phone is registered to a different patient. Set it up again with a new setup link.', reset: true },
};
interface Result { summary: DailySummary; evaluation: Evaluation; sent: { ok: boolean; reason?: string; crossCheck?: string }; payloadPreview: unknown; replayed?: boolean }

function Session({ p, protocol, today, tamper, onCancel, onDone, update }: { p: Persist; protocol: Protocol; today: string; tamper: boolean; onCancel: () => void; onDone: (r: Result) => void; update: (x: Partial<Persist>) => void }) {
  const [i, setI] = useState(0); const [ang, setAng] = useState<Record<string, number>>({}); const [busy, setBusy] = useState(false); const [problem, setProblem] = useState(''); const operated: Leg = protocol.operatedLeg ?? 'right'; const [leg, setLeg] = useState<Leg>(operated); const [ext, setExt] = useState<Posture>('lying'); const [flex, setFlex] = useState<Posture>('sitting');
  const step = STEPS[i]; const preset = PRESETS[p.preset];
  const hint: Record<string, number> = { 'ext-thigh': 88, 'ext-shin': 88 + preset.extension, 'flex-thigh': 20, 'flex-shin': 20 + preset.flexion };

  const MSG = {
    bend_not_detected: 'The bend was not detected: both readings were almost the same. Bend your knee and move the phone from the thigh to the shin, then try again.',
    bend_implausible: 'That bend is not possible for a knee. Check that the phone is on the outer side of your leg, top edge toward your foot.',
    not_straight: 'The leg does not look straight. Lie on your back with the leg as straight as is comfortable, then try again.',
  };
  /** Stores one reading; after each thigh+shin pair, checks it is plausible and repeats the pair if not. */
  const capture = (a: number) => {
    const next = { ...ang, [step]: a };
    const pair = step === 'ext-shin' ? (['extension', 'ext-thigh'] as const) : step === 'flex-shin' ? (['flexion', 'flex-thigh'] as const) : undefined;
    if (pair) {
      const bad = checkPair(pair[0], next[pair[1]], a);
      if (bad) { setProblem(MSG[bad]); setI(STEPS.indexOf(pair[1])); return; }
    }
    setProblem(''); setAng(next); setI(i + 1);
  };

  const finish = async (pain: number) => {
    setBusy(true);
    const summary: DailySummary = { leg, extPosture: ext, flexPosture: flex, date: today, flexion: Math.round(kneeAngle(ang['flex-thigh'], ang['flex-shin'])), extension: Math.round(kneeAngle(ang['ext-thigh'], ang['ext-shin'])), pain };
    const hist = [...p.history.filter((h) => !(h.date === today && legOf(protocol, h) === leg)), summary];
    const evaluation = evaluate(protocol, hist, summary);              // rule engine runs ON THE PHONE
    const bundle = buildBundle(p.pseudonym, summary, evaluation.alerts);
    const { outcome, jws, seq } = await signAndSend(bundle, tamper);
    const sent: Result['sent'] = outcome.ok ? { ok: true, crossCheck: outcome.crossCheck } : { ok: false, reason: outcome.reason };
    if (!outcome.ok && outcome.network) queue(bundle); // measured offline: keep it and send later (signed again at send time)
    // Keep the day locally when delivered or queued; a clinic rejection (e.g. tampering) is not kept as a result.
    const keep = outcome.ok || !!(!outcome.ok && outcome.network);
    update({ history: keep ? hist : p.history, lastJws: outcome.ok ? jws : load()?.lastJws });
    onDone({ summary, evaluation, sent, payloadPreview: { sub: p.pseudonym, seq, bundle } });
  };

  const wk = weekOf(protocol, today); const goals = stageFor(protocol, wk);
  const kneeRef = step === 'flex-shin' ? ang['flex-thigh'] : step === 'ext-shin' ? ang['ext-thigh'] : undefined;
  const goal = step === 'flex-shin' ? goals.flexionTargetDeg : step === 'ext-shin' ? goals.extensionTargetDeg : undefined;
  const legName = leg === 'left' ? 'Left' : 'Right';

  return (
    <Shell>
      <div class="progress" aria-label={`Step ${i + 1} of ${STEPS.length}`}>{STEPS.map((_, k) => <i class={k <= i ? 'on' : ''} />)}</div>
      {problem && <p class="error" role="alert">{problem}</p>}
      {step === 'guide' && <Guide sim={p.sim} leg={leg} operated={operated} onLeg={setLeg} onNext={() => setI(1)} onCancel={onCancel} />}
      {step !== 'guide' && step !== 'pain' && (
        <Reading key={step} title={copy(step, ext, flex).title} body={copy(step, ext, flex).body} lead={`${legName} knee · ${copy(step, ext, flex).title.toLowerCase()}`}
          pose={poseFor(step.startsWith('ext') ? ext : flex, step)} sim={p.sim} hint={hint[step]} kneeRef={kneeRef} goal={goal} onCapture={(a) => capture(a)} onCancel={onCancel}
          picker={(step === 'ext-thigh' || step === 'flex-thigh') && <PosturePick value={step === 'ext-thigh' ? ext : flex} onPick={step === 'ext-thigh' ? setExt : setFlex} note={step === 'ext-thigh' ? 'Lying down gives steadier straightening readings, but sitting is fine too.' : undefined} />} />
      )}
      {step === 'pain' && <Pain hint={p.sim ? preset.pain : undefined} busy={busy} onFinish={finish} onCancel={onCancel} />}
    </Shell>
  );
}

function PosturePick({ value, onPick, note }: { value: Posture; onPick: (p: Posture) => void; note?: string }) {
  return (
    <div class="chips" role="group" aria-label="Your position">
      <span class="muted">Your position</span>
      <button class={`chip ${value === 'lying' ? 'on' : ''}`} aria-pressed={value === 'lying'} onClick={() => onPick('lying')}>Lying down</button>
      <button class={`chip ${value === 'sitting' ? 'on' : ''}`} aria-pressed={value === 'sitting'} onClick={() => onPick('sitting')}>Sitting</button>
      {note && <small class="caption">{note}</small>}
    </div>
  );
}

function Guide({ sim, leg, operated, onLeg, onNext, onCancel }: { sim: boolean; leg: Leg; operated: Leg; onLeg: (l: Leg) => void; onNext: () => void; onCancel: () => void }) {
  const [err, setErr] = useState('');
  const go = async () => { if (sim) return onNext(); const r = await requestMotionPermission(); if (r === 'granted') onNext(); else setErr(r === 'denied' ? 'Motion access was refused. Allow it in the browser settings to measure.' : 'This device has no motion sensor. Use the demo tools to simulate one.'); };
  return (
    <>
      <div class="mid">
      <h1>Strap your phone below the knee.</h1>
      <ol class="steps">
        <li>1. <span>Screen facing out. On the thigh the top edge points to your knee, on the shin to your foot.</span></li>
        <li>2. <span>Pull both straps snug.</span></li>
        <li>3. <span>Four short readings: bend first, then straighten.</span></li>
      </ol>
      <div class="chips" role="group" aria-label="Which knee">
        <span class="muted">Which knee?</span>
        <button class={`chip ${leg === 'left' ? 'on' : ''}`} aria-pressed={leg === 'left'} onClick={() => onLeg('left')}>Left</button>
        <button class={`chip ${leg === 'right' ? 'on' : ''}`} aria-pressed={leg === 'right'} onClick={() => onLeg('right')}>Right</button>
        {leg !== operated && <small class="caption">This is your other knee. It is saved as a reference reading for comparison and does not trigger alerts.</small>}
      </div>
      {err && <p class="error">{err}</p>}
      <button class="link" onClick={onCancel}>Cancel</button>
      </div>
      <div class="bar"><button class="btn primary" onClick={go}>I’m ready</button></div>
    </>
  );
}

function Reading({ title, body, lead, pose, sim, hint, kneeRef, goal, picker, onCapture, onCancel }: { title: string; body: string; lead: string; pose: { src: string; alt: string }; sim: boolean; hint: number; kneeRef?: number; goal?: number; picker?: any; onCapture: (a: number) => void; onCancel: () => void }) {
  type Phase = 'ready' | 'active';
  const [phase, setPhase] = useState<Phase>('ready');
  const [live, setLive] = useState({ angle: 0, progress: 0, stable: false, inPlane: true, moved: false });
  const [left, setLeft] = useState(0); const [simAngle, setSimAngle] = useState(hint);
  const simRef = useRef(hint); simRef.current = simAngle; const done = useRef(false);
  const GRACE_MS = MEASUREMENT.graceMs; // time to place the phone after tapping Start; nothing is captured before this

  const start = () => {
    done.current = false; setPhase('active');
    const t0 = performance.now(); const det = new StillnessDetector();
    const s: Sensor = sim ? new SimSensor(() => simRef.current) : new RealSensor();
    const tick = window.setInterval(() => setLeft(Math.max(0, Math.ceil((GRACE_MS - (performance.now() - t0)) / 1000))), 200);
    s.start((smp) => {
      const r = det.push(smp); const graceOver = performance.now() - t0 > GRACE_MS;
      // A reading counts only after the grace period, with the phone moved since Start (simulated sensor: button only).
      const ok = graceOver && (sim || r.moved) && r.stable;
      setLive({ angle: r.angle, progress: graceOver ? r.progress : 0, stable: ok, inPlane: r.inPlane, moved: sim || r.moved });
      if (ok && !done.current) { done.current = true; navigator.vibrate?.(60); s.stop(); clearInterval(tick); setTimeout(() => onCapture(r.angle), 350); }
    });
    stopRef.current = () => { s.stop(); clearInterval(tick); };
  };
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => () => stopRef.current(), []);

  const hintTxt = live.stable ? 'Got it' : left > 0 ? `Move the phone into place… ${left}` : !live.inPlane ? 'Turn the phone: screen facing outward, not flat' : !live.moved ? 'Move the phone to this position first' : 'Hold still';
  // Shin readings show the live KNEE angle against the thigh reading just taken; thigh readings show the phone's own tilt.
  const shown = kneeRef !== undefined ? kneeAngle(kneeRef, live.angle) : live.angle;
  return (
    <>
      {phase === 'ready' ? (
        <>
          <h1>{title}</h1><p class="muted">{body}</p>
          {picker}
          <img class="pose" src={pose.src} alt={pose.alt} width="900" height="600" />
          <button class="link" onClick={onCancel}>Cancel</button>
          <div class="bar"><button class="btn primary" onClick={start}>Start</button></div>
        </>
      ) : (
        <>
          <p class="lead">{lead}</p>
          <img class="pose small" src={pose.src} alt={pose.alt} width="900" height="600" />
          <div class="big" aria-live="off">{live.stable ? '✓' : left > 0 ? left : `${Math.round(shown)}°`}</div>
          <div class="meter"><div class="track"><i class="fill" style={{ width: `${Math.round(live.progress * 100)}%` }} /></div>{goal !== undefined && <span class="goal">Goal {goal}°</span>}</div>
          <div class="caption">{kneeRef !== undefined ? 'Knee angle' : 'Phone angle'}</div>
          <p class="state" role="status">{hintTxt}</p>
          <p class="muted">{body}</p>
          {sim && <label class="sim">Simulated sensor: segment angle {simAngle}°<input type="range" min="-30" max="170" value={simAngle} onInput={(e) => setSimAngle(+(e.target as HTMLInputElement).value)} /></label>}
          <button class="link" onClick={onCancel}>Cancel</button>
        </>
      )}
    </>
  );
}

function Pain({ hint, busy, onFinish, onCancel }: { hint?: number; busy: boolean; onFinish: (n: number) => void; onCancel: () => void }) {
  const [sel, setSel] = useState<number>();
  return (
    <>
      <h2 style={{ marginTop: '16px' }}>How much does it hurt?</h2><p class="muted">0 is none, 10 is the worst.{hint !== undefined && ` (Demo preset: ${hint})`}</p>
      <div class="pain" role="radiogroup" aria-label="Pain from 0 to 10">{Array.from({ length: 11 }, (_, n) => <button disabled={busy} role="radio" aria-checked={sel === n} class={`pbtn ${sel === n ? 'on' : ''} ${n === hint ? 'hint' : ''}`} onClick={() => setSel(n)}>{n}</button>)}</div>
      {busy && <p class="muted center-t">Saving and sending…</p>}
      <button class="link" onClick={onCancel}>Cancel</button>
      <div class="bar"><button class="btn primary" disabled={sel === undefined || busy} onClick={() => sel !== undefined && onFinish(sel)}>Finish Session</button></div>
    </>
  );
}

// ---------------------------------------------------------------- result
function ResultView({ r, p, protocol, onHome, onReset }: { r: Result; p: Persist; protocol: Protocol; onHome: () => void; onReset: () => void }) {
  const [show, setShow] = useState(false); const e = r.evaluation; const today = r.summary.date;
  const own = operatedHistory(protocol, p.history); const wk = weekCompare(own, today);
  const lastWeek = own.find((h) => h.date === shift(today, -7))?.flexion;
  const delta = lastWeek !== undefined ? r.summary.flexion - lastWeek : undefined;
  const headline = e.reference ? 'Reference reading saved.' : delta === undefined ? 'Nice work today.' : delta > 0 ? `You bent ${delta}° further than last week.` : delta < 0 ? `Your bend is ${-delta}° below last week.` : 'Same bend as last week.';
  const offline = !r.sent.ok && (r.sent.reason === 'offline' || r.sent.reason === 'server_unavailable');
  return (
    <Shell>
      <h1>{headline}</h1>
      {!e.reference && <><WeekChart {...wk} goal={e.flexionTarget} /><Legend /></>}
      <div class="stats">
        <Stat label="Bend" v={r.summary.flexion} sub={e.reference ? undefined : `plan goal ${e.flexionTarget}°`} />
        <Stat label="Straighten" v={r.summary.extension} sub={e.reference ? undefined : `plan goal ${e.extensionTarget}°`} />
        <Stat label="Range" v={rom(r.summary)} />
        <div class="stat"><b>{r.summary.pain}</b><span>Pain</span><small>of 10</small></div>
      </div>
      {e.status === 'alert' && (r.sent.ok || offline) && (
        <div class="flag" role="status"><FlagIcon /><div><b>Your care team will take a look</b><p>Today’s values deviate from the plan, so a short note {r.sent.ok ? 'was sent' : 'will be sent when you are online'} to your clinician. This is not a diagnosis.</p></div></div>
      )}
      <div class="next"><div class="k">{e.reference ? 'Saved for comparison' : 'Your next step'}</div><p class="v">{e.nextStep}</p></div>
      {e.milestoneReached && <p class="win">You have reached the bend and straighten goals for this stage. Your clinician will check the rest and decide on the next stage.</p>}
      {!r.sent.ok && !offline ? (
        <div class="flag" role="alert"><FlagIcon /><div>
          <b>Not delivered</b>
          <p>{(REFUSED[r.sent.reason ?? ''] ?? { text: 'The clinic refused this message. Your result is not saved on their side.' }).text}</p>
          <p class="caption">Code: {r.sent.reason}</p>
          {REFUSED[r.sent.reason ?? '']?.reset && <button class="chip on" onClick={onReset}>Set up this phone again</button>}
        </div></div>
      ) : (
        <div class="note">
          <b>{r.sent.ok ? 'Sent to your care team' : 'Saved on this phone'}</b>
          {r.sent.ok ? <p class="muted">Only today’s numbers and any alert were sent, signed by this phone. Raw sensor readings stayed on the phone.</p>
            : <p class="muted">No connection to your care team right now. Today’s result is saved and will be sent automatically when you are online.</p>}
          <button class="link" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} exactly what was sent</button>
          {show && <pre class="payload">{JSON.stringify({ patient: r.payloadPreview && (r.payloadPreview as any).sub, seq: (r.payloadPreview as any).seq, leg: r.summary.leg, flexion: r.summary.flexion, extension: r.summary.extension, positions: [r.summary.extPosture, r.summary.flexPosture], pain: r.summary.pain, date: r.summary.date, alerts: e.alerts.map((a) => a.kind), note: 'no name, no raw sensor data' }, null, 1)}</pre>}
        </div>
      )}
      <Disclaimer />
      <div class="bar"><button class="btn primary" onClick={onHome}>Done</button></div>
    </Shell>
  );
}

// ---------------------------------------------------------------- demo tools (not part of the product)
function DemoTools({ p, update, tamper, setTamper, reset }: { p: Persist; update: (x: Partial<Persist>) => void; tamper: boolean; setTamper: (b: boolean) => void; reset: () => void }) {
  const [open, setOpen] = useState(false); const [msg, setMsg] = useState('');
  const replay = async () => {
    if (!p.lastJws) return setMsg('Nothing to replay yet.');
    const r = await fetch('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jws: p.lastJws }) });
    setMsg(`Replay of the last message → ${(await r.json()).reason ?? 'accepted?!'}`);
  };
  return (
    <details class="demo" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Demo tools</summary>
      <label class="row"><input type="checkbox" checked={p.sim} onChange={(e) => update({ sim: (e.target as HTMLInputElement).checked })} /> Simulate sensor (laptop)</label>
      <div class="row">Next session: <button class={`chip ${p.preset === 'normal' ? 'on' : ''}`} onClick={() => update({ preset: 'normal' })}>normal day</button><button class={`chip ${p.preset === 'redflag' ? 'on' : ''}`} onClick={() => update({ preset: 'redflag' })}>red-flag day</button></div>
      <div class="row">Date: {todayISO(p.dayOffset)} <button class="chip" onClick={() => update({ dayOffset: p.dayOffset + 1 })}>+1 day</button></div>
      <label class="row"><input type="checkbox" checked={tamper} onChange={(e) => setTamper((e.target as HTMLInputElement).checked)} /> Tamper with the next message in flight</label>
      <div class="row"><button class="chip" onClick={replay}>Replay last message</button><button class="chip" onClick={reset}>Reset phone</button></div>
      {msg && <p class="muted">{msg}</p>}
    </details>
  );
}
