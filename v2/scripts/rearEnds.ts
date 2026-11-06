// Preload for incidents.ts: green nose-to-tail contacts on an oval raced in two lines, from the following car's side.
// For each damaging contact where one car runs into the back of another: where in the lap (straight, corner entry,
// mid-corner, exit), how long the follower had been behind that car (within FOLLOW_RANGE, in its lane), how much
// faster it was coming (closing along) and whether the leader was slowing, its lane plan over the last seconds (its
// tactics' for a student, its pass side for a teacher), the two cars' lines, and whether the other line beside the
// leader was open. And over all green following (behind a car within FOLLOW_RANGE in its lane, closing): how often the
// follower had a plan to go by, by phase. Prints REAR lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/rearEnds.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8s-lines.json --tracks short --seeds 2 --field 40 --rules 1
//   (TEACHER_HANDS=1 ... teacher:<bundle>: its teachers through their students' hands)
import { whichLine, twoLines } from '../src/ai/racingLine';
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const FOLLOW_RANGE = 30; // m, bumper gap counted as following
const SAME_LANE = 3.5; // m across, as the spotter's "in our lane"
const KEEP = 4; // s of history per car
const PHASES = ['straight', 'entry', 'mid', 'exit'] as const;
type Phase = (typeof PHASES)[number];
type Moment = { t: number; plan: number; along: number; behind: number | null };

const history = new WeakMap<Car, Moment[]>();
/** Since when each car has been behind its current leader (that leader's id). */
const stuck = new WeakMap<Car, { on: number; since: number }>();
const hits: Array<{ phase: Phase; stuckFor: number; closing: number; leaderSlowing: number; planned: number; planToward: number; sameLine: boolean; open: boolean; followerBrake: number }> = [];
const follow = new Map<Phase, { n: number; planned: number }>(PHASES.map((p) => [p, { n: 0, planned: 0 }]));
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
const planOf = (ctrl: any): number => Number(ctrl?.driver?.intent ?? 0);
function alongOf(world: World, c: Car): number {
  const i = c.trackIdx;
  return c.vx * world.track.tx[i] + c.vy * world.track.ty[i];
}
/** The car ahead in c's lane within FOLLOW_RANGE (bumper gap), and the gap along. */
function leaderOf(world: World, c: Car): { o: Car; ds: number } | null {
  const L = world.track.length, gap = 2 * P.CAR_RADIUS;
  let best: { o: Car; ds: number } | null = null;
  for (const o of world.cars) {
    if (o === c || o.retired || o.pit.phase !== 'none') continue;
    let ds = o.s - c.s;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    if (ds <= 0 || ds - gap > FOLLOW_RANGE || Math.abs(o.d - c.d) > SAME_LANE) continue;
    if (!best || ds < best.ds) best = { o, ds };
  }
  return best;
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const green = (this.control?.flag ?? 'green') === 'green';
  const before = this.cars.map((c) => ({ health: c.health, retired: c.retired, impact: c.lastImpact }));
  step.call(this);
  if (!green || !twoLines(this.track)) return;
  const L = this.track.length;
  this.cars.forEach((c, k) => {
    if (c.retired || c.pit.phase !== 'none' || compromise(c) > 0) return;
    const ctrl = this.controllers[k] as any;
    const lead = leaderOf(this, c);
    const along = alongOf(this, c);
    const h = history.get(c) ?? [];
    h.push({ t: this.time, plan: planOf(ctrl), along, behind: lead ? lead.o.id : null });
    while (h.length && h[0].t < this.time - KEEP) h.shift();
    history.set(c, h);
    if (lead) {
      const st = stuck.get(c);
      if (!st || st.on !== lead.o.id) stuck.set(c, { on: lead.o.id, since: this.time });
      if (along - alongOf(this, lead.o) > 0) {
        const f = follow.get(phaseAt(this, c.s))!;
        f.n++;
        if (planOf(ctrl) !== 0) f.planned++;
      }
    } else stuck.delete(c);
  });
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (before[k].retired || !imp || imp === before[k].impact || imp.kind !== 'car' || c.health >= before[k].health - 1e-6) return;
    const o = this.cars.find((x) => x.id === imp.other);
    if (!o) return;
    let ds = o.s - c.s;
    if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    const dd = o.d - c.d;
    // Nose to tail, c the follower (the leader's own record of the same contact is skipped).
    if (Math.abs(dd) > Math.abs(ds) || ds <= 0) return;
    const h = history.get(c) ?? [], ho = history.get(o) ?? [];
    const at = (list: Moment[], ago: number) => list.find((m) => m.t >= this.time - ago) ?? list[list.length - 1];
    const st = stuck.get(c);
    const recent = h.filter((m) => m.t >= this.time - 2);
    const planned = recent.filter((m) => m.plan !== 0).length / Math.max(1, recent.length);
    // Its plan toward the side of the leader it would go by on: any plan at all counts; toward = moving off the leader.
    const sideOfOpen = whichLine(this.track, 0.6, o.s, o.d) === 'low' ? 'high' : 'low';
    const planToward = recent.filter((m) => m.plan !== 0 && whichLine(this.track, 0.6, o.s, o.d, m.plan) === sideOfOpen).length / Math.max(1, recent.length);
    // The other line beside the leader: no car within 10 m along of the leader on it.
    const open = !this.cars.some((x) => {
      if (x === o || x === c || x.retired || x.pit.phase !== 'none') return false;
      let dx = x.s - o.s;
      if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
      return Math.abs(dx) < 10 && whichLine(this.track, 0.6, x.s, x.d) === sideOfOpen;
    });
    const c1 = at(h, 1), o1 = at(ho, 1);
    hits.push({
      phase: phaseAt(this, c.s),
      stuckFor: st && st.on === o.id ? this.time - st.since : 0,
      closing: c1 && o1 ? c1.along - o1.along : NaN,
      leaderSlowing: o1 ? o1.along - alongOf(this, o) : NaN,
      planned, planToward,
      sameLine: whichLine(this.track, 0.6, c.s, c.d) === whichLine(this.track, 0.6, o.s, o.d),
      open,
      followerBrake: c1 ? c1.along - alongOf(this, c) : NaN,
    });
  });
};

