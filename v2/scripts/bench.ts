/**
 * Race benchmark with error bars: runs scripts/incidents.ts race by race in
 * parallel (one race per process, across the CPU's cores) and reports each
 * number as a mean with its 95% range. Give two driver files to compare
 * them: both race the same seeds, and the difference is judged race by race
 * (paired), so it says whether B is really better, really worse, or within
 * the noise.
 *
 *   npx tsx scripts/bench.ts [A.json] [B.json] --tracks short,speedway,flat --seeds 8 [--jobs N] [--field 24] [--pace 4] [--laps N]
 *     [--json out.json]   (the numbers and verdicts, for the lab's promotion gate)
 *     tracks: presets, generated ovals (oval:<seed>[:<variant>[:<shape>]]), or ovals:N for N generated ovals (the same N every run)
 *     [--experiments '|?pitwidth=1.33']   one driver file raced as A and B with each set of the app's experiment switches
 *                 (src/sim/experiment.ts; '' for none), paired on the same seeds: an A/B of the switches
 *     [--h2h 1]   head to head as well: A and B in the same mixed field, every other grid slot, each seed raced twice with the
 *                 slots traded; judged on B's mean finishing place against A's (lower is better) and cars out per side
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSeed } from '../src/trackgen/generator';
import type { RaceSummary } from './incidents';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const experiments = args.get('experiments')?.split('|');
const files = experiments ? experiments.map(() => positional[0] ?? 'public/drivers/default.json')
  : positional.length ? positional : ['public/drivers/default.json'];
/** Generated ovals for ovals:N: fixed seeds, so every run sees the same tracks; sizes and shapes drawn by the generator. */
const tracks = (args.get('tracks') ?? 'short,speedway,flat').split(',').flatMap((t) => {
  const many = /^ovals:(\d+)$/.exec(t);
  return many ? Array.from({ length: Number(many[1]) }, (_, k) => `oval:${hashSeed(4242, `bench${k}`)}`) : [t];
});
const h2h = args.get('h2h') === '1';
const seeds = Number(args.get('seeds') ?? 8);
const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
const field = args.get('field') ?? '24';
const pace = args.get('pace') ?? '4';
const laps = args.get('laps'); // shorter races, for a quick look

const dir = mkdtempSync(join(tmpdir(), 'bench-'));
/** A race's results file: the side (a file's index, or h0 / h1 for the head-to-head races), the track, the seed. */
const outFile = (side: string, track: string, seed: number) => join(dir, `${side}-${track.replace(/[^\w-]/g, '_')}-${seed}.json`);
interface Job { file: number; track: string; seed: number; out: string; swap?: number }
const queue: Job[] = [];
files.forEach((_, file) => tracks.forEach((track) => {
  for (let seed = 1; seed <= seeds; seed++) queue.push({ file, track, seed, out: outFile(String(file), track, seed) });
}));
if (h2h && files.length === 2) {
  tracks.forEach((track) => {
    for (let seed = 1; seed <= seeds; seed++) for (const swap of [0, 1]) queue.push({ file: 0, track, seed, swap, out: outFile(`h${swap}`, track, seed) });
  });
}

function run(job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/incidents.ts', files[job.file], '--tracks', job.track, '--seeds', '1',
      '--seed-start', String(job.seed), '--field', field, '--pace', pace, '--marks', '0', '--json', job.out, ...(laps ? ['--laps', laps] : []),
      ...(job.swap !== undefined ? ['--mix', files[1], '--swap', String(job.swap)] : []),
      ...(experiments?.[job.file] ? ['--experiment', `"${experiments[job.file]}"`] : [])],
    { shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${job.track} seed ${job.seed} exited ${code}`))));
  });
}

const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    await run(job);
    done++;
    process.stderr.write(`\r${done} races done (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}));
process.stderr.write('\n');

const results = new Map<string, RaceSummary>(); // side-track-seed
const sides = [...files.map((_, file) => String(file)), ...(h2h && files.length === 2 ? ['h0', 'h1'] : [])];
for (const side of sides) tracks.forEach((track) => {
  for (let seed = 1; seed <= seeds; seed++) {
    results.set(`${side}-${track}-${seed}`, JSON.parse(readFileSync(outFile(side, track, seed), 'utf8'))[0]);
  }
});
rmSync(dir, { recursive: true, force: true });

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
const fmt = ({ mean, ci }: { mean: number; ci: number }, d = 1) => `${mean.toFixed(d)} ± ${ci.toFixed(d)}`;

