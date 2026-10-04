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

const PRESETS = { normal: { flexion: 96, extension: 0, pain: 2 }, redflag: { flexion: 78, extension: 2, pain: 7 } } as const;
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

  if (!window.isSecureContext) return <Shell><h1>Secure connection needed</h1><p>This app needs HTTPS to read motion sensors and sign data. Open the https:// link from your clinic.</p></Shell>;
  if (!p) return <Enroll token={enrollToken} onDone={(np) => { save(np); setP(np); history.replaceState(null, '', '/'); }} />;
  if (bootErr) return <Shell><h1>Care plan problem</h1><p>{bootErr}</p><button class="btn secondary" onClick={() => { wipe(); wipeKey(); setP(undefined); }}>Reset this phone</button></Shell>;
  if (!protocol) return <Shell><p class="muted">Checking your care plan…</p></Shell>;

  const today = todayISO(p.dayOffset);
  return (
    <Shell>
      {screen === 'home' && planNote && <p class="muted" role="status">{planNote}</p>}
      {screen === 'home' && <Home p={p} protocol={protocol} today={today} onStart={() => setScreen('session')} />}
      {screen === 'session' && (
        <Session p={p} protocol={protocol} today={today} tamper={tamper}
          onCancel={() => setScreen('home')}
          onDone={(r) => { setResult(r); setTamper(false); setScreen('result'); }}
          update={update} />
      )}
      {screen === 'result' && result && <ResultView r={result} p={p} onHome={() => setScreen('home')} />}
      {screen === 'home' && <DemoTools p={p} update={update} tamper={tamper} setTamper={setTamper} reset={() => { wipe(); wipeKey(); setP(undefined); setProtocol(undefined); }} />}
      <footer class="disclaimer">Demonstration prototype with synthetic data. Not a medical device. It does not diagnose or change treatment.</footer>
    </Shell>
  );
}

const Shell = ({ children }: { children?: any }) => <main class="shell"><header class="brand"><span class="dot" />KneeTrack</header>{children}</main>;

// ---------------------------------------------------------------- enroll
function Enroll({ token, onDone }: { token: string | null; onDone: (p: Persist) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'err'>('idle'); const [msg, setMsg] = useState('');
  if (!token) return <Shell><h1>Welcome</h1><p>Your clinic gives you a setup link or QR code. Open it on this phone to start.</p></Shell>;
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
      <h1>Set up this phone</h1>
      <p>This links your phone to your care team. A private signing key is created on this phone and never leaves it.</p>
      <button class="btn primary" disabled={state === 'busy'} onClick={go}>{state === 'busy' ? 'Setting up…' : 'Set up'}</button>
      {state === 'err' && <p class="error">{msg}</p>}
    </Shell>
  );
}

// ---------------------------------------------------------------- home
function Home({ p, protocol, today, onStart }: { p: Persist; protocol: Protocol; today: string; onStart: () => void }) {
  const own = operatedHistory(protocol, p.history); // reference readings of the other knee are not part of the trend
  const done = own.some((h) => h.date === today);
  const gap = missedDays(own, today);
  const last = own.at(-1);
  const week = weekOf(protocol, today); const st = stageFor(protocol, week);
  return (
    <>
      <h1>{gap >= 3 ? 'Welcome back' : 'Good to see you'}</h1>
      <p class="muted">{gap >= 3 ? 'Glad you are here. Your progress is exactly where you left it.' : `Week ${week}${phaseInfo(protocol) ? ` · ${phaseInfo(protocol)!.name}` : ''}`}</p>
      {last && <section class="card"><div class="muted">Latest</div>
        <div class="nums"><Num label="Bend" v={last.flexion} target={`goal ${st.flexionTargetDeg}°`} /><Num label="Straighten" v={last.extension} target={`goal ${st.extensionTargetDeg}°`} /><Num label="Range" v={rom(last)} target="bend − straighten" /></div><div class="muted tiny center">Plan goals are examples set by your clinician.</div></section>}
      {!!p.outbox?.length && <p class="muted" role="status">{p.outbox.length} day(s) saved on this phone, waiting to be sent.</p>}
      {p.note && <p class="error" role="status">{p.note}</p>}
      <Trend history={own} protocol={protocol} />
      <button class="btn primary big" onClick={onStart}>{done ? 'Measure again' : 'Start today’s session'}</button>
      <p class="muted center">About 2 minutes. {done && 'Today is already saved.'}</p>
    </>
  );
}
const Num = ({ label, v, target }: { label: string; v: number; target: string }) => <div class="num"><b>{Math.round(v)}°</b><span>{label}</span><small>{target}</small></div>;

