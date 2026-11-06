// Preload for incidents.ts: cars stopped (under 3 m/s) on track under caution, not retired, not on pit road. How many
// car-seconds, smoking or sound, on the apron or the track, how far behind the car ahead in line, and how long each stop lasts.
// Prints a STALLS line at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/cautionStalls.ts scripts/incidents.ts \n//     public/drivers/stable-candidate-v8-lines.json --tracks flat --seeds 2 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const since = new Map<Car, number>();
const spans: number[] = [];
let carSec = 0, cautionCarSec = 0, smokingSec = 0, apronSec = 0, retiredAfter = 0;
const gaps: number[] = [];
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const ctl = this.control;
  if (!ctl) return;
  const caution = ctl.flag === 'caution' && ctl.pickedUp;
  for (const c of this.cars) {
    const running = !c.retired && !c.cleared && c.pit.phase === 'none';
    if (caution && running) cautionCarSec += P.DT;
    const stopped = caution && running && c.speed < 3;
    if (stopped) {
      carSec += P.DT;
      if (compromise(c) > 0) smokingSec += P.DT;
      if (this.track.surfaceAt(c.s, c.d, c.x, c.y) === 'apron') apronSec += P.DT;
      if (!since.has(c)) {
        since.set(c, this.time);
        let best = Infinity;
        for (const o of this.cars) if (o !== c && !o.retired && !o.cleared) { const ds = this.track.distanceFrom(c.s, o.s); if (ds > 0 && ds < best) best = ds; }
        gaps.push(best);
      }
    } else if (since.has(c)) {
      spans.push(this.time - since.get(c)!);
      since.delete(c);
      if (c.retired) retiredAfter++;
    }
  }
};
process.on('exit', () => {
  const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  console.log(`STALLS under caution (picked up): ${carSec.toFixed(0)} car-s stopped of ${cautionCarSec.toFixed(0)} running (${(100 * carSec / cautionCarSec).toFixed(1)}%), smoking ${smokingSec.toFixed(0)} s, on the apron ${apronSec.toFixed(0)} s; ${spans.length} stops, median ${med(spans).toFixed(1)} s, p90 ${spans.length ? spans.slice().sort((a, b) => a - b)[Math.floor(spans.length * 0.9)].toFixed(1) : '-'} s; gap to the car ahead at the stop median ${med(gaps).toFixed(0)} m; ended retired ${retiredAfter}`);
});
