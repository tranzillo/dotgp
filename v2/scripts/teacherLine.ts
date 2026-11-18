// In DAgger, how often is a teacher's home line not the line the student's car is on (teacher not passing)?
//
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/teacherLine.ts [track speedway] [laps 8] [bundle]
import { readFileSync } from 'node:fs';
import { Rng } from '../src/ai/rng';
import { TrafficRacer } from '../src/ai/trafficRacer';
import { adaptWeights } from '../src/ai/drivers';
import { classroomRace } from '../src/school/classroomRace';
import { presetTrack } from '../src/trackgen/index';
import { whichLine } from '../src/ai/racingLine';

const trackName = process.argv[2] ?? 'speedway';
const bundle = JSON.parse(readFileSync(process.argv[4] ?? 'public/drivers/stable-candidate-v7-lines.json', 'utf8')).drivers;
const students = bundle.slice(0, 10).map((d: any) => ({
  lineage: d.lineage, nerve: d.nerve, talent: d.talent, limits: d.limits,
  weights: adaptWeights(Float32Array.from(d.weights)), caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : null,
  tactics: d.tactics ? Float32Array.from(d.tactics.weights) : null,
}));
let n = 0, stale = 0, passing = 0, staleFar = 0;
const orig = TrafficRacer.prototype.takeOver;
TrafficRacer.prototype.takeOver = function (this: any, car: any, world: any) {
  orig.call(this, car, world);
  if ((world.control?.flag ?? 'green') !== 'green') return;
  n++;
  if (this.path || this.passSide) { passing++; return; }
  const on = whichLine(world.track, this.style.margin, car.s, car.d);
  if (this.home && on !== this.home) { stale++; if (Math.abs(this.offset) > 3) staleFar++; }
};
const examples = students.map(() => [] as any[]), plans = students.map(() => [] as any[]);
classroomRace(presetTrack(trackName), students, { kind: 'student' }, examples, new Rng(7), { field: 40, laps: Number(process.argv[3] ?? 8), debris: 0.05, tactics: plans }, 1, 11);
console.log(`${trackName}: green decisions ${n}, teacher passing ${(100 * passing / n).toFixed(1)}%, not passing with home != car's line ${(100 * stale / n).toFixed(1)}% (of those, offset > 3 m: ${(100 * staleFar / Math.max(1, stale)).toFixed(0)}%)`);