const metrics: Array<[keyof RaceSummary, string, number, boolean | null]> = [
  // key, label, decimals, lower is better (null: no better or worse, just different)
  ['retirements', 'retirements', 1, true],
  ['atFault', '  at fault', 1, true],
  ['formationWrecks', '  formation pileups', 1, true],
  ['multiCar', 'multi-car wrecks', 1, true],
  ['harm', 'damage done (by fault)', 1, true],
  ['cautions', 'cautions', 1, true],
  ['stops', 'pit stops', 1, null],
  ['damageStops', '  called for damage', 1, true],
  ['pitLaneTime', '  pit entry to track (s)', 1, true],
  ['pitHits', '  pit-cycle contacts', 1, true],
  ['pitDamage', '  pit-cycle damage (health)', 2, true],
  ['lapTime', 'lap time (s, tires 60%+)', 2, true],
  // The goal is no scripted driving: the share of car-time a script drives, and cars out while one did.
  ['scripted', 'share driven by scripts', 3, true],
  ['scriptedRetirements', '  out while scripted', 1, true],
  ['passes', 'passes /100 green car-laps', 1, null],
  // Passing against contact: clean passes (no touch between the pair) and damaging contacts, per 100 green car-laps.
  ['cleanPasses', '  clean passes', 1, false],
  ['passDamage', '  share with damage', 3, true],
  ['passDraft', '  share from the draft', 3, null],
  ['greenHits', 'damaging contacts /100', 1, true],
  ['passesPerHit', 'clean passes per contact', 2, false],
  ['alongside', 'share of time alongside', 3, null],
  ['drafting', 'share of time drafting', 3, null],
  ['laneSpread', 'lane spread (m)', 2, null],
  // A field of copies moves as one: neighbours' control changes correlate. Lower is more like individuals.
  ['lockSame', 'lockstep, same brain', 3, true],
  ['lockDiff', 'lockstep, different brains', 3, true],
  // Twins: following within 2 s, how far the car behind is from what the car ahead did at the same spot.
  // Copies of one brain follow each other's tracks exactly; individuals don't. Higher is more like individuals.
  ['spotSameD', 'twins: lane gap, same brain', 2, null],
  ['spotDiffD', 'twins: lane gap, diff brains', 2, null],
  ['spotSameV', 'twins: speed gap, same', 2, null],
  ['spotDiffV', 'twins: speed gap, diff', 2, null],
];

/** What --json writes: per track and metric, each file's mean and 95% range, and B against A. */
export interface BenchMetric {
  values: Array<{ mean: number; ci: number }>;
  diff?: { mean: number; ci: number };
  verdict?: 'B better' | 'B worse' | 'B more' | 'B less' | 'within noise' | 'n/a';
}
export interface BenchReport {
  files: string[];
  seeds: number;
  tracks: Record<string, Record<string, BenchMetric>>;
}
const report: BenchReport = { files, seeds, tracks: {} };

console.log(`${seeds} races per track, ${field} cars, ${pace}x pace; ${files.map((f, i) => `${'AB'[i] ?? i}: ${f.split(/[\\/]/).pop()}${experiments ? ` ${experiments[i] || '(no switches)'}` : ''}`).join(', ')}`);
for (const track of tracks) {
  console.log(`\n${track}`);
  report.tracks[track] = {};
  for (const [key, label, d, lowerBetter] of metrics) {
    const per = files.map((_, file) => Array.from({ length: seeds }, (_, k) => results.get(`${file}-${track}-${k + 1}`)![key] as number));
    const entry: BenchMetric = { values: per.map((xs) => stats(xs)) };
    report.tracks[track][key] = entry;
    let line = `  ${label.padEnd(26)} ${per.map((xs) => fmt(stats(xs), d).padStart(14)).join('  ')}`;
    if (files.length === 2) {
      // Only races where both sides have the number (a field that never ran a lap on fresh tires has no lap time).
      const pairs = per[1].map((b, k) => b - per[0][k]).filter(Number.isFinite);
      const diff = stats(pairs);
      const missing = per.some((xs) => xs.filter(Number.isFinite).length < xs.length);
      const verdict = missing && pairs.length < 2 ? 'n/a (no data on one side)'
        : Math.abs(diff.mean) <= diff.ci || !Number.isFinite(diff.ci) ? 'within noise'
        : lowerBetter === null ? (diff.mean > 0 ? 'B more' : 'B less')
        : (diff.mean < 0) === lowerBetter ? 'B better' : 'B worse';
      line += `   B-A ${fmt(diff, d).padStart(14)}  ${verdict}`;
      entry.diff = diff;
      entry.verdict = verdict.startsWith('n/a') ? 'n/a' : verdict as BenchMetric['verdict'];
    }
    console.log(line);
  }
  if (h2h && files.length === 2) {
    // Per seed, both races (slots traded) averaged: B's side minus A's side, in the same races.
    const per = (pick: (s: NonNullable<RaceSummary['sides']>[number]) => number) => Array.from({ length: seeds }, (_, k) => {
      const [r0, r1] = ['h0', 'h1'].map((h) => results.get(`${h}-${track}-${k + 1}`)!.sides!);
      return (pick(r0[1]) - pick(r0[0]) + pick(r1[1]) - pick(r1[0])) / 2;
    });
    for (const [key, label] of [['place', 'h2h: B place - A place'], ['retirements', 'h2h: B out - A out']] as const) {
      const diff = stats(per((s) => s[key]));
      const verdict = Math.abs(diff.mean) <= diff.ci || !Number.isFinite(diff.ci) ? 'within noise' : diff.mean < 0 ? 'B better' : 'B worse';
      console.log(`  ${label.padEnd(26)} ${''.padStart(30)}   B-A ${fmt(diff).padStart(14)}  ${verdict}`);
      report.tracks[track][`h2h_${key}`] = { values: [], diff, verdict };
    }
  }
}
const jsonOut = args.get('json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