function Trend({ history, protocol }: { history: DailySummary[]; protocol: Protocol }) {
  const h = history.slice(-14); if (h.length < 2) return null;
  const W = 320, H = 130, pad = 22, lo = 40, hi = 120;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (h.length - 1), y = (v: number) => H - pad - ((Math.min(hi, Math.max(lo, v)) - lo) * (H - 2 * pad)) / (hi - lo);
  const line = h.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.flexion)}`).join(' ');
  const target = h.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(stageFor(protocol, weekOf(protocol, d.date)).flexionTargetDeg)}`).join(' ');
  return (
    <section class="card" aria-label="Bend trend">
      <div class="muted">Bend (flexion) over time</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"><path d={target} class="tgt" /><path d={line} class="ln" />{h.map((d, i) => <circle cx={x(i)} cy={y(d.flexion)} r="3" class="pt" />)}</svg>
      <div class="legend"><span><i class="ln-k" /> You</span><span><i class="tgt-k" /> Plan goal</span></div>
    </section>
  );
}

// ---------------------------------------------------------------- session
type Step = 'guide' | 'ext-thigh' | 'ext-shin' | 'flex-thigh' | 'flex-shin' | 'pain';
const STEPS: Step[] = ['guide', 'flex-thigh', 'flex-shin', 'ext-thigh', 'ext-shin', 'pain'];
const pos = (po: Posture) => (po === 'lying' ? 'Lie on your back' : 'Sit');
function copy(step: Exclude<Step, 'guide' | 'pain'>, ext: Posture, flex: Posture): { title: string; body: string } {
  switch (step) {
    case 'ext-thigh': return { title: 'Straighten: thigh', body: `${pos(ext)}, leg as straight as is comfortable${ext === 'lying' ? ', heel propped' : ', heel on the floor or a stool'}. Hold the phone against your thigh, top edge toward your foot.` };
    case 'ext-shin': return { title: 'Straighten: shin', body: 'Keep your leg still. Move the phone to the shin, same direction: top edge toward your foot.' };
    case 'flex-thigh': return { title: 'Bend: thigh', body: `${pos(flex)} and bend the knee as far as is comfortable. Hold the phone on your thigh, top edge toward your foot.` };
    case 'flex-shin': return { title: 'Bend: shin', body: 'Keep your knee bent and still. Move the phone to the shin, top edge toward your foot.' };
  }
}
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

  return (
    <>
      <div class="progress" aria-label={`Step ${i + 1} of ${STEPS.length}`}>{STEPS.map((_, k) => <i class={k <= i ? 'on' : ''} />)}</div>
      {step === 'guide' && <Guide sim={p.sim} leg={leg} operated={operated} onLeg={setLeg} onNext={() => setI(1)} />}
      {problem && <p class="error" role="alert">{problem}</p>}
      {step !== 'guide' && step !== 'pain' && (<>
        {(step === 'ext-thigh' || step === 'flex-thigh') && <PosturePick value={step === 'ext-thigh' ? ext : flex} onPick={step === 'ext-thigh' ? setExt : setFlex} note={step === 'ext-thigh' ? 'Lying down gives steadier straightening readings, but sitting is fine too.' : undefined} />}
        <Reading key={step} title={copy(step, ext, flex).title} body={copy(step, ext, flex).body} sim={p.sim} hint={hint[step]} onCapture={(a) => capture(a)} /></>
      )}
      {step === 'pain' && <Pain hint={p.sim ? preset.pain : undefined} busy={busy} onPick={finish} />}
      <button class="btn link" onClick={onCancel}>Cancel</button>
    </>
  );
}

function PosturePick({ value, onPick, note }: { value: Posture; onPick: (p: Posture) => void; note?: string }) {
  return (
    <div class="posture" role="group" aria-label="Your position">
      <span class="muted">Your position</span>
      <button class={`chip ${value === 'lying' ? 'on' : ''}`} aria-pressed={value === 'lying'} onClick={() => onPick('lying')}>Lying down</button>
      <button class={`chip ${value === 'sitting' ? 'on' : ''}`} aria-pressed={value === 'sitting'} onClick={() => onPick('sitting')}>Sitting</button>
      {note && <small class="muted">{note}</small>}
    </div>
  );
}

function Guide({ sim, leg, operated, onLeg, onNext }: { sim: boolean; leg: Leg; operated: Leg; onLeg: (l: Leg) => void; onNext: () => void }) {
  const [err, setErr] = useState('');
  const go = async () => { if (sim) return onNext(); const r = await requestMotionPermission(); if (r === 'granted') onNext(); else setErr(r === 'denied' ? 'Motion access was refused. Allow it in the browser settings to measure.' : 'This device has no motion sensor. Use the demo tools to simulate one.'); };
  return (
    <>
      <h1>Place your phone</h1>
      <div class="posture" role="group" aria-label="Which leg">
        <span class="muted">Which knee?</span>
        <button class={`chip ${leg === 'left' ? 'on' : ''}`} aria-pressed={leg === 'left'} onClick={() => onLeg('left')}>Left</button>
        <button class={`chip ${leg === 'right' ? 'on' : ''}`} aria-pressed={leg === 'right'} onClick={() => onLeg('right')}>Right</button>
        {leg !== operated && <small class="muted">This is your other knee. It will be saved as a reference reading for comparison and will not trigger alerts.</small>}
      </div>
      <ol class="steps"><li>Strap or hold the phone on the <b>outer side</b> of your leg, screen facing out.</li><li>Keep the <b>top edge pointing toward your foot</b>.</li><li>For each reading: tap <b>Start</b>, move the phone into place, then hold still until the ring fills. Four readings, then one pain tap.</li></ol>
      <button class="btn primary big" onClick={go}>I’m ready</button>
      {err && <p class="error">{err}</p>}
    </>
  );
}

