// Preload for incidents.ts: held up behind a car with a lane beside it open, what did going for the other lane win
// against staying in line? Under green, sound cars only (no pit cycle, not smoking), every LOOK steps. A chance is as
// packCard.ts's (in line behind a car within FOLLOW m, IN_LINE m across, closing under HELD m/s, a lane SIDE_LO-SIDE_HI m
// across on the road with no car beside it, and none ahead in it within LOOK_AHEAD m or the nearest faster by FASTER
// m/s), at most one a car every COOLDOWN s. It went if it moved OUT m across within TOOK_TIME s. Then over HORIZON s:
// the metres it gained on the car it was behind, the places it gained among sound cars (by distance run), and whether
// it passed that car. By how slow that car was: its mean speed over its last lap (the last track length it ran, so
// where on the lap it is doesn't count) against the field's median (the gap a driver would have to estimate; nothing
// here judges it).
// Prints LANE lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3' npx tsx --import ./scripts/laneGamble.ts scripts/incidents.ts \
//     teacher:public/drivers/stable-candidate-v8sp-lines.json --tracks short --seeds 4 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const LOOK = 6;
const FOLLOW = 30, IN_LINE = 2.5, OUT = 3.5, HELD = 1;
const SIDE_LO = 2.5, SIDE_HI = 6, LOOK_AHEAD = 80, FASTER = 1, BESIDE = 8;
const TOOK_TIME = 3, COOLDOWN = 5, HORIZON = 15;
const BINS = [0.5, 1.5, 3, Infinity]; // m/s the car ahead was under the field's median pace

const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;
const along = (w: World, c: Car) => c.vx * w.track.tx[c.trackIdx] + c.vy * w.track.ty[c.trackIdx];

type Chance = {
  car: Car; leader: Car; t: number; d: number; slow: number; went: boolean;
  gap0: number; rank0: number; done: boolean;
};
type Result = { slow: number; went: boolean; gained: number; places: number; passed: boolean };
const chances: Chance[] = [];
const results: Result[] = [];
const history = new Map<Car, Array<[number, number]>>();
const lastChance = new Map<Car, number>();
let n = 0;

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { chances.length = 0; history.clear(); return; }
  if (n++ % LOOK) return;
  const track = this.track, L = track.length, t = this.time;
  const cars = this.cars.filter(eligible);
  const gap = (a: Car, b: Car) => { let ds = b.s - a.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L; return ds; };
  const ranked = [...cars].sort((a, b) => b.dist - a.dist);
  const rank = new Map(ranked.map((c, i) => [c, i]));
  // Each car's mean speed over its last lap (distance run), and the field's median.
  const pace = new Map<Car, number>();
  for (const c of cars) {
    const h = history.get(c) ?? [];
    h.push([t, c.dist]);
    while (h.length > 1 && h[1][1] <= c.dist - L) h.shift();
    history.set(c, h);
    if (c.dist - h[0][1] >= L * 0.98) pace.set(c, (c.dist - h[0][1]) / (t - h[0][0]));
  }
  const paces = [...pace.values()].sort((a, b) => a - b);
  const median = paces.length ? paces[Math.floor(paces.length / 2)] : NaN;

  for (const c of cars) {
    if (!(this.controllers[this.cars.indexOf(c)] as any)?.driver?.last) continue; // a teacher
    if (t - (lastChance.get(c) ?? -Infinity) < COOLDOWN) continue;
    const v = along(this, c);
    let leader: Car | null = null, lead = Infinity;
    for (const o of cars) {
      if (o === c) continue;
      const ds = gap(c, o);
      if (ds > 0 && ds < FOLLOW && Math.abs(o.d - c.d) < IN_LINE && ds < lead) { lead = ds; leader = o; }
    }
    if (!leader || v - along(this, leader) >= HELD || !pace.has(leader) || !Number.isFinite(median)) continue;
    let open = false;
    for (const sgn of [-1, 1]) {
      const mid = c.d + sgn * (SIDE_LO + SIDE_HI) / 2;
      if (mid < track.outerEdgeAt(c.s) + P.CAR_RADIUS || mid > track.innerEdgeAt(c.s) - P.CAR_RADIUS) continue;
      let ok = true, nearest = Infinity, speed = 0;
      for (const o of cars) {
        if (o === c) continue;
        const dd = sgn * (o.d - c.d);
        if (dd < SIDE_LO || dd > SIDE_HI) continue;
        const ds = gap(c, o);
        if (Math.abs(ds) < BESIDE) { ok = false; break; }
        if (ds > 0 && ds < LOOK_AHEAD && ds < nearest) { nearest = ds; speed = along(this, o); }
      }
      if (ok && (nearest === Infinity || speed > v + FASTER)) open = true;
    }
    if (!open) continue;
    lastChance.set(c, t);
    chances.push({
      car: c, leader, t, d: c.d, slow: median - pace.get(leader)!, went: false,
      gap0: leader.dist - c.dist, rank0: rank.get(c)!, done: false,
    });
  }

  for (const ch of chances) {
    if (ch.done) continue;
    if (!eligible(ch.car) || !eligible(ch.leader)) { ch.done = true; continue; }
    if (t - ch.t <= TOOK_TIME && Math.abs(ch.car.d - ch.d) >= OUT) ch.went = true;
    if (t - ch.t >= HORIZON) {
      ch.done = true;
      results.push({
        slow: ch.slow, went: ch.went, gained: ch.gap0 - (ch.leader.dist - ch.car.dist),
        places: ch.rank0 - rank.get(ch.car)!, passed: ch.car.dist > ch.leader.dist,
      });
    }
  }
  while (chances.length && chances[0].done) chances.shift();
};

process.on('exit', () => {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const f = (x: number, w = 7) => (Number.isFinite(x) ? x.toFixed(2) : '-').padStart(w);
  const pct = (a: number, b: number) => `${b ? (100 * a / b).toFixed(0) : '-'}%`.padStart(5);
  console.log(`LANE held up with a lane open: ${results.length} chances (teachers), over ${HORIZON} s after; car ahead slower than the field's median pace over its last lap`);
  console.log('LANE slower by (m/s)   n   went | stayed: m gained on it, places gained, passed it | went: m gained, places, passed');
  let lo = -Infinity;
  for (const hi of BINS) {
    const rs = results.filter((r) => r.slow >= lo && r.slow < hi);
    const went = rs.filter((r) => r.went), stayed = rs.filter((r) => !r.went);
    const side = (xs: Result[]) => `${f(mean(xs.map((r) => r.gained)))} ${f(mean(xs.map((r) => r.places)))} ${pct(xs.filter((r) => r.passed).length, xs.length)}`;
    const label = `${lo === -Infinity ? 'under' : lo.toFixed(1)}${hi === Infinity ? '+' : '-' + hi.toFixed(1)}`;
    console.log(`LANE ${label.padEnd(14)} ${String(rs.length).padStart(5)} ${pct(went.length, rs.length)} | ${side(stayed)} | ${side(went)}`);
    lo = hi;
  }
});
