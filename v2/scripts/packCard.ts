// Preload for incidents.ts: the pack-racing scorecard (training/PACK-RACING.md, step 1). Under green, sound cars only
// (no pit cycle, not smoking), every LOOK steps:
//   runs     each pull-out (in line behind a car, within FOLLOW m and IN_LINE m across, then a lane over, OUT m, still
//            behind): the closing speed it built in the tow over the RUN_TIME s before, the closing at the pull-out,
//            and whether it passed that car (LEAD m ahead) within PASS_WINDOW s, by whether it had a run (RUN m/s)
//   held up  time following (in line behind within FOLLOW m, closing under HELD m/s): the better lane beside it (a lane
//            each side, SIDE_LO-SIDE_HI m across, on the road) was open (no car in it for LOOK_AHEAD m), moving faster
//            (its nearest car ahead faster than ours by FASTER m/s), moving no faster, or taken (a car beside us in it);
//            and of following time with a lane open or faster, the share the car moved over within TOOK_TIME s
//   pack     position changes a car-lap (pairs of sound cars swapping order by distance run), time with a car alongside,
//            time in a tow (draft factor under 0.97) and the mean drag cut there, damaging green car contacts a
//            hundred car-laps
// Prints PACK lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/packCard.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8sp-lines.json --tracks speedway --seeds 2 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const LOOK = 6; // steps between looks (0.05 s)
const FOLLOW = 30, IN_LINE = 2.5, OUT = 3.5, LEAD = 5;
const RUN_TIME = 3, RUN = 1, PASS_WINDOW = 10;
const HELD = 1, SIDE_LO = 2.5, SIDE_HI = 6, LOOK_AHEAD = 80, FASTER = 1, TOOK_TIME = 3, BESIDE = 8;

const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;
const along = (w: World, c: Car) => c.vx * w.track.tx[c.trackIdx] + c.vy * w.track.ty[c.trackIdx];

