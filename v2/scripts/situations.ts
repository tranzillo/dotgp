/**
 * Situations on road circuits: a big pack braking from a long straight into a
 * tight corner, and a pack through a chicane, on circuits the drivers have
 * never seen (the circuit race benchmark's). Every braking spot and chicane
 * there (sim/features.ts), each with packs drawn from a few seeds: the pack on
 * the approach at the reference lap's speed, rows two or three wide, driven
 * until it's all 150 m past the exit. With two driver files both drive the
 * same packs, and B is judged against A situation by situation.
 *
 *   npx tsx scripts/situations.ts [A.json] [B.json] [--tracks 12] [--seeds 3] [--pack 12] [--jobs N] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { adaptWeights, NeuralDriver, Team } from '../src/ai/drivers';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { pastTrackLimits } from '../src/sim/limits';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, hashSeed } from '../src/trackgen';
import { situationLayout, situationsOn, type Situation } from '../src/school/roadcraftLesson';
import { ask, tsWorker } from './pool';

type SituationKind = Situation;
interface Job { file: string; track: number; kind: SituationKind; index: number; seed: number; pack: number }

/** One situation's outcome (the whole pack). */
export interface SituationResult {
  kind: SituationKind;
  /** Car-to-car damage, all told, and by where it began: the approach, the corner (or chicane), the exit. */
  contact: number;
  approach: number;
  feature: number;
  exit: number;
  /** Damage done by fault, contact incidents (a second apart counts again), retirements. */
  harm: number;
  incidents: number;
  retired: number;
  /** Excursions past the limits: across a corner's inside (cuts), and wide. */
  cuts: number;
  wide: number;
  /** Mean time from the start to 150 m past the exit (s; a car that didn't get there counts the time limit). */
  time: number;
  /** Places changed, all told (each car's |start place - end place|). */
  shuffle: number;
}

const LIMIT = 30; // s
const PAST_EXIT = 150; // m

