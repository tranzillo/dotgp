/**
 * Circuit race benchmark: full races on road circuits the drivers have never
 * seen, run to the circuit rulebook (standing start, safety car, track
 * limits, stewards), with crew chiefs and pit stops, as the game races them.
 * Each number is a mean with its 95% range; with two driver files both race
 * the same circuits, grids and seeds, and B is judged against A race by race.
 *
 *   npx tsx scripts/circuits.ts [A.json] [B.json] [--tracks 6] [--seeds 2] [--field 20] [--km 25] [--pace 4] [--jobs N] [--json out.json]
 *     [--script-cautions 1]
 *
 * Drivers drive their own cautions if licensed (with their caution skill, if they have one); --script-cautions: the
 * formation script drives everyone's (to judge racing apart from cautions).
 *
 * Circuits alternate club and GP. Drivers drive their road-course skill where
 * they have one (their oval network otherwise), cycling through the file.
 *
 * teacher:drivers.json races the file's teachers instead: each driver's own
 * (a traffic racer with its road style, not passing, as in its
 * apprenticeship), driving its own safety cars: how well a field of students
 * could race at best, to measure what copying lost.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { adaptWeights, makeupOf, NeuralDriver, Team } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { placeOnGrid } from '../src/sim/grid';
import { bestValidLap, pastTrackLimits } from '../src/sim/limits';
import { Race } from '../src/sim/race';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { CIRCUIT_RULES } from '../src/rules/rulebook';
import { generateLayout, hashSeed } from '../src/trackgen';
import { ask, tsWorker } from './pool';
import { PHYSICS as P } from '../src/sim/constants';
import { DEFAULT_STYLE, TrafficRacer } from '../src/ai/trafficRacer';

interface DriverEntry {
  weights: number[];
  pitLicensed?: boolean;
  pitTrafficLicensed?: boolean;
  cautionLicensed?: boolean;
  roadCourse?: { weights: number[]; style?: { grip: number; margin: number; room?: number }; caution?: { weights: number[] } };
  limits?: { latency: number; noise: number };
  /** A caution skill: the network that drives while the field is pacing; and one for road circuits, if it has its own. */
  caution?: { weights: number[] };
}

interface RaceJob {
  file: string; track: number; seed: number; field: number; km: number; pace: number;
  /** Cautions driven by the formation script for everyone, whatever they've learned (to judge racing apart). */
  scriptCautions?: boolean;
}

/** One race, summed up. Counts are per race (the whole field). */
export interface CircuitRace {
  track: string;
  laps: number;
  finished: number;
  retirements: number;
  /** Retirements before the leader finished lap 1 (the standing start and the first corners). */
  firstLap: number;
  /** What finished them: the barriers, another car, or stopping (beached, stalled). */
  byWall: number;
  byCar: number;
  stopped: number;
  /** Damage cars did to others, by fault. */
  harm: number;
  /** Pit stops called, and those the crew called because the car was damaged (whatever else is done at them). */
  stops: number;
  damageStops: number;
  trackLimits: number;
  /** Excursions under green by where they went: across the inside of a corner (a cut), or wide. */
  cuts: number;
  wide: number;
  /** Shares of the racing cars' time driven by a script: the pit maneuver, the formation (safety cars). */
  scriptPit: number;
  scriptFormation: number;
  /** Share of laps completed within the track limits. */
  validLaps: number;
  timePenalties: number;
  safetyCars: number;
  /** Median of the cars' best valid laps, in seconds per km (so club and GP circuits compare). */
  bestLapPerKm: number;
}

