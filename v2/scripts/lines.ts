/**
 * The fastest line, as a yardstick: on the benchmark circuits, the racing
 * line's profile lap, a scripted racer driving it (at shares of the tyres'
 * grip: valid laps, and lap time), the line follower (the road teacher),
 * and the drivers in files, all solo from the line. Lap times are against
 * the line follower's.
 *
 *   npx tsx scripts/lines.ts [drivers.json ...] [--tracks 8]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, NeuralDriver, ScriptedDriver, Team } from '../src/ai/drivers';
import { RacingLineDriver, racingLine, type RacingLine } from '../src/ai/racingLine';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { ROLLING_START_SPEED } from '../src/sim/grid';
import { bestValidLap } from '../src/sim/limits';
import { Track } from '../src/sim/track';
import { World, type Controller } from '../src/sim/world';
import { generateLayout, hashSeed } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const count = Number(args.get('tracks') ?? 8);
const log = console.log;
console.log = () => {};

/** Best valid lap of a solo run from the line (two laps: the second is the flying one). */
function lap(track: Track, who: Controller): { lap: number; laps: number } {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  world.addCar(car, who);
  car.placeOnTrack(track, track.length - 20, 0);
  car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
  car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
  for (let i = 0; i < 400 / P.DT && car.lapTimes.length < 3 && !car.retired; i++) world.step();
  return { lap: bestValidLap(car), laps: car.lapTimes.length };
}

const PACES = [0.85, 0.9, 0.95];
const rows: Array<{ name: string; ratio: number[]; valid: number[] }> = [];
const add = (name: string, ratio: number) => {
  let r = rows.find((x) => x.name === name);
  if (!r) { r = { name, ratio: [], valid: [] }; rows.push(r); }
  if (Number.isFinite(ratio)) r.ratio.push(ratio);
  r.valid.push(Number.isFinite(ratio) ? 1 : 0);
};
const drivers = files.map((f) => ({
  name: f.split(/[\\/]/).pop()!,
  list: JSON.parse(readFileSync(f, 'utf8')).drivers as Array<{ weights: number[]; roadCourse?: { weights: number[] } }>,
}));

for (let t = 0; t < count; t++) {
  const variant = t % 2 === 0 ? 'club' : 'gp';
  const track = new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${t}`), variant }));
  const t0 = Date.now();
  const line: RacingLine = racingLine(track);
  const ms = Date.now() - t0;
  const teacher = lap(track, new ScriptedDriver(0, 0.9)).lap;
  const parts = [`${variant} ${t}: ${(track.length / 1000).toFixed(1)} km, line follower ${teacher.toFixed(1)} s; profile ${line.lapTime.toFixed(1)} s (${ms} ms)`];
  add('racing line profile', line.lapTime / teacher);
  for (const pace of PACES) {
    const r = lap(track, new RacingLineDriver(pace, () => line)).lap;
    add(`racing line at ${pace}`, r / teacher);
    parts.push(`at ${pace}: ${Number.isFinite(r) ? r.toFixed(1) : 'no valid lap'}`);
  }
  for (const f of drivers) {
    const laps = f.list.map((d) => lap(track, new Team(new NeuralDriver(adaptWeights(Float32Array.from(d.weights)),
      d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined), new TowerSpotter(), null)).lap);
    for (const l of laps) add(f.name, l / teacher);
    const valid = laps.filter(Number.isFinite).sort((a, b) => a - b);
    parts.push(`${f.name}: best ${valid.length ? valid[0].toFixed(1) : '-'}`);
  }
  log(parts.join(' | '));
}
log('\nlap against the line follower\'s (valid laps only), and share of runs with a valid lap:');
for (const r of rows) {
  const sorted = [...r.ratio].sort((a, b) => a - b);
  const mean = r.ratio.reduce((a, b) => a + b, 0) / Math.max(1, r.ratio.length);
  log(`  ${r.name.padEnd(28)} mean ${(100 * mean).toFixed(1)}%  best ${sorted.length ? (100 * sorted[0]).toFixed(1) : '-'}%  valid ${(100 * r.valid.reduce((a, b) => a + b, 0) / r.valid.length).toFixed(0)}%`);
}
