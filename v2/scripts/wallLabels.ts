// Preload: what a student does at the wall, and what a teacher would have done from there (the label DAgger trains
// it on). Each green decision of each neural driver, its teacher (a TrafficRacer, as the apprenticeship's, taking over
// from where the car is) answers too; tallied by how far the car is from the outside wall and whether it's turning.
// Tells a student that doesn't learn its label (the teacher lifts, the student doesn't) from a teacher that rides too.
// (The teacher's style is drawn for the car, not its own student's: the probe's question is what any teacher does.)
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/wallLabels.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v6.json --tracks speedway --seeds 1 --field 40 --rules 1
import { NeuralDriver } from '../src/ai/drivers';
import { TrafficRacer } from '../src/ai/trafficRacer';
import type { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { teacherOf } from '../src/school/ovalApprentice';

type Tally = { n: number; sx: number; tx: number; dy: number; lift: number; v: number };
const tallies = new Map<string, Tally>();
const teachers = new WeakMap<Car, TrafficRacer>();
const decide = NeuralDriver.prototype.decide;
NeuralDriver.prototype.decide = function (this: NeuralDriver, car, world, radio, pit, caution) {
  decide.call(this, car, world, radio, pit, caution);
  if (world.control?.flag !== 'green' || car.pit.phase !== 'none' || car.retired) return;
  const outer = world.track.walls.find((w) => w.faces === 'in' && w.range === null);
  if (!outer) return;
  let t = teachers.get(car);
  if (!t) {
    const { style, traits } = teacherOf({ lineage: car.id, nerve: 0.5, talent: 0.5 });
    t = new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
    teachers.set(car, t);
  }
  const sx = car.inputX, sy = car.inputY;
  t.takeOver(car, world);
  t.decide(car, world);
  const tx = car.inputX, ty = car.inputY;
  car.inputX = sx;
  car.inputY = sy;
  const gap = car.d - P.CAR_RADIUS - (world.track.edgeAt(outer.d as never, car.s) + outer.thickness / 2);
  const turning = Math.abs(world.track.kappa[world.track.indexAt(car.s)]) > 1e-4;
  const key = `${gap < 0.3 ? 'riding' : gap < 1 ? '0.3-1 m' : 'off'} ${turning ? 'corner' : 'straight'}`;
  const x = tallies.get(key) ?? { n: 0, sx: 0, tx: 0, dy: 0, lift: 0, v: 0 };
  tallies.set(key, x);
  x.n++;
  x.sx += sx;
  x.tx += tx;
  x.dy += ty - sy;
  if (tx < sx - 0.3) x.lift++;
  x.v += Math.hypot(car.vx, car.vy);
};
process.on('exit', () => {
  console.error('LABELS by wall gap, corner or straight: decisions; speed; throttle student vs teacher; teacher steers more by; teacher wants 0.3+ less throttle');
  for (const [k, x] of [...tallies].sort()) {
    console.error(`LABELS ${k.padEnd(18)} ${String(x.n).padStart(7)}  ${(x.v / x.n).toFixed(1)} m/s  ${(x.sx / x.n).toFixed(2)} vs ${(x.tx / x.n).toFixed(2)}  `
      + `${(x.dy / x.n >= 0 ? '+' : '') + (x.dy / x.n).toFixed(3)}  ${(100 * x.lift / x.n).toFixed(0)}%`);
  }
});
