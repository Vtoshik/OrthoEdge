// Dev tool: finds generator seeds (server/src/synthetic.ts) that give each demo patient the intended story. Run: npx tsx scripts/tune-demo-seeds.ts
import { readFileSync } from 'node:fs';
import { evaluate, localDateISO, type DailySummary, type Protocol } from '@tele/engine';
import { ARCHETYPES, simulate, type Archetype } from '../server/src/synthetic';
const proto: Protocol = { ...JSON.parse(readFileSync(new URL('../config/protocol.calgary-sample.json', import.meta.url), 'utf8')), surgeryDate: localDateISO(-16) };
const run = (a: Archetype) => {
  const days = simulate(a, 6, 15); const hist: DailySummary[] = [];
  return days.map((d) => { hist.push({ date: localDateISO(d.day - 16), flexion: d.flexion, extension: d.extension, pain: d.pain, leg: 'right' }); return { ...d, ev: evaluate(proto, hist, hist.at(-1)!) }; });
};
const ok: Record<string, (r: ReturnType<typeof run>) => boolean> = {
  'P-7F3A': (r) => r.every((x) => x.ev.status === 'on_track') && !r.at(-1)!.ev.milestoneReached,
  'P-B804': (r) => r.every((x) => x.ev.status === 'on_track') && r.at(-1)!.ev.milestoneReached,
  'P-2C91': (r) => r.slice(0, 7).every((x) => x.ev.status === 'on_track') && r.at(-1)!.ev.status === 'alert' && r.filter((x) => x.ev.status === 'alert').length <= 3,
};
for (const [id, a] of Object.entries(ARCHETYPES)) {
  const found: number[] = []; for (let s = 1; s <= 400 && found.length < 6; s++) if (ok[id](run({ ...a, seed: s }))) found.push(s);
  console.log(id, 'seeds that tell the intended story:', found.join(','));
}
console.log('--- candidates (post-op day 6..15): flexion / extension / pain');
for (const [id, seeds] of [['P-7F3A', [3, 4, 6]], ['P-2C91', [3, 5, 9]], ['P-B804', [4, 5, 8]]] as const) for (const s of seeds) {
  const r = run({ ...ARCHETYPES[id], seed: s }); console.log(id, 'seed', s, '\n  flex', r.map((x) => x.flexion).join(' '), '\n  ext ', r.map((x) => x.extension).join(' '), '\n  pain', r.map((x) => x.pain).join(' '), '\n  status', r.map((x) => (x.ev.status === 'alert' ? 'A' : '.')).join(' '));
}
