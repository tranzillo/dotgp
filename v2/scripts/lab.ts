/**
 * The lab: driver training as a background job, out of the way of feature
 * work. Experiments run in a second checkout of the repo (the lab worktree,
 * beside this one) pinned to a commit, so editing code here never disturbs a
 * class or a benchmark in progress. Experiments are queued as JSON specs in
 * lab/queue/ and run one after another; each gets a results folder (its spec,
 * every step's log, the drivers it trained) and a line in lab/RESULTS.md.
 *
 *   npx tsx scripts/lab.ts init            create the lab worktree and lab/ (house drivers from public/drivers)
 *   npx tsx scripts/lab.ts sync            move the lab to this checkout's HEAD (commit training changes first)
 *   npx tsx scripts/lab.ts run [--once]    work through the queue, oldest first (--once: stop when it's empty)
 *   npx tsx scripts/lab.ts status          the queue, what's running, recent results
 *
 * A spec (lab/queue/<name>.json):
 *   { "note": "why", "steps": [
 *       { "kind": "class", "lesson": "cautions", "in": "$house", "out": "trained.json", "rounds": 100 },
 *       { "kind": "season", "in": "trained.json", "out": "seasoned.json", "races": 9, "nerve": 0.5 },
 *       { "kind": "bench", "a": "$house", "b": "trained.json", "seeds": 8 },
 *       { "kind": "solo", "a": "$house", "b": "trained.json" },        (solo driving on circuits and mirrored ovals)
 *       { "kind": "circuits", "a": "$house", "b": "trained.json" },    (races on road circuits: 6 circuits x 3 seeds by default;
 *                                                                        field, km: cars and race length; "teacher:x.json": x's teachers)
 *       { "kind": "promote", "candidate": "trained.json" } ] }
 * The oval stable (forty individuals, see scripts/stable.ts):
 *       { "kind": "stable", "out": "stable.json", "rounds": 12 },                     (apprenticeship to their own teachers)
 *       { "kind": "stableCautions", "in": "stable.json", "out": "c.json", "ppo": true },  (caution drills; ES unless ppo)
 *       { "kind": "stableRaces", "in": "stable.json", "out": "r.json", "rounds": 120 },   (PPO in 40-car races, anchored)
 *       { "kind": "bench", "a": "$house", "b": "r.json", "field": 40, "tracks": "short,speedway,flat,ovals:3", "h2h": true },
 * File names are in the experiment's results folder; $house is the house drivers (lab/house.json), $bundled
 * the drivers shipped with the commit. Promotion replaces the house drivers only if the last benchmark says
 * the candidate is no worse on any track (retirements, lap time; and, where the bench measured them, places
 * head to head and the share of driving left to scripts) and better on at least one (retirements).
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BenchReport } from './bench';
import type { SoloReport } from './solo';

const mainV2 = process.cwd();
const repoRoot = git(mainV2, 'rev-parse', '--show-toplevel');
const labRoot = join(dirname(repoRoot), `${basename(repoRoot)}-lab`);
const labV2 = join(labRoot, relative(repoRoot, mainV2));
const data = join(mainV2, 'lab');
const dirs = { queue: join(data, 'queue'), results: join(data, 'results'), houseHistory: join(data, 'house-history') };
const house = join(data, 'house.json');
const runningFile = join(data, 'running.json');
const resultsLog = join(data, 'RESULTS.md');
/** Cores a benchmark or a class may use (the rest stay free for development). */
const BENCH_JOBS = 6;

type Step =
  | { kind: 'class'; lesson: string; in: string; out: string; rounds?: number; seed?: number }
  | { kind: 'season'; in: string; out: string; races?: number; nerve?: number; tracks?: string }
  | { kind: 'bench'; a: string; b?: string; seeds?: number; tracks?: string; laps?: number; field?: number; pace?: number; h2h?: boolean }
  | { kind: 'stable'; out: string; drivers?: number; group?: number; rounds?: number; laps?: number; field?: number; seed?: number; shake?: number }
  | { kind: 'stableCautions'; in: string; out: string; rounds?: number; ppo?: boolean; seed?: number }
  | { kind: 'stableRaces'; in: string; out: string; rounds?: number; laps?: number; field?: number; debris?: number; anchorLr?: number; seed?: number }
  | { kind: 'solo'; a: string; b?: string; tracks?: number; seconds?: number }
  | { kind: 'circuits'; a: string; b?: string; tracks?: number; seeds?: number; field?: number; km?: number }
  | { kind: 'promote'; candidate: string };
