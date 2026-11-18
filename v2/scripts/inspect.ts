/**
 * Drive saved champions (plus the scripted baseline) for a few laps and
 * report how they drive: line, speeds, wall contact, and technique.
 *
 *   npx tsx scripts/inspect.ts runs/speedway-seed1-gen60.json [--track short]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, neuralTeam, ScriptedDriver } from '../src/ai/drivers';
import { Car, SIGNATURE_BINS } from '../src/sim/car';
import { FLAT_TRACK, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { World, type Controller } from '../src/sim/world';

const file = process.argv[2];
const trackArg = process.argv.indexOf('--track');
const run = JSON.parse(readFileSync(file, 'utf8'));
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK };
const trackName: keyof typeof specs = trackArg > 0 ? process.argv[trackArg + 1] as keyof typeof specs : run.track;
const track = ovalTrack(specs[trackName]);

const entrants: Array<[string, Controller]> = [
  ['scripted', new ScriptedDriver(0)],
  ...run.champions.map((c: { lineage: number; weights: number[] }) =>
    [`L${c.lineage}`, neuralTeam(adaptWeights(Float32Array.from(c.weights)))] as [string, Controller]),
];

const LAPS = 4;
console.log(`track=${trackName}  ${LAPS} laps each, solo\n`);
console.log('driver    laps  lap times                    vMax  vMinTurn  turnLine(d)  wallTime  health tire/lap  |input|  sideways-in-turn');

for (const [name, driver] of entrants) {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  car.placeOnTrack(track, track.length - 20, 0);
  world.addCar(car, driver);
  let vMax = 0, vMinTurn = Infinity, turnD = 0, turnSamples = 0, wallTime = 0, inputMag = 0, samples = 0;
  let turnLat = 0, turnLon = 0;
  let tireAtLap1 = 1;
  while (world.time < 60 * LAPS && car.lapsCompleted < LAPS && !car.retired) {
    world.step();
    if (car.lapsCompleted === 0) { tireAtLap1 = car.tireLife; continue; } // skip the standing start
    const sp = car.speed;
    vMax = Math.max(vMax, sp);
    const inTurn = track.turn[car.trackIdx] > 0.99;
    if (inTurn) {
      vMinTurn = Math.min(vMinTurn, sp);
      turnD += car.d;
      turnSamples++;
      turnLat += Math.abs(car.tireLat);
      turnLon += Math.abs(car.tireLon);
    }
    if (car.wallContact) wallTime += world.opts ? 1 / 120 : 0;
    inputMag += Math.min(1, Math.hypot(car.inputX, car.inputY));
    samples++;
  }
  const laps = car.lapTimes.slice(1); // first timed lap includes the rolling start
  const tirePerLap = laps.length ? (tireAtLap1 - car.tireLife) / laps.length : 0;
  console.log(
    `${name.padEnd(9)} ${String(car.lapsCompleted).padStart(4)}  ${laps.map((t) => t.toFixed(2)).join(' ').padEnd(28)} ` +
    `${vMax.toFixed(1).padStart(5)} ${vMinTurn.toFixed(1).padStart(8)} ${(turnD / Math.max(1, turnSamples)).toFixed(1).padStart(11)} ` +
    `${wallTime.toFixed(1).padStart(8)}s ${car.health.toFixed(2).padStart(6)} ${(tirePerLap * 100).toFixed(2).padStart(7)}% ` +
    `${(inputMag / Math.max(1, samples)).toFixed(2).padStart(7)}  ${(turnLat / Math.max(1e-9, turnLat + turnLon) * 100).toFixed(0).padStart(5)}%`,
  );
  // Fine signature: 12 bins of 30 deg, centered labels, normalised.
  const total = car.signature.reduce((a, b) => a + b, 0) || 1;
  const bins = Array.from({ length: SIGNATURE_BINS }, (_, b) => {
    const center = -180 + (b + 0.5) * (360 / SIGNATURE_BINS);
    return `${center > 0 ? '+' : ''}${center}:${Math.round((car.signature[b] / total) * 100)}`;
  }).filter((s) => !s.endsWith(':0'));
  console.log(`          signature (deg:%)  ${bins.join('  ')}`);
}
