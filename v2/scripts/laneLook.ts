// Preload for incidents.ts: what the lane view (spotter.ts laneView) shows under green, and what drivers do with it.
// Sound cars only (no pit cycle, not smoking), every LOOK steps:
//   held up    in line behind a car (the lane view's own lane, within FOLLOW m), closing under HELD m/s: the better lane
//              beside as the view shows it: empty, rolling (its nearest car ahead pulling away from us by ROLLING m/s or
//              more), level, or stacked (we'd catch it); the length of our line against that lane's; and a car behind
//              in that lane within PUSH m (one to go with us)
//   pull-outs  the car ahead in our lane moving across at PULLING m/s or more: did we follow it into its lane (OUT m
//              across, the same way) within WITH_TIME s?
//   field      share of green car-time two wide or more (a car in a lane beside within PAIR m)
// Prints LOOK lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3' npx tsx --import ./scripts/laneLook.ts scripts/incidents.ts \
//     teacher:public/drivers/stable-candidate-v8sp-lines.json --tracks speedway --seeds 4 --field 40 --rules 1
import { LANES, LANES_SIZE, laneView } from '../src/ai/spotter';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';

const LOOK = 6;
const FOLLOW = 30, HELD = 1, ROLLING = 1, PUSH = 15, PAIR = 10;
const PULLING = 1, OUT = 2.5, WITH_TIME = 2, COOLDOWN = 3;
const AHEAD_RANGE = 120, BEHIND_RANGE = 80, CLOSING_SCALE = 20, LINE_MAX = 5, ACROSS_SCALE = 3; // spotter.ts's

const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;
const view = new Float32Array(LANES_SIZE);
let n = 0, green = 0, twoWide = 0, held = 0;
const besideState = new Map<string, number>();
let longer = 0, shorter = 0, same = 0, pusher = 0;
type Pull = { car: Car; ahead: Car; t: number; d: number; aheadD: number; dir: number; went: boolean; left: boolean; done: boolean };
const pulls: Pull[] = [], all: Pull[] = [];
const lastPull = new Map<Car, number>();

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { pulls.length = 0; return; }
  if (n++ % LOOK) return;
  const dt = LOOK * P.DT, t = this.time;
  for (const c of this.cars) {
    if (!eligible(c)) continue;
    laneView(c, this, view);
    green += dt;
    const lowBeside = (1 - view[LANES.LOW_AHEAD_PROX]) * AHEAD_RANGE, lowBack = (1 - view[LANES.LOW_BEHIND_PROX]) * BEHIND_RANGE;
    const highBeside = (1 - view[LANES.HIGH_AHEAD_PROX]) * AHEAD_RANGE, highBack = (1 - view[LANES.HIGH_BEHIND_PROX]) * BEHIND_RANGE;
    if ((view[LANES.LOW_AHEAD_PROX] > 0 && lowBeside < PAIR) || (view[LANES.LOW_BEHIND_PROX] > 0 && lowBack < PAIR)
      || (view[LANES.HIGH_AHEAD_PROX] > 0 && highBeside < PAIR) || (view[LANES.HIGH_BEHIND_PROX] > 0 && highBack < PAIR)) twoWide += dt;
    // Held up: the car ahead in our own lane (the lane view's: within 2.5 m across).
    let ahead: Car | null = null, gap = Infinity;
    const L = this.track.length;
    for (const o of this.cars) {
      if (o === c || !eligible(o) || Math.abs(o.d - c.d) >= 2.5) continue;
      let ds = o.s - c.s;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (ds > 0 && ds < gap) { gap = ds; ahead = o; }
    }
    const along = (x: Car) => x.vx * this.track.tx[x.trackIdx] + x.vy * this.track.ty[x.trackIdx];
    if (ahead && gap < FOLLOW && along(c) - along(ahead) < HELD) {
      held += dt;
      // The better side as seen: empty beats rolling beats level beats stacked.
      const rank: Record<string, number> = { stacked: 0, level: 1, rolling: 2, empty: 3 };
      let best = 'stacked', bestK = 0;
      for (const k of [0, 1]) {
        const b = k === 0 ? LANES.LOW_AHEAD_PROX : LANES.HIGH_AHEAD_PROX;
        const closing = view[b + 1] * CLOSING_SCALE;
        const state = view[b] === 0 ? 'empty' : closing <= -ROLLING ? 'rolling' : closing < HELD ? 'level' : 'stacked';
        if (rank[state] > rank[best]) { best = state; bestK = k; }
      }
      besideState.set(best, (besideState.get(best) ?? 0) + dt);
      const b = bestK === 0 ? LANES.LOW_AHEAD_PROX : LANES.HIGH_AHEAD_PROX;
      const mine = Math.round(view[LANES.MY_LINE] * LINE_MAX), theirs = Math.round(view[b + 2] * LINE_MAX);
      if (mine > theirs) longer += dt; else if (mine < theirs) shorter += dt; else same += dt;
      if (view[b + 3] > 0 && (1 - view[b + 3]) * BEHIND_RANGE < PUSH) pusher += dt;
    }
    // The car ahead pulling out of our lane.
    const across = view[LANES.AHEAD_ACROSS] * ACROSS_SCALE;
    if (ahead && gap < FOLLOW && Math.abs(across) >= PULLING && t - (lastPull.get(c) ?? -Infinity) > COOLDOWN) {
      lastPull.set(c, t);
      const pull = { car: c, ahead, t, d: c.d, aheadD: ahead.d, dir: Math.sign(across), went: false, left: false, done: false };
      pulls.push(pull);
      all.push(pull);
    }
  }
  for (const p of pulls) {
    if (p.done) continue;
    if ((p.ahead.d - p.aheadD) * p.dir >= OUT) p.left = true;
    if ((p.car.d - p.d) * p.dir >= OUT) p.went = true;
    if (t - p.t > WITH_TIME || !eligible(p.car)) p.done = true;
  }
  while (pulls.length && pulls[0].done) pulls.shift();
};

process.on('exit', () => {
  const pct = (a: number, b: number) => `${(100 * a / Math.max(1e-9, b)).toFixed(0)}%`;
  console.log(`LOOK field: two wide or more ${pct(twoWide, green)} of green car-time; held up ${pct(held, green)}`);
  console.log(`LOOK held up, the better lane beside as the view shows it: ` + ['empty', 'rolling', 'level', 'stacked'].map((k) => `${k} ${pct(besideState.get(k) ?? 0, held)}`).join(', ')
    + `; our line longer than it ${pct(longer, held)}, the same ${pct(same, held)}, shorter ${pct(shorter, held)}; a car behind there within ${PUSH} m ${pct(pusher, held)}`);
  const left = all.filter((p) => p.left);
  console.log(`LOOK the car ahead moving out of its groove (${PULLING}+ m/s): ${all.length} times, ${left.length} of them a lane over (${OUT} m) within ${WITH_TIME} s; of those we went with it ${pct(left.filter((p) => p.went).length, left.length)} (of the rest, moved over anyway ${pct(all.filter((p) => !p.left && p.went).length, all.length - left.length)})`);
});