function benchTrack(k: number): Track {
  const variant = k % 2 === 0 ? 'club' : 'gp';
  return new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${k}`), variant }));
}

const features = situationsOn;

function runSituation(job: Job): SituationResult {
  const drivers = (JSON.parse(readFileSync(job.file, 'utf8')) as { drivers: Array<{ weights: number[]; roadCourse?: { weights: number[] } }> }).drivers;
  const track = benchTrack(job.track);
  const L = track.length;
  const f = features(track, job.kind)[job.index];
  const rng = new Rng(hashSeed(job.seed, `${job.kind}${job.track}-${job.index}`));
  const world = new World(track, { collisions: true, drafting: true });
  // The pack, placed as circuit racecraft places its situation drills.
  const pack = situationLayout(track, f, job.kind, rng, job.pack);
  pack.spots.forEach((spot, k) => {
    const car = new Car(k);
    car.placeOnTrack(track, track.wrapS(pack.frontS - spot.back), spot.lane);
    car.vx = track.tx[car.trackIdx] * spot.speed;
    car.vy = track.ty[car.trackIdx] * spot.speed;
    const d = drivers[(k + job.seed) % drivers.length];
    world.addCar(car, new Team(new NeuralDriver(adaptWeights(Float32Array.from(d.weights)),
      d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined), new TowerSpotter(), null));
  });
  const cars = world.cars;
  const startDist = cars.map((c) => c.dist);
  // Distance each car must cover to be PAST_EXIT beyond the feature's end.
  const goal = cars.map((c, k) => startDist[k] + (((f.s1 + PAST_EXIT - c.s) % L) + L) % L);
  const startPlace = placesOf(cars);
  const arrived = cars.map(() => NaN);
  const health = cars.map((c) => c.health), lastContact = cars.map(() => -Infinity);
  const off = cars.map(() => false);
  const out: SituationResult = { kind: job.kind, contact: 0, approach: 0, feature: 0, exit: 0, harm: 0, incidents: 0, retired: 0, cuts: 0, wide: 0, time: 0, shuffle: 0 };
  type Section = 'approach' | 'feature' | 'exit';
  const section = (c: Car): Section => {
    const from0 = ((c.s - f.s0) % L + L) % L, span = ((f.s1 - f.s0) % L + L) % L;
    return from0 > L / 2 ? 'approach' : from0 <= span ? 'feature' : 'exit';
  };
  const where = cars.map((): Section => 'approach');
  for (let step = 0; step < LIMIT / P.DT; step++) {
    world.step();
    cars.forEach((c, k) => {
      if (Number.isNaN(arrived[k]) && c.dist >= goal[k]) arrived[k] = world.time;
      const lost = health[k] - c.health;
      if (lost > 1e-9 && c.lastImpact?.kind === 'car') {
        if (world.time - lastContact[k] > 1) { out.incidents++; where[k] = section(c); }
        out.contact += lost;
        out[where[k]] += lost;
        lastContact[k] = world.time;
      }
      health[k] = c.health;
      const past = pastTrackLimits(c, track);
      if (past && !off[k]) {
        let kap = 0;
        for (let a = -30; a <= 30; a += 5) { const x = track.curvatureAt(c.s + a); if (Math.abs(x) > Math.abs(kap)) kap = x; }
        if (Math.abs(kap) > 1e-3 && (kap > 0) === (c.d > track.innerEdge(c.trackIdx))) out.cuts++;
        else out.wide++;
      }
      off[k] = past;
    });
    if (cars.every((c, k) => c.retired || !Number.isNaN(arrived[k]))) break;
  }
  out.harm = cars.reduce((a, c) => a + c.harmDone, 0);
  out.retired = cars.filter((c) => c.retired).length;
  out.time = arrived.reduce((a, t) => a + (Number.isNaN(t) ? LIMIT : t), 0) / cars.length;
  const endPlace = placesOf(cars);
  out.shuffle = cars.reduce((a, _, k) => a + Math.abs(startPlace[k] - endPlace[k]), 0);
  return out;
}

/** Each car's place in the pack (0: leading), by distance covered. */
function placesOf(cars: Car[]): number[] {
  const order = cars.map((_, k) => k).sort((a, b) => cars[b].dist - cars[a].dist);
  const place = new Array<number>(cars.length);
  order.forEach((k, p) => { place[k] = p; });
  return place;
}

if (!isMainThread && workerData?.situations) {
  parentPort!.on('message', (job: Job) => parentPort!.postMessage(runSituation(job)));
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
  const tracks = Number(args.get('tracks') ?? 12), seeds = Number(args.get('seeds') ?? 3), pack = Number(args.get('pack') ?? 12);
  const jobs = Math.max(1, Number(args.get('jobs') ?? cpus().length - 1));

  const situations: Array<{ track: number; kind: SituationKind; index: number }> = [];
  for (let t = 0; t < tracks; t++) {
    const track = benchTrack(t);
    for (const kind of ['braking', 'chicane'] as const) features(track, kind).forEach((_, index) => situations.push({ track: t, kind, index }));
  }
  const queue: Job[] = [];
  for (const file of files) for (const s of situations) for (let seed = 1; seed <= seeds; seed++) queue.push({ file, ...s, seed, pack });
  const results = new Map<Job, SituationResult>();
  const todo = [...queue];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    const w = tsWorker(import.meta.url, { situations: true });
    for (let job = todo.shift(); job; job = todo.shift()) {
      const j = job;
      results.set(j, await ask<SituationResult>(w, j));
    }
    await w.terminate();
  }));

  const kinds = ['braking', 'chicane'] as const;
  const n = Object.fromEntries(kinds.map((k) => [k, situations.filter((s) => s.kind === k).length]));
  console.log(`situations: ${n.braking} braking spots and ${n.chicane} chicanes on ${tracks} circuits, x ${seeds} packs of ${pack} (${((Date.now() - t0) / 1000).toFixed(0)} s); ${files.map((f, i) => `${'AB'[i] ?? i}: ${f.split(/[\\/]/).pop()}`).join(', ')}`);
  const metrics: Array<[keyof SituationResult, string, number, boolean]> = [
    ['contact', 'contact damage', 2, false], ['approach', '  begun on the approach', 2, false], ['feature', '  in the corner / chicane', 2, false],
    ['exit', '  on the exit', 2, false], ['harm', 'damage done (by fault)', 2, false], ['incidents', 'contact incidents', 1, false],
    ['retired', 'retirements', 2, false], ['cuts', 'cuts', 2, false], ['wide', 'running wide', 2, false], ['time', 'time through (s)', 2, false],
    ['shuffle', 'places changed', 1, true],
  ];
  const report: Record<string, Record<string, unknown>> = {};
  for (const kind of kinds) {
    console.log(`\n${kind === 'braking' ? 'braking from a long straight into a tight corner' : 'through a chicane'} (per pack)`);
    const per = files.map((file) => queue.filter((j) => j.file === file && j.kind === kind).map((j) => results.get(j)!));
    report[kind] = {};
    for (const [key, label, d, neutral] of metrics) {
      const xs = per.map((rs) => rs.map((r) => r[key] as number));
      let line = `  ${label.padEnd(26)} ${xs.map((x) => fmt(stats(x), d).padStart(14)).join('  ')}`;
      const entry: Record<string, unknown> = { values: xs.map(stats) };
      if (files.length === 2) {
        const diff = stats(xs[1].map((b, k) => b - xs[0][k]));
        const verdict = !Number.isFinite(diff.ci) || Math.abs(diff.mean) <= diff.ci ? 'within noise' : neutral ? (diff.mean > 0 ? 'more' : 'fewer') : diff.mean < 0 ? 'B better' : 'B worse';
        line += `   B-A ${fmt(diff, d).padStart(14)}  ${verdict}`;
        Object.assign(entry, { diff, verdict });
      }
      report[kind][key] = entry;
      console.log(line);
    }
  }
  const json = args.get('json');
  if (json) writeFileSync(json, JSON.stringify({ files, tracks, seeds, pack, metrics: report }, null, 1));
}

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