process.on('exit', () => {
  const mean = (xs: number[]) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  console.log(`REAR nose-to-tail damaging contacts (the follower's side): ${hits.length}`);
  console.log('REAR phase      n   behind it (s)  closing 1 s out  leader slowed / follower slowed in that 1 s (m/s)  same line  other line open  plan to go by  ...on the open side');
  for (const p of PHASES) {
    const hs = hits.filter((h) => h.phase === p);
    if (!hs.length) continue;
    console.log(`REAR ${p.padEnd(9)} ${String(hs.length).padStart(4)}  ${mean(hs.map((h) => h.stuckFor)).toFixed(1).padStart(8)}  ${mean(hs.map((h) => h.closing)).toFixed(2).padStart(10)}  `
      + `${mean(hs.map((h) => h.leaderSlowing)).toFixed(2).padStart(10)} / ${mean(hs.map((h) => h.followerBrake)).toFixed(2).padEnd(26)} ${pct(hs.filter((h) => h.sameLine).length / hs.length).padStart(6)}  `
      + `${pct(hs.filter((h) => h.open).length / hs.length).padStart(10)}  ${pct(mean(hs.map((h) => h.planned))).padStart(10)}  ${pct(mean(hs.map((h) => h.planToward))).padStart(10)}`);
  }
  const long = hits.filter((h) => h.stuckFor >= 3);
  console.log(`REAR behind the same car 3 s or more: ${long.length} of ${hits.length}; of them other line open ${pct(long.filter((h) => h.open).length / Math.max(1, long.length))}, a plan to go by ${pct(mean(long.map((h) => h.planned)))}`);
  console.log(`REAR all green following (closing on a car within ${FOLLOW_RANGE} m in its lane): share of moments with a plan to go by, by phase: `
    + PHASES.map((p) => { const f = follow.get(p)!; return `${p} ${pct(f.planned / Math.max(1, f.n))} (${f.n})`; }).join(', '));
});