/** The k-th benchmark circuit: club and GP alternating, from seeds no lesson or solo check uses. */
function benchTrack(k: number): Track {
  const variant = k % 2 === 0 ? 'club' : 'gp';
  return new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${k}`), variant }));
}

function runRace(job: RaceJob): CircuitRace {
  const teachers = job.file.startsWith('teacher:');
  const drivers = (JSON.parse(readFileSync(teachers ? job.file.slice('teacher:'.length) : job.file, 'utf8')) as { drivers: DriverEntry[] }).drivers;
  const track = benchTrack(job.track);
  const laps = Math.max(3, Math.round((job.km * 1000) / track.length));
  const world = new World(track, { collisions: true, drafting: true, wearScale: job.pace });
  // The grid and the crew chiefs depend on the seed only, so two files race the same grid.
  const rng = new Rng(hashSeed(job.seed, `grid${job.track}`));
  const slots = Array.from({ length: job.field }, (_, k) => ({ k, r: rng.next() })).sort((a, b) => a.r - b.r).map((x) => x.k);
  for (const [slot, k] of slots.entries()) {
    const d = drivers[(k + job.seed) % drivers.length];
    const car = new Car(slot);
    placeOnGrid(car, track, slot, true);
    const style = d.roadCourse?.style;
    if (teachers) {
      const racer = new TrafficRacer({
        ...DEFAULT_STYLE, ...(style ? { grip: style.grip, margin: style.margin } : {}), room: d.roadCourse?.style?.room ?? DEFAULT_STYLE.room, pass: Infinity,
      });
      world.addCar(car, new Team(racer, new TowerSpotter(), new StrategistCrewChief(randomTraits(() => rng.next())), false, true));
      continue;
    }
    // As it is: its style's line, its human limits (if it has them; seeded by race and slot, so both files' cars match).
    const m = makeupOf(d, hashSeed(job.seed, `hands${job.track}:${slot}`));
    const brain = new NeuralDriver(adaptWeights(Float32Array.from(d.weights)), d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined,
      m.knowledge, { limits: m.limits, caution: d.caution && !job.scriptCautions ? adaptWeights(Float32Array.from(d.caution.weights)) : undefined,
        roadCaution: d.roadCourse?.caution && !job.scriptCautions ? adaptWeights(Float32Array.from(d.roadCourse.caution.weights)) : undefined });
    world.addCar(car, new Team(brain, new TowerSpotter(), new StrategistCrewChief(randomTraits(() => rng.next())),
      !!(d.pitLicensed && d.pitTrafficLicensed), !job.scriptCautions && (d.cautionLicensed ?? false)));
  }
  const race = new Race(world, laps, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: job.seed });
  const ctl = race.control!;
  // Track limits are counted by race control as they happen; tally its calls.
  let trackLimits = 0;
  const announce = world.announce.bind(world);
  world.announce = (car, kind, text) => {
    if (kind === 'steward' && text.includes('track limits at')) trackLimits++;
    announce(car, kind, text);
  };
  const out = new Set<Car>();
  let firstLap = 0, byWall = 0, byCar = 0, stopped = 0, cuts = 0, wide = 0;
  const off = new Set<Car>();
  // Who drove each racing car, decision by decision: the driver, or a script (the pit maneuver, the formation).
  let byDriver = 0, byPit = 0, byFormation = 0;
  // Stops as they're called, and why.
  let stops = 0, damageStops = 0;
  const wasPitting = new Set<Car>();
  while (race.state !== 'finished' && world.time < laps * 400) {
    race.step();
    if (world.tick % P.CONTROL_EVERY === 0) {
      world.cars.forEach((car, k) => {
        const team = world.controllers[k];
        if (car.retired || car.finished || !(team instanceof Team)) return;
        if (team.mode === 'pit') byPit++;
        else if (team.mode === 'formation') byFormation++;
        else byDriver++;
      });
    }
    for (const car of world.cars) {
      if (car.pit.phase !== 'none' && !wasPitting.has(car)) {
        wasPitting.add(car);
        if (car.pit.call && !car.pit.call.penalty) { stops++; if (car.pit.call.reason === 'damage') damageStops++; }
      } else if (car.pit.phase === 'none') wasPitting.delete(car);
      const past = pastTrackLimits(car, track);
      if (past && !off.has(car) && ctl.flag === 'green') {
        // The corner here: the inside is the side it turns toward.
        let k = 0;
        for (let a = -30; a <= 30; a += 5) { const x = track.curvatureAt(car.s + a); if (Math.abs(x) > Math.abs(k)) k = x; }
        if (Math.abs(k) > 1e-3 && (k > 0) === (car.d > track.innerEdge(car.trackIdx))) cuts++;
        else wide++;
      }
      if (past) off.add(car); else off.delete(car);
    }
    for (const car of world.cars) {
      if (!car.retired || out.has(car)) continue;
      out.add(car);
      if ((race.leader()?.lapsCompleted ?? 0) < 1) firstLap++;
      const imp = car.lastImpact;
      if (car.health > 0 || !imp) stopped++;
      else if (imp.kind === 'car') byCar++;
      else byWall++;
    }
  }
  const best = world.cars.map(bestValidLap).filter(Number.isFinite).sort((a, b) => a - b);
  const lapCount = world.cars.reduce((a, c) => a + c.lapTimes.length, 0);
  return {
    track: track.name, laps, finished: world.cars.filter((c) => race.isFinished(c)).length, retirements: out.size, firstLap,
    byWall, byCar, stopped, harm: world.cars.reduce((a, c) => a + c.harmDone, 0), stops, damageStops, trackLimits, cuts, wide,
    validLaps: lapCount ? world.cars.reduce((a, c) => a + c.lapValid.filter(Boolean).length, 0) / lapCount : NaN,
    timePenalties: race.stewards?.record.filter((p) => p.penalty === 'time').length ?? 0, safetyCars: ctl.cautions,
    bestLapPerKm: best.length ? best[Math.floor(best.length / 2)] / (track.length / 1000) : NaN,
    scriptPit: byPit / Math.max(1, byDriver + byPit + byFormation),
    scriptFormation: byFormation / Math.max(1, byDriver + byPit + byFormation),
  };
}

if (!isMainThread && workerData?.circuitRaces) {
  parentPort!.on('message', (job: RaceJob) => parentPort!.postMessage(runRace(job)));
} else if (isMainThread) {
  await main();
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  const files: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[++i]);
    else files.push(a);
  }
  if (!files.length) files.push('public/drivers/default.json');
  const tracks = Number(args.get('tracks') ?? 6), seeds = Number(args.get('seeds') ?? 2);
  const field = Number(args.get('field') ?? 20), km = Number(args.get('km') ?? 25), pace = Number(args.get('pace') ?? 4);
  const jobs = Math.max(1, Number(args.get('jobs') ?? cpus().length - 1));

  const queue: RaceJob[] = [];
  for (const file of files) for (let t = 0; t < tracks; t++) for (let seed = 1; seed <= seeds; seed++) queue.push({ file, track: t, seed, field, km, pace, scriptCautions: args.has('script-cautions') });
  const results = new Map<RaceJob, CircuitRace>();
  const t0 = Date.now();
  const todo = [...queue];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    const w = tsWorker(import.meta.url, { circuitRaces: true });
    for (let job = todo.shift(); job; job = todo.shift()) {
      const j = job;
      results.set(j, await ask<CircuitRace>(w, j));
      process.stderr.write(`\r${results.size}/${queue.length} races (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    await w.terminate();
  }));
  process.stderr.write('\n');

  const per = files.map((file) => queue.filter((j) => j.file === file).map((j) => results.get(j)!));
  const metrics: Array<[keyof CircuitRace, string, number]> = [
    ['retirements', 'retirements', 1], ['firstLap', '  on the first lap', 1], ['byWall', '  barriers', 1], ['byCar', '  contact', 1],
    ['stopped', '  stopped (beached)', 1], ['harm', 'damage done (by fault)', 2], ['stops', 'pit stops', 1],
    ['damageStops', '  called for damage', 1], ['trackLimits', 'track limits', 1],
    ['wide', '  running wide', 1], ['cuts', '  cutting a corner', 1], ['validLaps', 'valid laps (share)', 2],
    ['timePenalties', 'time penalties', 1], ['safetyCars', 'safety cars', 1], ['finished', 'finished', 1],
    ['bestLapPerKm', 'best valid lap (s/km, median)', 2],
    ['scriptPit', 'scripted: pit maneuver (share)', 4], ['scriptFormation', 'scripted: formation (share)', 4],
  ];
  const higherBetter = new Set<keyof CircuitRace>(['finished', 'validLaps']);
  console.log(`circuit races: ${tracks} circuits x ${seeds} seeds, ${field} cars, ~${km} km, ${pace}x pace; ${files.map((f, i) => `${'AB'[i] ?? i}: ${f.split(/[\\/]/).pop()}`).join(', ')}`);
  const report: Record<string, { values: Array<{ mean: number; ci: number }>; diff?: { mean: number; ci: number }; verdict?: string }> = {};
  for (const [key, label, d] of metrics) {
    const xs = per.map((races) => races.map((r) => r[key] as number));
    const entry: (typeof report)[string] = { values: xs.map(stats) };
    let line = `  ${label.padEnd(26)} ${xs.map((x) => fmt(stats(x), d).padStart(14)).join('  ')}`;
    if (files.length === 2) {
      const diff = stats(xs[1].map((b, k) => b - xs[0][k]).filter(Number.isFinite));
      const verdict = !Number.isFinite(diff.ci) || Math.abs(diff.mean) <= diff.ci ? 'within noise'
        : (diff.mean > 0) === higherBetter.has(key) ? 'B better' : 'B worse';
      line += `   B-A ${fmt(diff, d).padStart(14)}  ${verdict}`;
      Object.assign(entry, { diff, verdict });
    }
    report[key] = entry;
    console.log(line);
  }
  const json = args.get('json');
  if (json) writeFileSync(json, JSON.stringify({ files, tracks, seeds, field, km, pace, metrics: report, races: per }, null, 1));
}

/** Two-sided 95% t critical value for n - 1 degrees of freedom. */
function t95(n: number): number {
  const table = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13];
  return n - 1 <= table.length ? table[Math.max(0, n - 2)] : 2.0;
}
function stats(xs: number[]): { mean: number; ci: number } {
  const v = xs.filter(Number.isFinite);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { mean, ci: v.length > 1 ? t95(v.length) * sd / Math.sqrt(v.length) : NaN };
}
function fmt({ mean, ci }: { mean: number; ci: number }, d: number): string {
  return `${mean.toFixed(d)} ± ${Number.isFinite(ci) ? ci.toFixed(d) : '–'}`;
}
