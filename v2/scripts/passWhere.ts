// Preload for incidents.ts: where on the lap position changes happen, and how close followers run there. Under green,
// sound cars only (no pit cycle, not smoking), every LOOK steps, by the phase of the lap (straight, entry, mid, exit,
// as scripts/entryHits.ts):
//   swaps    position changes (pairs of sound cars swapping order by distance run), placed where the car that went
//            ahead is, and how many were made on the inside (it lower than the car it passed) or outside
//   follow   time in line behind a car (within FOLLOW m, IN_LINE m across): its share of green car-time there, and the
//            gap (nose to tail) in bands
//   tries    pass attempts a teacher starts (TrafficRacer.last.passing turning on), and of those, a swap with the car
//            it went for within PASS_WINDOW s
// Prints WHERE lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3' npx tsx --import ./scripts/passWhere.ts scripts/incidents.ts \
//     teacher:public/drivers/stable-candidate-v8sp-lines.json --tracks short --seeds 4 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const LOOK = 6;
const FOLLOW = 30, IN_LINE = 2.5, PASS_WINDOW = 10;
const BANDS = [3, 6, 10, 20, FOLLOW];
const PHASES = ['straight', 'entry', 'mid', 'exit'] as const;
type Phase = (typeof PHASES)[number];

const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;
const zero = () => Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
const swaps = zero(), inside = zero(), time = zero(), followTime = zero(), tries = zero(), made = zero();
const bands = Object.fromEntries(PHASES.map((p) => [p, BANDS.map(() => 0)])) as Record<Phase, number[]>;
let order: Car[] = [];
let kmax = 0, n = 0;
const wasPassing = new Map<Car, boolean>();
const open: Array<{ car: Car; on: Car; t: number; phase: Phase; done: boolean }> = [];

function phaseAt(world: World, s: number): Phase {
  const track = world.track;
  if (!kmax) for (let i = 0; i < track.kappa.length; i++) kmax = Math.max(kmax, Math.abs(track.kappa[i]));
  const now = Math.abs(track.curvatureAt(s)), ahead = Math.abs(track.curvatureAt(s + 25));
  if (now < 0.2 * kmax && ahead < 0.2 * kmax) return 'straight';
  if (ahead > now * 1.15 || now < 0.2 * kmax) return 'entry';
  if (ahead < now * 0.85) return 'exit';
  return 'mid';
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { order = []; open.length = 0; wasPassing.clear(); return; }
  if (n++ % LOOK) return;
  const L = this.track.length, dt = LOOK * P.DT;
  const cars = this.cars.filter(eligible);

  const now = [...cars].sort((a, b) => b.dist - a.dist);
  if (order.length) {
    const was = new Map(order.map((c, i) => [c, i]));
    const kept = now.filter((c) => was.has(c));
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i], b = kept[j]; // a now ahead of b
      if (was.get(a)! <= was.get(b)!) continue;
      const p = phaseAt(this, a.s);
      swaps[p]++;
      if (a.d < b.d) inside[p]++;
      for (const o of open) if (!o.done && o.car === a && o.on === b) { o.done = true; made[o.phase]++; }
    }
  }
  order = now;
  for (const o of open) if (!o.done && this.time - o.t > PASS_WINDOW) o.done = true;
  while (open.length && open[0].done) open.shift();
  for (const c of cars) {
    const p = phaseAt(this, c.s);
    time[p] += dt;
    let gap = Infinity;
    for (const o of cars) {
      if (o === c || Math.abs(o.d - c.d) > IN_LINE) continue;
      let ds = o.s - c.s;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (ds > 0 && ds < FOLLOW + 2 * P.CAR_RADIUS) gap = Math.min(gap, ds - 2 * P.CAR_RADIUS);
    }
    if (gap < Infinity) {
      followTime[p] += dt;
      const b = BANDS.findIndex((x) => gap < x);
      bands[p][b < 0 ? BANDS.length - 1 : b] += dt;
    }
    const k = this.cars.indexOf(c);
    const driver = (this.controllers[k] as any)?.driver;
    const passing = !!driver?.last?.passing;
    if (passing && !wasPassing.get(c) && driver.passOn) {
      tries[p]++;
      open.push({ car: c, on: driver.passOn, t: this.time, phase: p, done: false });
    }
    wasPassing.set(c, passing);
  }
};

process.on('exit', () => {
  const total = PHASES.reduce((a, p) => a + swaps[p], 0);
  const pct = (a: number, b: number) => `${(100 * a / Math.max(1e-9, b)).toFixed(0)}%`.padStart(5);
  console.log(`WHERE position changes: ${total}; tries are pass attempts started (passed within ${PASS_WINDOW} s); gap bands m: <${BANDS.join(', <')}`);
  console.log('WHERE phase     swaps (inside)   tries  passed   following  gap bands (share of following time)');
  for (const p of PHASES) {
    const f = followTime[p];
    console.log(`WHERE ${p.padEnd(9)} ${String(swaps[p]).padStart(5)} (${pct(inside[p], swaps[p])})  ${String(tries[p]).padStart(6)}  ${pct(made[p], tries[p])}     ${pct(f, time[p])}    ${bands[p].map((x) => pct(x, f)).join(' ')}`);
  }
});
