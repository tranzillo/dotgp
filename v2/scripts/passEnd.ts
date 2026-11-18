// Preload for incidents.ts: how a teacher's pass attempts end. Under green, every step, for sound cars:
//   an attempt runs from TrafficRacer.last.passing turning on to it turning off, or to it going for another car
//   (switched). At its end, what the teacher's decision made of the pass (TrafficRacer.passWhy, diagnostics only):
//     past / alongside / out of reach / out of path   where that car was (out of path: no longer in this car's way)
//     too slow            its edge on that car under PASS_HOLD
//     no side (full)      its edge over its passing margin, so judged as a new pass: no side beats it all the way past
//     no side (holding)   held on PASS_HOLD over PASS_HOLD_LOOK s, and no side does even that
//     ..., not beside / not gaining / its lane slow or out of reach   out of its way, and the pass not carried on
//   Its length, how far across it got (the passing side, from where it started), and whether that car went for any
//   car (or the same one) again within AGAIN s.
// Prints END lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3&draft=2&wake=1' npx tsx --import ./scripts/passEnd.ts \
//     scripts/incidents.ts teacher:public/drivers/stable-candidate-v8sp-lines.json --tracks speedway --seeds 4 --field 40 --rules 1
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const AGAIN = 3, LANE = 2.5;
const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;

type Try = { on: Car; t: number; startD: number; side: number; across: number };
const open = new Map<Car, Try>();
const lastEnd = new Map<Car, { on: Car; t: number }>();
const ends = new Map<string, number>();
const durs: number[] = [];
let tries = 0, again = 0, againAny = 0, lane = 0, shortTries = 0;
const shortEnds = new Map<string, number>();
// Switches: the new car further on than the old, the same side, the car before the old one (a cycle).
let switches = 0, further = 0, sameSide = 0, cycle = 0;
const before = new Map<Car, Car>();

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { open.clear(); return; }
  for (let k = 0; k < this.cars.length; k++) {
    const c = this.cars[k];
    const driver = (this.controllers[k] as any)?.driver;
    if (!driver?.last) continue;
    const passing = !!driver.last.passing && eligible(c);
    const cur = open.get(c);
    if (passing && driver.passOn) {
      const on: Car = driver.passOn;
      if (!cur || cur.on !== on) {
        if (cur) {
          switches++;
          const L = this.track.length;
          let ds = on.s - cur.on.s;
          if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
          if (ds > 0) further++;
          if (driver.passSide === cur.side) sameSide++;
          if (before.get(c) === on) cycle++;
          before.set(c, cur.on);
          finish(c, cur, this.time, 'switched');
        }
        tries++;
        const prev = lastEnd.get(c);
        if (prev && this.time - prev.t < AGAIN) { againAny++; if (prev.on === on) again++; }
        open.set(c, { on, t: this.time, startD: c.d, side: driver.passSide, across: 0 });
      } else {
        cur.side = driver.passSide || cur.side;
        cur.across = Math.max(cur.across, cur.side * (c.d - cur.startD));
      }
    } else if (cur) {
      finish(c, cur, this.time, eligible(c) ? driver.passWhy || '?' : 'own car');
    }
  }
};

function finish(c: Car, x: Try, t: number, why: string) {
  open.delete(c);
  const on = x.on;
  if (why !== 'switched' && !eligible(on)) why = 'gone';
  ends.set(why, (ends.get(why) ?? 0) + 1);
  const dur = t - x.t;
  durs.push(dur);
  if (x.across >= LANE) lane++;
  if (dur < 1) { shortTries++; shortEnds.set(why, (shortEnds.get(why) ?? 0) + 1); }
  lastEnd.set(c, { on, t });
}

process.on('exit', () => {
  const pct = (a: number, b: number) => `${(100 * a / Math.max(1e-9, b)).toFixed(0)}%`;
  durs.sort((a, b) => a - b);
  const q = (f: number) => (durs[Math.floor(f * (durs.length - 1))] ?? 0).toFixed(1);
  const n = durs.length;
  const order = [...ends.keys()].sort((a, b) => (ends.get(b) ?? 0) - (ends.get(a) ?? 0));
  console.log(`END attempts ${tries}: length s median ${q(0.5)} (quartiles ${q(0.25)}-${q(0.75)}); a lane across ${pct(lane, n)}; went again within ${AGAIN} s ${pct(againAny, tries)} (on the same car ${pct(again, tries)})`);
  console.log(`END switches ${switches}: to a car further on ${pct(further, switches)}, the same side ${pct(sameSide, switches)}, back to the car before ${pct(cycle, switches)}`);
  console.log(`END ended: ${order.map((w) => `${w} ${pct(ends.get(w) ?? 0, n)}`).join(', ')}`);
  console.log(`END under 1 s (${pct(shortTries, n)} of them): ${order.map((w) => `${w} ${pct(shortEnds.get(w) ?? 0, shortTries)}`).join(', ')}`);
});
