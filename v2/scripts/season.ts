/**
 * Season benchmark: a field races a series with learning on, carrying what
 * each driver learned into the next race. Per race: retirements, damage done
 * by fault, passes under green, mean green lap time, and time spent in
 * danger (fear) per car per lap. For comparing how drivers come out of a
 * season under different learning objectives (e.g. nerve).
 *
 *   npx tsx scripts/season.ts [drivers.json] --races 9 --field 24 --nerve 0.5 --tracks short,speedway,flat [--laps N] [--out file.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { danger } from '../src/ai/fear';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec } from '../src/events/session';
import type { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { presetLayout } from '../src/trackgen';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const file = positional[0] ?? 'public/drivers/default.json';
const races = Number(args.get('races') ?? 9);
const fieldSize = Number(args.get('field') ?? 24);
const nerve = Number(args.get('nerve') ?? 0.5);
const tracks = (args.get('tracks') ?? 'short,speedway,flat').split(',');
const lapsArg = args.get('laps');
const out = args.get('out');

const roster: Array<{ weights: number[] }> = JSON.parse(readFileSync(file, 'utf8')).drivers;
const weights = Array.from({ length: fieldSize }, (_, k) => adaptWeights(Float32Array.from(roster[k % roster.length].weights)));

console.log(`season: ${races} races, ${fieldSize} cars, nerve ${nerve}, drivers ${file}`);
console.log('race track       out  harm  passes  lap(s)  danger s/lap  steps');
for (let r = 0; r < races; r++) {
  const trackName = tracks[r % tracks.length];
  const layout = presetLayout(trackName as never);
  const entrants: EntrantSpec[] = weights.map((w, k) => ({
    key: k, fill: '#ffffff',
    driver: { id: `D${k}`, weights: w, nerve },
    spotter: { id: `S${k}`, skill: PERFECT_SPOTTER },
    chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
  }));
  const laps = lapsArg ? Number(lapsArg) : Math.round(100_000 / new Track(layout).length);
  const s = new Session({ kind: 'race', layout, entrants, laps, pace: 4, seed: 1000 + r, learn: true });
  let steps = 0, passes = 0, dangerSum = 0, greenLapTime = 0, greenLaps = 0;
  let lastRank = new Map<Car, number>();
  const lapsSeen = new Map<Car, number>();
  while (!s.finished && s.world.time < laps * 300) {
    s.step();
    for (const step of s.takeLearned()) {
      const k = Number(step.driverId.slice(1));
      weights[k].set(step.weights);
      steps++;
    }
    const green = s.race?.control?.flag === 'green' && s.race.started;
    if (s.world.tick % P.CONTROL_EVERY === 0 && green) {
      for (const car of s.world.cars) if (!car.retired && car.pit.phase === 'none') dangerSum += danger(car, s.world) * P.CONTROL_EVERY * P.DT;
    }
    if (s.world.tick % Math.round(1 / P.DT) === 0) {
      const running = s.world.cars.filter((c) => !c.retired && c.pit.phase === 'none').sort((a, b) => b.dist - a.dist);
      const rank = new Map(running.map((c, i) => [c, i]));
      if (green) for (const [c, i] of rank) { const was = lastRank.get(c); if (was !== undefined && i < was) passes += was - i; }
      lastRank = rank;
    }
    for (const car of s.world.cars) {
      const n = car.lapTimes.length;
      if (n > (lapsSeen.get(car) ?? 0)) {
        if (green && car.pit.phase === 'none') { greenLapTime += car.lapTimes[n - 1]; greenLaps++; }
        lapsSeen.set(car, n);
      }
    }
  }
  const outCount = s.world.cars.filter((c) => c.retired).length;
  const harm = s.world.cars.reduce((a, c) => a + c.harmDone, 0);
  const carLaps = s.world.cars.reduce((a, c) => a + c.lapTimes.length, 0) || 1;
  console.log(`${String(r + 1).padStart(4)} ${trackName.padEnd(10)} ${String(outCount).padStart(4)} ${harm.toFixed(2).padStart(5)} ${String(passes).padStart(7)} ${(greenLapTime / (greenLaps || 1)).toFixed(2).padStart(7)} ${(dangerSum / carLaps).toFixed(3).padStart(13)} ${String(steps).padStart(6)}`);
}
if (out) {
  writeFileSync(out, JSON.stringify({ drivers: weights.map((w, k) => ({ lineage: `D${k}`, rounds: 0, weights: Array.from(w) })) }));
  console.log(`wrote ${out}`);
}