type Follow = { t: number; leader: Car; d: number; closing: Array<[number, number]> };
type Out = { car: Car; t: number; leader: Car; built: number; closing: number; passed: boolean; done: boolean };
const following = new Map<Car, Follow>();
const outs: Out[] = [];
const held = new Map<string, number>();
const chances: Array<{ car: Car; t: number; d: number; took: boolean; done: boolean }> = [];
let greenTime = 0, alongside = 0, towTime = 0, towCut = 0, carLaps = 0, swaps = 0, contacts = 0;
let order: Car[] = [];
const lastChance = new Map<Car, number>();

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const before = this.cars.map((c) => ({ impact: c.lastImpact, health: c.health }));
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { following.clear(); order = []; return; }
  const track = this.track, L = track.length, t = this.time;
  // Contacts every step (they're brief): a new car impact that cost health, counted once a pair.
  const seen = new Set<string>();
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (!eligible(c) || !imp || imp === before[k].impact || imp.kind !== 'car' || c.health >= before[k].health - 1e-6) return;
    const key = [c.id, imp.other].sort().join('-');
    if (!seen.has(key)) { seen.add(key); contacts++; }
  });
  if (Math.round(t / P.DT) % LOOK) return;
  const dt = LOOK * P.DT;
  const cars = this.cars.filter(eligible);
  const gap = (a: Car, b: Car) => { let ds = b.s - a.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L; return ds; };
  // Order by distance run: swaps between sound cars since the last look.
  const now = [...cars].sort((a, b) => b.dist - a.dist);
  if (order.length) {
    const was = new Map(order.map((c, i) => [c, i]));
    const kept = now.filter((c) => was.has(c));
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) if (was.get(kept[i])! > was.get(kept[j])!) swaps++;
  }
  order = now;
  for (const c of cars) {
    const v = along(this, c);
    greenTime += dt;
    carLaps += (Math.max(0, v) * dt) / L;
    if (c.draftFactor < 0.97) { towTime += dt; towCut += (1 - c.draftFactor) * dt; }
    let leader: Car | null = null, lead = Infinity;
    let side = false;
    for (const o of cars) {
      if (o === c) continue;
      const ds = gap(c, o), dd = Math.abs(o.d - c.d);
      if (Math.abs(ds) < 2 * P.CAR_RADIUS + 1 && dd > 1.5 && dd < 6) side = true;
      if (ds > 0 && ds < FOLLOW && dd < IN_LINE && ds < lead) { lead = ds; leader = o; }
    }
    if (side) alongside += dt;
    // Following and runs.
    const f = following.get(c);
    if (leader) {
      const closing = v - along(this, leader);
      const g = f && f.leader === leader ? f : { t, leader, d: c.d, closing: [] as Array<[number, number]> };
      g.closing.push([t, closing]);
      while (g.closing.length && t - g.closing[0][0] > RUN_TIME) g.closing.shift();
      g.d = c.d;
      following.set(c, g);
      if (closing < HELD) {
        // The better lane beside it, either side, on the road.
        let best = 'none';
        const rank = { none: 0, taken: 1, 'no faster': 2, faster: 3, open: 4 } as Record<string, number>;
        for (const sgn of [-1, 1]) {
          const lo = c.d + sgn * SIDE_LO, hi = c.d + sgn * SIDE_HI;
          const mid = (lo + hi) / 2;
          if (mid < track.outerEdgeAt(c.s) + P.CAR_RADIUS || mid > track.innerEdgeAt(c.s) - P.CAR_RADIUS) continue;
          let state = 'open', nearest = Infinity, speed = 0;
          for (const o of cars) {
            if (o === c) continue;
            const dd = sgn * (o.d - c.d);
            if (dd < SIDE_LO || dd > SIDE_HI) continue;
            const ds = gap(c, o);
            if (Math.abs(ds) < BESIDE) { state = 'taken'; break; }
            if (ds > 0 && ds < LOOK_AHEAD && ds < nearest) { nearest = ds; speed = along(this, o); }
          }
          if (state === 'open' && nearest < Infinity) state = speed > v + FASTER ? 'faster' : 'no faster';
          if (rank[state] > rank[best]) best = state;
        }
        held.set(best, (held.get(best) ?? 0) + dt);
        if ((best === 'open' || best === 'faster') && t - (lastChance.get(c) ?? -Infinity) > TOOK_TIME) {
          chances.push({ car: c, t, d: c.d, took: false, done: false });
          lastChance.set(c, t);
        }
      }
    } else if (f) {
      // Out of line: a pull-out once it's a lane over while still behind the car it followed (within 2 s of leaving).
      const ds = gap(c, f.leader), dd = Math.abs(f.leader.d - c.d);
      if (ds > 0 && ds < FOLLOW + 10 && dd > OUT && eligible(f.leader)) {
        const cl = f.closing.map((x) => x[1]);
        outs.push({ car: c, t, leader: f.leader, built: cl.length ? cl[cl.length - 1] - cl[0] : 0, closing: v - along(this, f.leader), passed: false, done: false });
        following.delete(c);
      } else if (ds <= 0 || ds > FOLLOW + 10 || t - f.closing[f.closing.length - 1][0] > 2) following.delete(c);
    }
  }
  // Pull-outs: passed the car they went for within the window?
  for (const o of outs) {
    if (o.done) continue;
    if (!eligible(o.car) || !eligible(o.leader) || t - o.t > PASS_WINDOW) { o.done = true; continue; }
    if (gap(o.leader, o.car) >= LEAD) { o.passed = true; o.done = true; }
  }
  for (const ch of chances) {
    if (ch.done) continue;
    if (Math.abs(ch.car.d - ch.d) >= OUT - 1) { ch.took = true; ch.done = true; }
    else if (t - ch.t > TOOK_TIME) ch.done = true;
  }
};
process.on('exit', () => {
  const pct = (x: number, n: number) => `${(100 * x / Math.max(1e-9, n)).toFixed(0)}%`;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const all = outs;
  const runs = all.filter((o) => o.closing >= RUN), flat = all.filter((o) => o.closing < RUN);
  console.log(`PACK runs: ${all.length} pull-outs, ${pct(runs.length, all.length)} with a run (closing ${RUN}+ m/s); closing built in the tow over ${RUN_TIME} s before ${mean(all.map((o) => o.built)).toFixed(2)} m/s, at the pull-out ${mean(all.map((o) => o.closing)).toFixed(2)} m/s`);
  console.log(`PACK   passed within ${PASS_WINDOW} s: with a run ${pct(runs.filter((o) => o.passed).length, runs.length)}, without ${pct(flat.filter((o) => o.passed).length, flat.length)}, all ${pct(all.filter((o) => o.passed).length, all.length)}`);
  const followTime = [...held.values()].reduce((a, b) => a + b, 0);
  console.log(`PACK held up (following, closing under ${HELD} m/s): ${(100 * followTime / Math.max(1e-9, greenTime)).toFixed(1)}% of green car-time; the better lane beside: `
    + ['open', 'faster', 'no faster', 'taken', 'none'].map((k) => `${k} ${pct(held.get(k) ?? 0, followTime)}`).join(', '));
  console.log(`PACK   lane open or faster: moved over within ${TOOK_TIME} s ${pct(chances.filter((c) => c.took).length, chances.length)} of ${chances.length} chances`);
  console.log(`PACK pack: ${(swaps / Math.max(1e-9, carLaps)).toFixed(3)} position changes a car-lap; alongside ${pct(alongside, greenTime)} of green car-time; in a tow ${pct(towTime, greenTime)} (drag cut there ${(100 * towCut / Math.max(1e-9, towTime)).toFixed(0)}%); damaging car contacts ${(100 * contacts / Math.max(1e-9, carLaps)).toFixed(1)} a 100 car-laps (${carLaps.toFixed(0)} green car-laps)`);
});
