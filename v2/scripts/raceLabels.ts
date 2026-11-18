/**
 * Race labelling for the oval caution skill or the pit skill (src/school/raceLabels.ts): each round the stable races itself on the
 * apprenticeship's ovals (presets and generated, in turn), each car's own teacher labelling from where it is; the
 * field's caution moments (the last --keep rounds of them) are pooled, and each driver's caution network trains on
 * them and as many racing moments (it takes the wheel mid-corner at racing speed). The round's last race is held out
 * of that round's training and scores the caution networks before and after it. Everything else in the bundle is kept.
 * With --skill stops it's the pit skill: each car's pit skill drives its stops and the pit maneuver labels them from
 * where the car is; each driver's pit network trains on the field's stop moments (no racing ones: the pit network only
 * drives stops).
 *
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/raceLabels.ts --in stable.json --out labelled.json
 *     [--rounds 4] [--races 6] [--km 80] [--sample 0.04] [--keep 3] [--epochs 4] [--moments 60000] [--debris 0]
 *     [--wrecks 0] [--skill cautions|stops] [--seed 1] [--jobs N]
 *   npx tsx scripts/raceLabels.ts --in stable.json --race-only <index> --out rows.bin ...   (one race: what the parent runs)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptPitWeights, adaptWeights, CAUTION_FROM, DRIVER_LAYERS, PIT_NET_LAYERS } from '../src/ai/drivers';
import { Network, trainSupervised, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { apprenticeTrack } from '../src/school/ovalApprentice';
import { labelledRace, rowsToExamples, type RaceDriver } from '../src/school/raceLabels';
import { hashSeed } from '../src/trackgen/generator';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const num = (k: string, d: number) => Number(args.get(k) ?? d);
const seed = num('seed', 1);
const skill = args.get('skill') === 'stops' ? 'stops' : 'cautions';
const raceOpts = { km: num('km', 80), sample: num('sample', 0.04), debris: num('debris', 0), wrecks: num('wrecks', 0), skill } as const;

if (args.has('race-only')) {
  const index = Number(args.get('race-only'));
  const roster: RaceDriver[] = JSON.parse(readFileSync(args.get('in')!, 'utf8')).drivers;
  // Not the bench's generated ovals: the apprenticeship's, far past where it got to.
  const track = apprenticeTrack(1000 + index, seed);
  const t0 = Date.now();
  const r = labelledRace(track, roster, hashSeed(seed, `race${index}`) % 1000, raceOpts);
  writeFileSync(args.get('out')!, Buffer.from(r.rows.buffer, r.rows.byteOffset, r.rows.byteLength));
  console.log(`race ${index} (${track.length.toFixed(0)} m): ${r.out} out, ${r.cautions} cautions, ${skill === 'stops' ? `${r.pacing + r.green} stop moments (${r.pacing} under caution)` : `${r.pacing} caution moments, ${r.green} racing`} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(0);
}

const input = args.get('in')!, out = args.get('out') ?? 'labelled.json';
const rounds = num('rounds', 4), races = num('races', 6), keep = num('keep', 3), epochs = num('epochs', 4), moments = num('moments', 60_000);
const jobs = num('jobs', Math.max(1, cpus().length - 1));
const file = JSON.parse(readFileSync(input, 'utf8'));
const roster: Array<RaceDriver & { caution: { weights: number[] }; pit: { weights: number[] } }> = file.drivers;
const dir = mkdtempSync(join(tmpdir(), 'race-labels-'));
const rng = new Rng(hashSeed(seed, 'race labels training'));
/** n of them at random (all, if there are no more). */
function pick(all: Example[], n: number): Example[] {
  if (all.length <= n) return all;
  const pool = all.slice();
  for (let i = 0; i < n; i++) { const j = i + rng.int(pool.length - i); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

function runRaces(indices: number[], bundle: string): Promise<string[]> {
  const queue = indices.slice();
  const files = indices.map((i) => join(dir, `race${i}.bin`));
  const pass = ['km', 'sample', 'debris', 'wrecks', 'skill', 'seed'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));
  return Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      const at = i;
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/raceLabels.ts', '--in', bundle, '--race-only', String(at), '--out', files[indices.indexOf(at)], ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`race ${at} exited ${code}`))));
      });
    }
  })).then(() => files);
}

const load = (f: string) => { const b = readFileSync(f); return rowsToExamples(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), skill); };