function Reading({ title, body, sim, hint, onCapture }: { title: string; body: string; sim: boolean; hint: number; onCapture: (a: number) => void }) {
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

  const C = 2 * Math.PI * 54;
  const hintTxt = live.stable ? 'Got it' : left > 0 ? `Move the phone into place… ${left}` : !live.inPlane ? 'Turn the phone: screen facing outward, not flat' : !live.moved ? 'Move the phone to this position first' : live.stable ? 'Got it' : 'Hold still';
  return (
    <>
      <h1>{title}</h1><p>{body}</p>
      {phase === 'ready' ? <button class="btn primary big" onClick={start}>Start</button> : (
        <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" class="bg" /><circle cx="60" cy="60" r="54" class="fg" stroke-dasharray={C} stroke-dashoffset={C * (1 - live.progress)} /></svg>
          <div class="ringtxt"><b>{live.stable ? '✓' : left > 0 ? left : `${Math.round(live.angle)}°`}</b><span>{hintTxt}</span></div></div>)}
      {sim && phase === 'active' && <label class="sim">Simulated sensor: segment angle {simAngle}°<input type="range" min="-30" max="170" value={simAngle} onInput={(e) => setSimAngle(+(e.target as HTMLInputElement).value)} /></label>}
    </>
  );
}

function Pain({ hint, busy, onPick }: { hint?: number; busy: boolean; onPick: (n: number) => void }) {
  return (
    <>
      <h1>How much does it hurt right now?</h1><p class="muted">0 is no pain, 10 is the worst you can imagine.{hint !== undefined && ` (Demo preset: ${hint})`}</p>
      <div class="pain">{Array.from({ length: 11 }, (_, n) => <button disabled={busy} class={`pbtn ${n === hint ? 'hint' : ''}`} onClick={() => onPick(n)}>{n}</button>)}</div>
      {busy && <p class="muted center">Saving and sending…</p>}
    </>
  );
}

// ---------------------------------------------------------------- result
function ResultView({ r, p, onHome }: { r: Result; p: Persist; onHome: () => void }) {
  const [show, setShow] = useState(false); const e = r.evaluation;
  return (
    <>
      <h1>{e.reference ? 'Reference reading saved' : e.status === 'alert' ? 'Your care team will take a look' : 'Nice work today'}</h1>
      <section class="card"><div class="nums"><Num label="Bend" v={r.summary.flexion} target={`goal ${e.flexionTarget}°`} /><Num label="Straighten" v={r.summary.extension} target={`goal ${e.extensionTarget}°`} /><Num label="Range" v={rom(r.summary)} target="of motion" /><Num label="Pain" v={r.summary.pain} target="of 10" /></div><div class="muted tiny center">Plan goals are examples set by your clinician.</div></section>
      <section class={`card ${e.status === 'alert' ? 'flag' : ''}`}>
        <b>Next step</b><p>{e.nextStep}</p>
        {e.status === 'alert' && <p class="muted">Today’s values deviate from the plan, so a short note was sent to your clinician. This is not a diagnosis.</p>}
        {e.milestoneReached && <p class="win">You have reached the bend and straighten goals for this stage. Your clinician will check the rest and decide on the next stage.</p>}
      </section>
      <section class={`card ${r.sent.ok ? '' : 'flag'}`}>
        <b>{r.sent.ok ? 'Sent to your care team' : r.sent.reason === 'offline' || r.sent.reason === 'server_unavailable' ? 'Saved on this phone' : 'Not delivered'}</b>
        {r.sent.ok ? <p class="muted">Only today’s three numbers and any alert were sent, signed by this phone. Raw sensor readings stayed on the phone.</p>
          : r.sent.reason === 'offline' || r.sent.reason === 'server_unavailable' ? <p class="muted">No connection to your care team right now. Today’s result is saved and will be sent automatically when you are online.</p>
          : <p class="error">The clinic rejected this message ({r.sent.reason}). Nothing was changed on their side.</p>}
        <button class="btn link" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} exactly what was sent</button>
        {show && <pre class="payload">{JSON.stringify({ patient: r.payloadPreview && (r.payloadPreview as any).sub, seq: (r.payloadPreview as any).seq, leg: r.summary.leg, flexion: r.summary.flexion, extension: r.summary.extension, positions: [r.summary.extPosture, r.summary.flexPosture], pain: r.summary.pain, date: r.summary.date, alerts: e.alerts.map((a) => a.kind), note: 'no name, no raw sensor data' }, null, 1)}</pre>}
      </section>
      <button class="btn primary big" onClick={onHome}>Done</button>
      <span hidden>{p.pseudonym}</span>
    </>
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
