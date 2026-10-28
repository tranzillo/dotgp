// Preload: green-flag wall hits in races, in context. For each car on track under green, each step: its tyres, how
// close the car ahead in its lane is, whether a car is alongside (and on which side), whether it's in a tow; the time
// spent in each state and the wall hits (a run of steps touching) and health lost there, so a state's rate is per
// car-minute in it. Tells line drift (hits alone, on old tyres) from traffic (hits behind or beside another car).
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/wallHits.ts scripts/incidents.ts \
//     lab/cup-retrain/v6.json --tracks oval:894715320:short --seeds 2 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';

type Tally = { time: number; hits: number; lost: number };
const tallies = new Map<string, Map<string, Tally>>();
const tally = (dim: string, state: string) => {
  const m = tallies.get(dim) ?? new Map<string, Tally>();
  tallies.set(dim, m);
  const t = m.get(state) ?? { time: 0, hits: 0, lost: 0 };
  m.set(state, t);
  return t;
};
const touching = new WeakMap<object, boolean>();
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const ctl = this.control;
  const before = this.cars.map((c) => c.health);
  step.call(this);
  if (!ctl || ctl.flag !== 'green') return;
  const L = this.track.length, cars = this.cars;
  cars.forEach((c, k) => {
    if (c.retired || c.pit.phase !== 'none') return;
    let ahead = Infinity, side = 'clear';
    for (const o of cars) {
      if (o === c || o.retired || o.pit.phase !== 'none') continue;
      let ds = o.s - c.s;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      const dd = o.d - c.d;
      if (Math.abs(ds) < 2 * P.CAR_RADIUS + 2 && Math.abs(dd) < 6) side = (Math.sign(dd) === Math.sign(this.track.innerEdgeAt(c.s) - c.d)) ? 'car inside' : 'car outside';
      else if (ds > 0 && Math.abs(dd) < 3) ahead = Math.min(ahead, ds);
    }
    const states: Record<string, string> = {
      tyres: c.tireLife > 0.8 ? 'over 80%' : c.tireLife > 0.6 ? '60-80%' : c.tireLife > 0.4 ? '40-60%' : 'under 40%',
      'car ahead in lane': ahead < 10 ? 'under 10 m' : ahead < 25 ? '10-25 m' : ahead < 60 ? '25-60 m' : 'none in 60 m',
      alongside: side,
      tow: c.draftFactor < 0.97 ? 'in a tow' : 'clean air',
    };
    const lost = before[k] - c.health;
    const wall = lost > 1e-4 && c.lastImpact?.kind === 'wall';
    const fresh = wall && !touching.get(c);
    touching.set(c, wall);
    for (const [dim, state] of Object.entries(states)) {
      const t = tally(dim, state);
      t.time += P.DT;
      if (wall) t.lost += lost;
      if (fresh) t.hits++;
    }
  });
};
process.on('exit', () => {
  for (const [dim, m] of tallies) {
    console.error(`WALL by ${dim} (car-minutes; hits per car-minute; health lost per car-hour):`);
    for (const [state, t] of [...m].sort()) {
      const min = t.time / 60;
      console.error(`WALL   ${state.padEnd(14)} ${min.toFixed(0).padStart(6)}  ${(t.hits / min).toFixed(3).padStart(6)}  ${(t.lost / (min / 60)).toFixed(2).padStart(6)}`);
    }
  }
});