/** Pit networks against the maneuver on these stop moments: pedal and steering error, and the share of its hard steering they miss. */
function scoreStops(moments: Array<{ who: number; example: Example }>): string {
  let n = 0, pedal = 0, steer = 0, hard = 0, miss = 0;
  const nets = new Map<number, Network>();
  for (const { who, example: e } of moments) {
    const net = nets.get(who) ?? nets.set(who, new Network(PIT_NET_LAYERS, adaptPitWeights(Float32Array.from(roster[who].pit.weights)))).get(who)!;
    const o = net.forward(e.x);
    n++; pedal += Math.abs(o[0] - e.y[0]); steer += Math.abs(o[1] - e.y[1]);
    // Hard across (a car short of its lane): missed if the network steers less than half as hard, or the other way.
    if (Math.abs(e.y[1]) > 0.3) { hard++; if (o[1] * Math.sign(e.y[1]) < 0.5 * Math.abs(e.y[1])) miss++; }
  }
  return `pedal err ${(pedal / Math.max(1, n)).toFixed(3)}, steer err ${(steer / Math.max(1, n)).toFixed(3)}, hard steering missed ${(100 * miss / Math.max(1, hard)).toFixed(0)}% of ${hard} (${n} moments)`;
}

/** Caution networks against their teachers on these moments: pedal error, and the share of braking they miss. */
function score(moments: Array<{ who: number; example: Example }>): string {
  let n = 0, pedal = 0, braking = 0, miss = 0;
  const nets = new Map<number, Network>();
  for (const { who, example: e } of moments) {
    if (e.x[CAUTION_FROM] === 0) continue;
    const net = nets.get(who) ?? nets.set(who, new Network(DRIVER_LAYERS, adaptWeights(Float32Array.from(roster[who].caution.weights)))).get(who)!;
    const o = net.forward(e.x);
    n++; pedal += Math.abs(o[0] - e.y[0]);
    if (e.y[0] < -0.3) { braking++; if (o[0] > -0.1) miss++; }
  }
  return `pedal err ${(pedal / Math.max(1, n)).toFixed(3)}, braking missed ${(100 * miss / Math.max(1, braking)).toFixed(0)}% (${n} moments)`;
}

const pool: Array<Array<{ who: number; example: Example }>> = [];
const t0 = Date.now();
for (let round = 0; round < rounds; round++) {
  const t1 = Date.now();
  const bundle = join(dir, `round${round}.json`);
  writeFileSync(bundle, JSON.stringify(file));
  const files = await runRaces(Array.from({ length: races }, (_, j) => round * races + j), bundle);
  const held = load(files[files.length - 1]);
  const before = skill === 'stops' ? scoreStops(held) : score(held);
  pool.push(files.slice(0, -1).flatMap(load));
  while (pool.length > keep) pool.shift();
  const all = pool.flat();
  if (skill === 'stops') {
    // Every driver on the whole field's stops.
    const stops = all.map((m) => m.example);
    roster.forEach((d) => {
      const w = adaptPitWeights(Float32Array.from(d.pit.weights));
      const before = w.slice();
      const loss = trainSupervised(PIT_NET_LAYERS, w, pick(stops, moments), epochs, 0.01, () => rng.next());
      d.pit.weights = Array.from(Number.isFinite(loss) && w.every(Number.isFinite) ? w : before);
    });
    // (A race's stops are too many moments to spread into push.)
    for (const m of held) pool[pool.length - 1].push(m);
    console.log(`round ${round}: ${stops.length} stop moments pooled; held-out race before ${before}; after ${scoreStops(held)} (${((Date.now() - t1) / 60000).toFixed(1)} min)`);
    writeFileSync(out, JSON.stringify(file));
    continue;
  }
  const pacing = all.filter((m) => m.example.x[CAUTION_FROM] !== 0).map((m) => m.example);
  const green = all.filter((m) => m.example.x[CAUTION_FROM] === 0).map((m) => m.example);
  // Every driver on the whole field's moments (a driver's own are too few: cautionFit.ts), half caution, half racing.
  roster.forEach((d) => {
    const w = adaptWeights(Float32Array.from(d.caution.weights));
    const before = w.slice();
    const loss = trainSupervised(DRIVER_LAYERS, w, [...pick(pacing, moments), ...pick(green, moments)], epochs, 0.01, () => rng.next());
    d.caution.weights = Array.from(Number.isFinite(loss) && w.every(Number.isFinite) ? w : before);
  });
  pool[pool.length - 1].push(...held);
  console.log(`round ${round}: ${pacing.length} caution moments pooled, ${green.length} racing; held-out race before ${before}; after ${score(held)} (${((Date.now() - t1) / 60000).toFixed(1)} min)`);
  writeFileSync(out, JSON.stringify(file));
}
rmSync(dir, { recursive: true, force: true });
console.log(`${roster.length} drivers -> ${out} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
