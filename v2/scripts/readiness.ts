/**
 * Readiness: can a bundle of drivers race clean, with no scripted driving,
 * wherever a race can happen? The first milestone (training/ROADMAP.md):
 * clean, unscripted house drivers for any condition.
 *
 * Every cell of the matrix races the bundle against its own teachers (each
 * driver's traffic racer, from its nerve and talent: what a field of these
 * drivers could race like at best), paired race by race:
 *   - ovals: the presets and a generated oval of each size class, full distance (150 km), 20 and 40 cars (bench.ts)
 *   - circuits: club and GP, full distance (150 km) at 20 and 40 cars, and the 25 km sprint at 20 (circuits.ts)
 * A cell is ready when the drivers are no worse than their teachers on retirements (within noise, race by race),
 * within PACE_SLACK of their pace, and drive everything themselves (scripted share under SCRIPT_SLACK).
 *
 *   npx tsx scripts/readiness.ts drivers.json [--seeds 4] [--fields 20,40] [--circuits 4] [--only ovals|circuits] [--jobs N]
 *     [--json out.json] [--md out.md]
 *
 * Not covered yet: rovals and venue rings (no race benchmark races them), qualifying.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSeed } from '../src/trackgen/generator';

const args = new Map<string, string>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
  else positional.push(process.argv[i]);
}
const bundle = positional[0];
if (!bundle) throw new Error('usage: readiness.ts drivers.json [...]');
const seeds = args.get('seeds') ?? '4';
const fields = (args.get('fields') ?? '20,40').split(',');
const circuitCount = args.get('circuits') ?? '4';
const only = args.get('only');
const jobs = args.get('jobs') ?? String(Math.max(1, cpus().length - 1));

/** A cell is ready within this much of its teachers' pace, and with less than this share of driving scripted. */
const PACE_SLACK = 0.03;
const SCRIPT_SLACK = 0.01;

/** The ovals: the presets, and one generated oval of each size class (fixed seeds: every run sees the same). */
const OVALS = ['short', 'speedway', 'flat',
  ...['short', 'intermediate', 'speedway', 'superspeedway'].map((v) => `oval:${hashSeed(2026, `readiness-${v}`)}:${v}`)];

function run(script: string, scriptArgs: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn('npx', ['tsx', `scripts/${script}.ts`, ...scriptArgs], { shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${script} exited ${code}`))));
  });
}

interface Metric { values: Array<{ mean: number; ci: number }>; diff?: { mean: number; ci: number }; verdict?: string }
interface Cell {
  kind: 'oval' | 'circuit';
  name: string;
  field: number;
  km: number;
  teachersOut: number;
  driversOut: number;
  outVerdict: string;
  /** The drivers' pace against their teachers' (+ slower). */
  paceGap: number;
  scripted: number;
  ready: boolean;
}

const dir = mkdtempSync(join(tmpdir(), 'readiness-'));
const cells: Cell[] = [];
const t0 = Date.now();
/** The drivers' pace against their teachers': no laps at all (a field that couldn't lap) is as far off as can be. */
const gap = (drivers: number, teachers: number) => (drivers > 0 && teachers > 0 ? drivers / teachers - 1 : Infinity);
const judge = (c: Omit<Cell, 'ready'>): Cell => ({
  ...c, ready: c.outVerdict !== 'B worse' && c.paceGap <= PACE_SLACK && c.scripted < SCRIPT_SLACK,
});

if (only !== 'circuits') {
  for (const field of fields) {
    const json = join(dir, `ovals-${field}.json`);
    process.stderr.write(`ovals, ${field} cars...\n`);
    await run('bench', [`teacher:${bundle}`, bundle, '--tracks', OVALS.join(','), '--seeds', seeds, '--field', field, '--jobs', jobs, '--json', json]);
    const report = JSON.parse(readFileSync(json, 'utf8')) as { tracks: Record<string, Record<string, Metric>> };
    for (const [track, m] of Object.entries(report.tracks)) {
      const lap = m.lapTime.values;
      cells.push(judge({
        kind: 'oval', name: track.startsWith('oval:') ? `generated ${track.split(':')[2]}` : track, field: Number(field), km: 150,
        teachersOut: m.retirements.values[0].mean, driversOut: m.retirements.values[1].mean, outVerdict: m.retirements.verdict ?? '',
        paceGap: gap(lap[1].mean, lap[0].mean), scripted: m.scripted.values[1].mean,
      }));
    }
  }
}
if (only !== 'ovals') {
  const runs = [...fields.map((f) => ({ field: f, km: '150' })), { field: '20', km: '25' }];
  for (const { field, km } of runs) {
    const json = join(dir, `circuits-${field}-${km}.json`);
    process.stderr.write(`circuits, ${field} cars, ${km} km...\n`);
    await run('circuits', [`teacher:${bundle}`, bundle, '--tracks', circuitCount, '--seeds', seeds, '--field', field, '--km', km, '--jobs', jobs, '--json', json]);
    const m = (JSON.parse(readFileSync(json, 'utf8')) as { metrics: Record<string, Metric> }).metrics;
    const lap = m.bestLapPerKm.values;
    cells.push(judge({
      kind: 'circuit', name: km === '25' ? 'club + GP (sprint)' : 'club + GP', field: Number(field), km: Number(km),
      teachersOut: m.retirements.values[0].mean, driversOut: m.retirements.values[1].mean, outVerdict: m.retirements.verdict ?? '',
      paceGap: gap(lap[1].mean, lap[0].mean), scripted: m.scriptPit.values[1].mean + m.scriptFormation.values[1].mean,
    }));
  }
}
rmSync(dir, { recursive: true, force: true });

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'no laps');
const lines = [
  `Readiness of ${bundle.split(/[\\/]/).pop()} (${seeds} seeds a cell, ${((Date.now() - t0) / 60000).toFixed(0)} min): ${cells.filter((c) => c.ready).length} of ${cells.length} cells ready`,
  '',
  '| Where | Cars | km | Out: teachers | Out: drivers | vs teachers | Pace gap | Scripted | Ready |',
  '|---|---|---|---|---|---|---|---|---|',
  ...cells.map((c) => `| ${c.kind === 'oval' ? 'oval: ' : ''}${c.name} | ${c.field} | ${c.km} | ${c.teachersOut.toFixed(1)} | ${c.driversOut.toFixed(1)} | ${c.outVerdict} | ${pct(c.paceGap)} | ${pct(c.scripted)} | ${c.ready ? 'yes' : '**no**'} |`),
  '',
  'Not covered yet: rovals and venue rings, qualifying.',
];
console.log(lines.join('\n'));
if (args.get('md')) writeFileSync(args.get('md')!, `${lines.join('\n')}\n`);
if (args.get('json')) writeFileSync(args.get('json')!, JSON.stringify({ bundle, seeds, cells }, null, 1));