interface Spec { note?: string; steps: Step[] }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const command = process.argv[2];
if (command === 'init') init();
else if (command === 'sync') sync();
else if (command === 'run') await run(process.argv.includes('--once'));
else if (command === 'status') status();
else console.log('usage: npx tsx scripts/lab.ts init | sync | run [--once] | status');

function init(): void {
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  if (!existsSync(labRoot)) {
    git(repoRoot, 'worktree', 'add', '--detach', labRoot, 'HEAD');
    console.log(`lab worktree at ${labRoot}`);
  }
  const modules = join(labV2, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(mainV2, 'node_modules'), modules, 'junction');
  if (!existsSync(house)) {
    copyFileSync(join(mainV2, 'public/drivers/default.json'), house);
    console.log('house drivers: the bundled drivers');
  }
  console.log(`lab at ${git(labRoot, 'rev-parse', '--short', 'HEAD')}; queue: ${dirs.queue}`);
}

function sync(): void {
  if (running()) throw new Error('an experiment is running; sync after it finishes');
  const head = git(mainV2, 'rev-parse', 'HEAD');
  git(labRoot, 'checkout', '--detach', head);
  console.log(`lab now at ${head.slice(0, 7)}${git(mainV2, 'status', '--porcelain').length ? ' (uncommitted changes here are not in the lab)' : ''}`);
}

function running(): { name: string; pid: number; started: string; step: string } | null {
  if (!existsSync(runningFile)) return null;
  const r = JSON.parse(readFileSync(runningFile, 'utf8'));
  try { process.kill(r.pid, 0); return r; } catch { return null; } // a runner that died leaves a stale file
}

function status(): void {
  const r = running();
  const queue = existsSync(dirs.queue) ? readdirSync(dirs.queue).filter((f) => f.endsWith('.json')).sort() : [];
  console.log(`lab at ${existsSync(labRoot) ? git(labRoot, 'rev-parse', '--short', 'HEAD') : '(not set up: lab.ts init)'}`);
  console.log(r ? `running: ${r.name} since ${r.started}, step ${r.step}` : 'running: nothing');
  console.log(`queued: ${queue.length ? queue.join(', ') : 'nothing'}`);
  if (existsSync(resultsLog)) console.log(`\nrecent results:\n${readFileSync(resultsLog, 'utf8').trim().split('\n').slice(-8).join('\n')}`);
}

