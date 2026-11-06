/**
 * Crew chief race strategy, headless: benchmark two sets of chiefs head to
 * head, or train chiefs in real races (contact, cautions), on worker threads.
 *
 *   npx tsx scripts/strategy.ts bench --a veteran --b caution [--tracks short,flat,speedway] [--seeds 4] [--jobs 6]
 *   npx tsx scripts/strategy.ts train --from public/chiefs/default.json --rounds 100 [--out runs/strategy.json] [--jobs 6]
 *
 * Chiefs: a chiefs file (public/chiefs/*.json or a train output), `veteran`
 * (the scripted strategist) or `caution[:share]` (the veteran that also takes
 * a due stop under caution once that share of a tank is gone; 0.3 by default). Drivers: --drivers (default: the house drivers;
 * public/drivers/road-apprentice.json for circuits). Tracks: preset names, or
 * circuit:<seed>[:club|gp].
 *
 * A bench compares A and B in the same races: each pair is one A chief and
 * one B chief with the same driver, the race run twice with their grid slots
 * swapped; a pair counts in a race where both cars are running at the flag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { isMainThread, parentPort, workerData, type Worker } from 'node:worker_threads';
import { adaptWeights } from '../src/ai/drivers';
import { adaptChiefWeights } from '../src/ai/neuralChief';
import type { CrewChiefTraits } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import {
  pairedRaces, scorePairs, StrategyTrainer, type ChiefBrainSpec, type ChiefPair, type StrategyDriver,
} from '../src/ai/strategyTraining';
import { Session, type EntrantResult, type SessionSpec } from '../src/events/session';
import type { TrackLayout } from '../src/sim/layout';
import { generateTrack, presetLayout } from '../src/trackgen';
import { tsWorker } from './pool';

/** The longest a race may run (sim s) before it's called. */
const RACE_LIMIT = 3 * 3600;

function runRace(spec: SessionSpec): EntrantResult[] {
  const s = new Session(spec);
  while (!s.finished && s.time < RACE_LIMIT) s.step();
  return s.results();
}

/** Races spread over worker threads, results in the order given. */
class RacePool {
  private readonly workers: Worker[];
  private readonly idle: Worker[];
  private readonly waiting: Array<() => void> = [];
  private next = 0;
  private readonly pending = new Map<number, (r: EntrantResult[]) => void>();

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => {
      const w = tsWorker(import.meta.url, { strategyWorker: true });
      w.on('message', (m: { id: number; results: EntrantResult[] }) => {
        this.pending.get(m.id)!(m.results);
        this.pending.delete(m.id);
        this.idle.push(w);
        this.waiting.shift()?.();
      });
      return w;
    });
    this.idle = [...this.workers];
  }

  private async one(spec: SessionSpec): Promise<EntrantResult[]> {
    while (!this.idle.length) await new Promise<void>((r) => this.waiting.push(r));
    const w = this.idle.pop()!;
    const id = this.next++;
    return new Promise((ok) => {
      this.pending.set(id, ok);
      w.postMessage({ id, spec });
    });
  }

  run(specs: SessionSpec[]): Promise<EntrantResult[][]> {
    return Promise.all(specs.map((s) => this.one(s)));
  }

  close(): void {
    for (const w of this.workers) void w.terminate();
  }
}

const VETERAN: CrewChiefTraits = { fuelMarginLaps: 1.2, tireLimit: 0.35, repairBelow: 0.7, minLapsForTires: 8 };

function parseArgs(): { mode: string; args: Map<string, string> } {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[++i]);
  return { mode: argv[0] ?? 'bench', args };
}

function chiefSet(name: string): ChiefBrainSpec[] {
  if (name === 'veteran') return [{ kind: 'scripted', traits: VETERAN }];
  // caution[:share]: the veteran that takes a due stop under caution once this share of a tank is gone (default 0.3).
  // smart: the veteran that takes a stop under caution whenever it doesn't add a stop to its race.
  if (name === 'smart') return [{ kind: 'scripted', traits: { ...VETERAN, cautionStop: 0, cautionSavesStop: true } }];
  if (name.startsWith('caution')) return [{ kind: 'scripted', traits: { ...VETERAN, cautionStop: Number(name.split(':')[1] ?? 0.3) } }];
  const data = JSON.parse(readFileSync(name, 'utf8')) as { chiefs: Array<{ weights: number[] }> };
  return data.chiefs.map((c) => ({ kind: 'neural', weights: adaptChiefWeights(Float32Array.from(c.weights)) }));
}

function loadDrivers(file: string): StrategyDriver[] {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { drivers: Array<{ weights: number[]; nerve?: number; roadCourse?: { weights: number[] } }> };
  return data.drivers.map((d) => ({
    weights: adaptWeights(Float32Array.from(d.weights)),
    roadWeights: d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined,
    nerve: d.nerve,
  }));
}

