/**
 * In DAgger, how far a student's car is across the road from where its teacher wants it when the teacher takes over:
 * green decisions in a classroom race (students in a field of teachers, as the apprenticeship races them), by how far
 * the teacher's offset moves in the decision (it starts at the car: takeOver), as a speed. Over a step (CROSS_RATE x
 * the decision, 0.1 m) the move is the crossing rate, 3 m/s: before 2026-11-01 that was the sideways speed the label
 * asked for, whatever the gap (a car 0.2 m off was asked for about 9 m/s^2 across).
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/takeoverGaps.ts [track] [laps] [bundle] [students]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { Rng } from '../src/ai/rng';
import { TrafficRacer } from '../src/ai/trafficRacer';
import { classroomRace } from '../src/school/classroomRace';
import { presetTrack } from '../src/trackgen';
import type { Car } from '../src/sim/car';
import type { World } from '../src/sim/world';

const trackName = process.argv[2] ?? 'short', laps = Number(process.argv[3] ?? 6);
const bundle = JSON.parse(readFileSync(process.argv[4] ?? 'public/drivers/stable-candidate-v8ra-lines.json', 'utf8')).drivers;
const students = bundle.slice(0, Number(process.argv[5] ?? 8)).map((d: any) => ({
  lineage: d.lineage, nerve: d.nerve, talent: d.talent, limits: d.limits,
  weights: adaptWeights(Float32Array.from(d.weights)), caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : null,
  tactics: d.tactics ? Float32Array.from(d.tactics.weights) : null,
}));
const BANDS = [0.5, 1.5, 2.9, Infinity];
const counts = BANDS.map(() => 0);
let n = 0;
const pending = new WeakMap<TrafficRacer, { offset: number; path: unknown; t: number }>();
const take = TrafficRacer.prototype.takeOver, decide = TrafficRacer.prototype.decide;
TrafficRacer.prototype.takeOver = function (this: any, car: Car, world: World) {
  take.call(this, car, world);
  if ((world.control?.flag ?? 'green') === 'green' && car.health > 0.99) pending.set(this, { offset: this.offset, path: this.path, t: this.lastTime });
};
TrafficRacer.prototype.decide = function (this: any, car: Car, world: World) {
  const p = pending.get(this);
  pending.delete(this);
  decide.call(this, car, world);
  // (A decision that changed its path measures the offset from another line.)
  if (!p || this.path !== p.path || !Number.isFinite(p.t)) return;
  const dt = Math.min(0.2, world.time - p.t);
  if (!(dt > 0)) return;
  const rate = Math.abs(this.offset - p.offset) / dt;
  counts[BANDS.findIndex((b) => rate < b)]++;
  n++;
};
const examples = students.map(() => [] as unknown[]);
classroomRace(presetTrack(trackName), students, { kind: 'student' }, examples as any, new Rng(7), { field: 40, laps, debris: 0 }, 1, 11);
console.log(`${trackName}: ${n} green takeovers; the offset's move as a speed: `
  + counts.map((c, i) => `${i ? BANDS[i - 1] : 0}-${BANDS[i] === Infinity ? '' : BANDS[i]} m/s ${(100 * c / Math.max(1, n)).toFixed(1)}%`).join(', '));