/** Run a script in the lab worktree, its output into a log; resolves when it exits. */
function runScript(script: string, args: string[], log: string): Promise<void> {
  return new Promise((ok, fail) => {
    const out = createWriteStream(log);
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a));
    const child = spawn('npx', ['tsx', `scripts/${script}.ts`, ...quoted], { cwd: labV2, shell: true });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${script} exited ${code}; see ${log}`))));
  });
}

async function run(once: boolean): Promise<void> {
  if (running()) throw new Error('a lab runner is already running');
  if (!existsSync(labV2)) throw new Error('no lab yet: npx tsx scripts/lab.ts init');
  for (;;) {
    const next = existsSync(dirs.queue) ? readdirSync(dirs.queue).filter((f) => f.endsWith('.json')).sort()[0] : undefined;
    if (!next) {
      if (once) break;
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    await runExperiment(next);
  }
  rmSync(runningFile, { force: true });
}

async function runExperiment(file: string): Promise<void> {
  const name = file.replace(/\.json$/, '');
  const spec = JSON.parse(readFileSync(join(dirs.queue, file), 'utf8')) as Spec;
  const started = new Date();
  const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dir = join(dirs.results, `${stamp}-${name}`);
  mkdirSync(dir, { recursive: true });
  renameSync(join(dirs.queue, file), join(dir, 'spec.json'));
  const commit = git(labRoot, 'rev-parse', '--short', 'HEAD');
  const path = (p: string): string => (p.startsWith('teacher:') ? `teacher:${path(p.slice('teacher:'.length))}`
    : p === '$house' ? house : p === '$bundled' ? join(labV2, 'public/drivers/default.json') : resolve(dir, p));
  const notes: string[] = [];
  let bench: BenchReport | null = null;
  let failed = '';
  for (const [i, step] of spec.steps.entries()) {
    writeFileSync(runningFile, JSON.stringify({ name, pid: process.pid, started: started.toISOString(), step: `${i + 1}/${spec.steps.length} ${step.kind}` }));
    const log = join(dir, `${String(i + 1).padStart(2, '0')}-${step.kind}.log`);
    try {
      if (step.kind === 'class') {
        const summary = join(dir, `${String(i + 1).padStart(2, '0')}-class.json`);
        await runScript('class', ['--lesson', step.lesson, '--in', path(step.in), '--out', path(step.out),
          '--rounds', String(step.rounds ?? 100), '--seed', String(step.seed ?? 7), '--summary', summary, '--jobs', String(BENCH_JOBS)], log);
        const s = JSON.parse(readFileSync(summary, 'utf8'));
        const key = { cautions: 'cautionLicensed', pits: 'pitLicensed', pitTraffic: 'pitTrafficLicensed', rookie: 'licensed', circuits: 'roadLicensed' }[step.lesson as string];
        const passed = key ? s.students.filter((x: Record<string, boolean>) => x[key]).length : null;
        notes.push(`${step.lesson} class ${s.rounds} rounds${passed !== null ? `, ${passed}/${s.students.length} licensed` : ''}`);
      } else if (step.kind === 'season') {
        await runScript('season', [path(step.in), '--out', path(step.out), '--races', String(step.races ?? 9),
          '--nerve', String(step.nerve ?? 0.5), ...(step.tracks ? ['--tracks', step.tracks] : [])], log);
        notes.push(`season ${step.races ?? 9} races`);
      } else if (step.kind === 'bench') {
        const json = join(dir, 'bench.json');
        await runScript('bench', [path(step.a), ...(step.b ? [path(step.b)] : []), '--seeds', String(step.seeds ?? 8),
          '--tracks', step.tracks ?? 'short,speedway,flat', '--jobs', String(BENCH_JOBS), '--json', json, ...(step.laps ? ['--laps', String(step.laps)] : []),
          ...(step.field ? ['--field', String(step.field)] : []), ...(step.pace ? ['--pace', String(step.pace)] : []), ...(step.h2h ? ['--h2h', '1'] : [])], log);
        bench = JSON.parse(readFileSync(json, 'utf8')) as BenchReport;
        notes.push(`bench ${benchLine(bench)}`);
      } else if (step.kind === 'solo') {
        const json = join(dir, 'solo.json');
        await runScript('solo', [path(step.a), ...(step.b ? [path(step.b)] : []), '--tracks', String(step.tracks ?? 6),
          '--seconds', String(step.seconds ?? 120), '--json', json], log);
        const r = JSON.parse(readFileSync(json, 'utf8')) as SoloReport;
        notes.push(`solo ${Object.keys(r.results[0]).map((k) => `${k} ${r.results.map((x) => `${(100 * x[k].crashed).toFixed(0)}%`).join('→')} crashed, ${r.results.map((x) => `${(100 * (x[k].stopped ?? 0)).toFixed(0)}%`).join('→')} stopped`).join(', ')}`);
      } else if (step.kind === 'circuits') {
        const json = join(dir, `${String(i + 1).padStart(2, '0')}-circuits.json`);
        await runScript('circuits', [path(step.a), ...(step.b ? [path(step.b)] : []), '--tracks', String(step.tracks ?? 6),
          '--seeds', String(step.seeds ?? 3), '--jobs', String(BENCH_JOBS), '--json', json,
          ...(step.field ? ['--field', String(step.field)] : []), ...(step.km ? ['--km', String(step.km)] : [])], log);
        const m = JSON.parse(readFileSync(json, 'utf8')).metrics as Record<string, { values: Array<{ mean: number }>; verdict?: string }>;
        notes.push(`circuits ${(['retirements', 'trackLimits', 'bestLapPerKm'] as const).map((k) =>
          `${k} ${m[k].values.map((v) => v.mean.toFixed(1)).join('→')}${m[k].verdict ? ` (${m[k].verdict})` : ''}`).join(', ')}`);
      } else if (step.kind === 'stable') {
        await runScript('stable', ['--out', path(step.out), '--jobs', String(Math.min(5, BENCH_JOBS)),
          ...opt({ drivers: step.drivers, group: step.group, rounds: step.rounds, laps: step.laps, field: step.field, seed: step.seed, shake: step.shake })], log);
        notes.push(`stable ${step.drivers ?? 40} drivers, ${step.rounds ?? 10} apprenticeship rounds`);
      } else if (step.kind === 'stableCautions') {
        await runScript('stableCautions', ['--in', path(step.in), '--out', path(step.out), '--jobs', String(Math.min(5, BENCH_JOBS)),
          ...opt({ rounds: step.rounds, seed: step.seed, ppo: step.ppo ? 1 : undefined })], log);
        notes.push(`caution practice (${step.ppo ? 'PPO' : 'ES'}) ${step.rounds ?? (step.ppo ? 100 : 40)} rounds`);
      } else if (step.kind === 'stableRaces') {
        await runScript('stableRaces', ['--in', path(step.in), '--out', path(step.out), '--jobs', String(Math.min(5, BENCH_JOBS)),
          ...opt({ rounds: step.rounds, laps: step.laps, field: step.field, debris: step.debris, 'anchor-lr': step.anchorLr, seed: step.seed })], log);
        notes.push(`race practice ${step.rounds ?? 100} races`);
      } else if (step.kind === 'promote') {
        notes.push(promote(path(step.candidate), bench, name));
      }
    } catch (e) {
      failed = (e as Error).message;
      notes.push(`FAILED at step ${i + 1} (${step.kind}): ${failed}`);
      break;
    }
  }
  const minutes = ((Date.now() - started.getTime()) / 60_000).toFixed(0);
  const line = `- ${started.toISOString().slice(0, 16).replace('T', ' ')} **${name}** @${commit} (${minutes} min)${spec.note ? ` — ${spec.note}` : ''}: ${notes.join('; ')}`;
  writeFileSync(join(dir, 'summary.md'), `${line}\n`);
  appendFileSync(resultsLog, `${line}\n`);
  rmSync(runningFile, { force: true });
  console.log(line);
}

/** Command-line options for the ones given. */
function opt(o: Record<string, number | undefined>): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, String(v)]));
}

/** Retirements per track, B against A (or A's alone). */
function benchLine(b: BenchReport): string {
  return Object.entries(b.tracks).map(([track, m]) => {
    const r = m.retirements;
    return r.diff ? `${track} ${r.values[0].mean.toFixed(1)}→${r.values[1].mean.toFixed(1)} (${r.verdict})` : `${track} ${r.values[0].mean.toFixed(1)}`;
  }).join(', ');
}

/** The promotion gate: no worse anywhere (retirements, lap time), better somewhere (retirements). */
function promote(candidate: string, bench: BenchReport | null, name: string): string {
  if (!bench || bench.files.length !== 2) return 'promote: skipped (needs a bench of house vs candidate first)';
  const tracks = Object.entries(bench.tracks);
  // Where the bench measured them: losing head to head (mixed fields), or leaving more of the driving to scripts.
  const worse = tracks.filter(([, m]) => m.retirements.verdict === 'B worse' || m.lapTime.verdict === 'B worse'
    || m.h2h_place?.verdict === 'B worse' || m.scripted?.verdict === 'B worse').map(([t]) => t);
  const better = tracks.filter(([, m]) => m.retirements.verdict === 'B better').map(([t]) => t);
  if (worse.length) return `promote: rejected (worse on ${worse.join(', ')})`;
  if (!better.length) return 'promote: rejected (not better anywhere)';
  mkdirSync(dirs.houseHistory, { recursive: true });
  if (existsSync(house)) copyFileSync(house, join(dirs.houseHistory, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-before-${name}.json`));
  copyFileSync(candidate, house);
  return `promote: **promoted** (better on ${better.join(', ')})`;
}