function layoutOf(name: string): TrackLayout {
  const [type, seed, variant] = name.split(':');
  return type === 'circuit' || type === 'oval' ? generateTrack({ type, seed: Number(seed), variant }).layout : presetLayout(name as never);
}

/** Scripted veterans of every temperament for the field: half of them use cautions. */
function veteranField(rng: Rng, n: number): CrewChiefTraits[] {
  return Array.from({ length: n }, (_, k) => ({
    fuelMarginLaps: 0.6 + rng.next() * 1.8, tireLimit: 0.25 + rng.next() * 0.2, repairBelow: 0.55 + rng.next() * 0.3,
    minLapsForTires: 4 + rng.int(8), ...(k % 2 ? { cautionStop: 0.2 + rng.next() * 0.3 } : {}),
  }));
}

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
function ci(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return (1.96 * Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1))) / Math.sqrt(x.length);
}

async function main(): Promise<void> {
  const { mode, args } = parseArgs();
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 2));
  const tracks = (args.get('tracks') ?? 'short,flat,speedway').split(',');
  const drivers = loadDrivers(args.get('drivers') ?? 'public/drivers/default.json');
  const field = Number(args.get('field') ?? 24);
  const laps = Number(args.get('laps') ?? 50);
  const pace = Number(args.get('pace') ?? 4);
  const rng = new Rng(Number(args.get('seed') ?? 1));
  const pool = new RacePool(jobs);
  const t0 = performance.now();

  if (mode === 'bench') {
    const a = chiefSet(args.get('a') ?? 'veteran'), b = chiefSet(args.get('b') ?? 'caution');
    const seeds = Number(args.get('seeds') ?? 4);
    const opponents: ChiefBrainSpec[] = veteranField(rng, 8).map((traits) => ({ kind: 'scripted', traits }));
    const perTrack = new Map<string, number[]>();
    const plans = tracks.flatMap((track) => Array.from({ length: seeds }, () => {
      const pairs: ChiefPair[] = Array.from({ length: 8 }, (_, i) => ({ x: a[i % a.length], y: b[i % b.length], driver: rng.int(drivers.length) }));
      const plan = pairedRaces(pairs, opponents, drivers, field, { layout: layoutOf(track), laps, pace, seed: (rng.next() * 2 ** 31) >>> 0 });
      return { track, plan, pairs: pairs.length };
    }));
    const results = await pool.run(plans.flatMap((p) => p.plan.races));
    let at = 0;
    for (const p of plans) {
      const res = results.slice(at, at + p.plan.races.length);
      at += p.plan.races.length;
      // Places B finished behind A, per pair per race that counted.
      for (const sc of scorePairs(p.plan, res, p.pairs)) if (sc.races) (perTrack.get(p.track) ?? perTrack.set(p.track, []).get(p.track)!).push(sc.places / sc.races);
    }
    for (const [track, d] of perTrack) {
      console.log(`${track}: A ahead of B by ${mean(d).toFixed(2)} places ±${ci(d).toFixed(2)} (95%, ${d.length} pairs)`);
    }
    console.log(`${results.length} races in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  } else if (mode === 'train') {
    const from = chiefSet(args.get('from') ?? 'public/chiefs/default.json').filter((c) => c.kind === 'neural') as Array<{ kind: 'neural'; weights: Float32Array }>;
    const rounds = Number(args.get('rounds') ?? 50);
    const out = args.get('out') ?? `runs/strategy-${Date.now().toString(36)}.json`;
    const trainer = new StrategyTrainer(from.map((c) => c.weights), tracks.map(layoutOf), drivers, veteranField(rng, 6), {
      seed: Number(args.get('seed') ?? 1), field,
      pairs: Number(args.get('pairs') ?? 6), sigma: Number(args.get('sigma') ?? 0.05), learningRate: Number(args.get('lr') ?? 0.01),
    });
    const save = () => writeFileSync(out, JSON.stringify({
      round: trainer.round, chiefs: trainer.chiefs.map((c) => ({ weights: Array.from(c.weights), rounds: c.rounds })),
    }));
    for (let r = 0; r < rounds; r++) {
      const t = performance.now();
      const report = trainer.learn(await pool.run(trainer.plan()));
      console.log(`round ${report.round} ${report.track} ${report.laps} laps ${report.pace.toFixed(1)}x: ${report.races} races, `
        + `${report.lineages.map((l) => `${l.pairs} pairs ±${l.spread.toFixed(1)}`).join(' | ')} (${((performance.now() - t) / 1000).toFixed(0)} s)`);
      if (r % 5 === 4 || r === rounds - 1) save();
    }
    console.log(`saved ${out}`);
  }
  pool.close();
}

if (!isMainThread && (workerData as { strategyWorker?: boolean })?.strategyWorker) {
  parentPort!.on('message', (m: { id: number; spec: SessionSpec }) => {
    parentPort!.postMessage({ id: m.id, results: runRace(m.spec) });
  });
} else if (isMainThread) {
  void main();
}
