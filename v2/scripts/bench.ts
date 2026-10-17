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
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RaceSummary } from './incidents';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const files = positional.length ? positional : ['public/drivers/default.json'];
const tracks = (args.get('tracks') ?? 'short,speedway,flat').split(',');
const seeds = Number(args.get('seeds') ?? 8);
const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
const field = args.get('field') ?? '24';
const pace = args.get('pace') ?? '4';
const laps = args.get('laps'); // shorter races, for a quick look

const dir = mkdtempSync(join(tmpdir(), 'bench-'));
interface Job { file: number; track: string; seed: number; out: string }
const queue: Job[] = [];
files.forEach((_, file) => tracks.forEach((track) => {
  for (let seed = 1; seed <= seeds; seed++) queue.push({ file, track, seed, out: join(dir, `${file}-${track}-${seed}.json`) });
}));

function run(job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/incidents.ts', files[job.file], '--tracks', job.track, '--seeds', '1',
      '--seed-start', String(job.seed), '--field', field, '--pace', pace, '--marks', '0', '--json', job.out, ...(laps ? ['--laps', laps] : [])],
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

const results = new Map<string, RaceSummary>(); // file-track-seed
files.forEach((_, file) => tracks.forEach((track) => {
  for (let seed = 1; seed <= seeds; seed++) {
    results.set(`${file}-${track}-${seed}`, JSON.parse(readFileSync(join(dir, `${file}-${track}-${seed}.json`), 'utf8'))[0]);
  }
}));
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

const metrics: Array<[keyof RaceSummary, string, number, boolean]> = [
  // key, label, decimals, lower is better
  ['retirements', 'retirements', 1, true],
  ['atFault', '  at fault', 1, true],
  ['formationWrecks', '  formation pileups', 1, true],
  ['multiCar', 'multi-car wrecks', 1, true],
  ['harm', 'damage done (by fault)', 1, true],
  ['cautions', 'cautions', 1, true],
  ['lapTime', 'lap time (s, tires 60%+)', 2, true],
];

/** What --json writes: per track and metric, each file's mean and 95% range, and B against A. */
export interface BenchMetric {
  values: Array<{ mean: number; ci: number }>;
  diff?: { mean: number; ci: number };
  verdict?: 'B better' | 'B worse' | 'within noise' | 'n/a';
}
export interface BenchReport {
  files: string[];
  seeds: number;
  tracks: Record<string, Record<string, BenchMetric>>;
}
const report: BenchReport = { files, seeds, tracks: {} };

console.log(`${seeds} races per track, ${field} cars, ${pace}x pace; ${files.map((f, i) => `${'AB'[i] ?? i}: ${f.split(/[\\/]/).pop()}`).join(', ')}`);
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
        : (diff.mean < 0) === lowerBetter ? 'B better' : 'B worse';
      line += `   B-A ${fmt(diff, d).padStart(14)}  ${verdict}`;
      entry.diff = diff;
      entry.verdict = verdict.startsWith('n/a') ? 'n/a' : verdict as BenchMetric['verdict'];
    }
    console.log(line);
  }
}
const jsonOut = args.get('json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
