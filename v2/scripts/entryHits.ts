// Preload for incidents.ts: what a teacher following a car saw and did over the 3 s before it ran into the back of it
// (damaging nose-to-tail green contact, the follower a TrafficRacer). From the teacher's own last decision (its
// follow cap, the car setting it, the slowing it saw ahead for that car under ?follow=2, the slowing it insured
// against) against what happened: the gap and closing, how hard the car ahead really slowed, whether the follower was
// at or over its cap (couldn't get down to it) and its pedal. Per phase (straight, entry, mid, exit), and a few traces.
// Prints HIT lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=2' npx tsx --import ./scripts/entryHits.ts scripts/incidents.ts \
//     teacher:public/drivers/stable-candidate-v8sp-lines.json --tracks short --seeds 2 --field 40 --rules 1
import { twoLines } from '../src/ai/racingLine';
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const KEEP = 3; // s of history per car
const TRACES = 8;
const PHASES = ['straight', 'entry', 'mid', 'exit'] as const;
type Phase = (typeof PHASES)[number];
type Moment = { t: number; along: number; behind: Car | null; cap: number; slowing: number; lead: number; pedal: number; gap: number; leaderAlong: number };

const history = new WeakMap<Car, Moment[]>();
type Hit = {
  phase: Phase; capOnIt: boolean; gap2: number; gap1: number; closing2: number; closing1: number;
  seen2: number; lead2: number; leaderDecel: number; leaderPeak: number; over1: number; pedal1: number; trace: string[];
};
const hits: Hit[] = [];
let kmax = 0;

function phaseAt(world: World, s: number): Phase {
  const track = world.track;
  if (!kmax) for (let i = 0; i < track.kappa.length; i++) kmax = Math.max(kmax, Math.abs(track.kappa[i]));
  const now = Math.abs(track.curvatureAt(s)), ahead = Math.abs(track.curvatureAt(s + 25));
  if (now < 0.2 * kmax && ahead < 0.2 * kmax) return 'straight';
  if (ahead > now * 1.15 || now < 0.2 * kmax) return 'entry';
  if (ahead < now * 0.85) return 'exit';
  return 'mid';
}
function alongOf(world: World, c: Car): number {
  const i = c.trackIdx;
  return c.vx * world.track.tx[i] + c.vy * world.track.ty[i];
}
const gapTo = (world: World, c: Car, o: Car) => {
  const L = world.track.length;
  let ds = o.s - c.s;
  if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
  return ds - 2 * P.CAR_RADIUS;
};

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const green = (this.control?.flag ?? 'green') === 'green';
  const before = this.cars.map((c) => ({ health: c.health, retired: c.retired, impact: c.lastImpact }));
  step.call(this);
  if (!green || !twoLines(this.track)) return;
  this.cars.forEach((c, k) => {
    const last = (this.controllers[k] as any)?.driver?.last;
    if (!last || c.retired || c.pit.phase !== 'none' || compromise(c) > 0) return;
    const h = history.get(c) ?? [];
    const o: Car | null = last.behind ?? null;
    h.push({
      t: this.time, along: alongOf(this, c), behind: o, cap: last.follow, slowing: last.slowing ?? 0, lead: last.lead ?? 0,
      pedal: c.inputX, gap: o ? gapTo(this, c, o) : NaN, leaderAlong: o ? alongOf(this, o) : NaN,
    });
    while (h.length && h[0].t < this.time - KEEP) h.shift();
    history.set(c, h);
  });
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (before[k].retired || !imp || imp === before[k].impact || imp.kind !== 'car' || c.health >= before[k].health - 1e-6) return;
    const o = this.cars.find((x) => x.id === imp.other);
    if (!o) return;
    const gapNow = gapTo(this, c, o);
    if (Math.abs(o.d - c.d) > gapNow + 2 * P.CAR_RADIUS || gapNow + 2 * P.CAR_RADIUS <= 0) return; // nose to tail, c behind
    const h = history.get(c), ho = history.get(o);
    if (!h || !ho || !h.length) return;
    const at = (list: Moment[], ago: number) => list.find((m) => m.t >= this.time - ago) ?? list[list.length - 1];
    const m2 = at(h, 2), m1 = at(h, 1), o2 = at(ho, 2), o1 = at(ho, 1);
    const oNow = alongOf(this, o);
    let peak = 0;
    for (const m of ho) {
      const later = ho.find((x) => x.t >= m.t + 0.5);
      if (later && m.t >= this.time - 2) peak = Math.max(peak, (m.along - later.along) / (later.t - m.t));
    }
    const trace: string[] = [];
    for (const ago of [3, 2, 1.5, 1, 0.5, 0.1]) {
      const m = at(h, ago), mo = at(ho, ago);
      trace.push(`-${ago}s gap ${m.behind === o ? m.gap.toFixed(1) : '(' + (gapTo(this, c, o) + 0).toFixed(0) + ')'} v ${m.along.toFixed(1)} vo ${mo.along.toFixed(1)} cap ${Number.isFinite(m.cap) ? m.cap.toFixed(1) : 'inf'}${m.behind === o ? '' : '*'} saw ${m.slowing.toFixed(1)} ins ${m.lead.toFixed(1)} pedal ${m.pedal.toFixed(2)}`);
    }
    hits.push({
      phase: phaseAt(this, c.s), capOnIt: m1.behind === o,
      gap2: m2.behind === o ? m2.gap : NaN, gap1: m1.behind === o ? m1.gap : NaN,
      closing2: m2.along - o2.along, closing1: m1.along - o1.along,
      seen2: m2.behind === o ? m2.slowing : NaN, lead2: m2.behind === o ? m2.lead : NaN,
      leaderDecel: (o2.along - oNow) / Math.max(0.1, this.time - o2.t), leaderPeak: peak,
      over1: Number.isFinite(m1.cap) ? m1.along - m1.cap : NaN, pedal1: m1.pedal, trace,
    });
  });
};

process.on('exit', () => {
  const mean = (xs: number[]) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const f = (x: number, w = 7) => (Number.isFinite(x) ? x.toFixed(2) : '-').padStart(w);
  console.log(`HIT damaging nose-to-tail contacts, a teacher following: ${hits.length}`);
  console.log('HIT phase      n  capped on it 1 s out  gap 2 s / 1 s (m)  closing 2 s / 1 s  slowing seen 2 s out / insured  leader slowed (mean over 2 s / peak 0.5 s, m/s^2)  over its cap 1 s out (m/s)  pedal 1 s out');
  for (const p of PHASES) {
    const hs = hits.filter((h) => h.phase === p);
    if (!hs.length) continue;
    console.log(`HIT ${p.padEnd(9)} ${String(hs.length).padStart(3)}  ${(100 * hs.filter((h) => h.capOnIt).length / hs.length).toFixed(0).padStart(6)}%  `
      + `${f(mean(hs.map((h) => h.gap2)))} / ${f(mean(hs.map((h) => h.gap1)))}  ${f(mean(hs.map((h) => h.closing2)))} / ${f(mean(hs.map((h) => h.closing1)))}  `
      + `${f(mean(hs.map((h) => h.seen2)))} / ${f(mean(hs.map((h) => h.lead2)))}  ${f(mean(hs.map((h) => h.leaderDecel)))} / ${f(mean(hs.map((h) => h.leaderPeak)))}  `
      + `${f(mean(hs.map((h) => h.over1)))}  ${f(mean(hs.map((h) => h.pedal1)))}`);
  }
  for (const h of hits.filter((x) => x.phase === 'entry').slice(0, TRACES)) {
    console.log(`HIT trace (entry): ${h.trace.join(' | ')}`);
  }
});
