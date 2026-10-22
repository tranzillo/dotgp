/**
 * The oval stable: new drivers, each its own individual, taught by
 * apprenticeship in classroom races (src/school/ovalApprentice.ts). Students
 * train in groups, one process per group, then go into one bundle that the
 * benchmarks race (each driver with its nerve, talent and human limits, and
 * driving its own cautions).
 *
 *   npx tsx scripts/stable.ts --out stable.json [--drivers 40] [--group 8] [--rounds 10] [--laps 30] [--field 40] [--seed 1] [--jobs N]
 *   npx tsx scripts/stable.ts --group-only <first> --count <n> --out part.json ...   (one group: what the parent runs)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apprenticeStable, lineOf, newStableDriver, type StableDriver } from '../src/school/ovalApprentice';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const out = args.get('out') ?? 'stable.json';
const seed = Number(args.get('seed') ?? 1);
const pass = ['rounds', 'laps', 'field', 'seed', 'debris', 'epochs', 'shake'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

const toJson = (d: StableDriver) => ({
  lineage: d.lineage, rounds: 0, nerve: d.nerve, talent: d.talent, limits: d.limits, cautionLicensed: true, weights: Array.from(d.weights),
  ...(d.caution ? { caution: { weights: Array.from(d.caution) } } : {}),
  knowledge: lineOf(d),
});

if (args.has('group-only')) {
  const first = Number(args.get('group-only')), count = Number(args.get('count'));
  const students = Array.from({ length: count }, (_, i) => newStableDriver(first + i, seed));
  apprenticeStable(students, seed + first, {
    ...(args.has('rounds') ? { rounds: Number(args.get('rounds')) } : {}),
    ...(args.has('laps') ? { laps: Number(args.get('laps')) } : {}),
    ...(args.has('field') ? { field: Number(args.get('field')) } : {}),
    ...(args.has('debris') ? { debris: Number(args.get('debris')) } : {}),
    ...(args.has('epochs') ? { epochs: Number(args.get('epochs')) } : {}),
    ...(args.has('shake') ? { shake: Number(args.get('shake')) } : {}),
    onRound: (round, r) => console.log(`group ${first} round ${round} ${r.track}: ${r.out} out, ${r.examples} moments, `
      + `loss ${(r.losses.reduce((a, b) => a + b, 0) / r.losses.length).toFixed(4)}, cautions ${r.cautionLoss.toFixed(4)}, solo crashes ${r.soloCrashes}/${3 * count} (${r.seconds.toFixed(0)} s)`),
  });
  writeFileSync(out, JSON.stringify({ drivers: students.map(toJson) }));
} else {
  const drivers = Number(args.get('drivers') ?? 40), group = Number(args.get('group') ?? 8);
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
  const dir = mkdtempSync(join(tmpdir(), 'stable-'));
  const groups = Array.from({ length: Math.ceil(drivers / group) }, (_, g) => ({ first: g * group, count: Math.min(group, drivers - g * group), file: join(dir, `g${g}.json`) }));
  const queue = groups.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/stable.ts', '--group-only', String(g.first), '--count', String(g.count), '--out', g.file, ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`group ${g.first} exited ${code}`))));
      });
    }
  }));
  const all = groups.flatMap((g) => JSON.parse(readFileSync(g.file, 'utf8')).drivers);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(out, JSON.stringify({ drivers: all }));
  console.log(`${all.length} drivers -> ${out} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}
