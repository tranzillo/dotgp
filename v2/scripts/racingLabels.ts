/**
 * Race labelling for the oval racing skill: each round the stable races itself on the apprenticeship's ovals (every
 * car a student with all its skills), each car's own teacher labelling from where it is (src/school/raceLabels.ts),
 * and every driver drives solo on those ovals, its teacher answering as in DAgger (ovalApprentice.ts soloDrives).
 * Each driver's racing network then trains on half solo moments (its own: where to brake for the corner, the fast
 * line) and half racing moments (green, sound car): its own and the field's (--field-share of them), pooled over the
 * last --keep rounds. The round's last race is held out of that round's training (and of its solo drives) and scores
 * the racing networks before and after it. Caution, pit, broken-car and tactics networks are kept.
 *
 * Why (2026-11-01, experiments/2026-11-01-takeover-crossing-rate): the apprenticeship races 4-8 students in a field of
 * teachers; one fine-tune on the field's racing moments (v8rf) took green wall damage to near the teachers' zero on
 * every oval, but trained on race moments alone it was slower on the speedways and raced less side by side.
 *
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/racingLabels.ts --in stable.json --out labelled.json
 *     [--rounds 4] [--races 8] [--km 80] [--sample 0.05] [--per-race 20000] [--per-solo 30000] [--keep 8] [--field-share 0.5]
 *     [--epochs 4] [--moments 60000] [--debris 0.03] [--wrecks 0.5] [--seed 1] [--jobs N] [--lead 1] [--brake-weight 1]
 *   --lead 1: every moment labelled with what the teacher says when the student's command lands (its latency later:
 *     src/school/recorder.ts RecorderOptions.lead), races and solo drives alike.
 *   --brake-weight w: a racing moment whose teacher brakes (pedal under -0.3) is drawn w times as often as another.
 *   npx tsx scripts/racingLabels.ts --in stable.json --race-only <index> --out rows.bin ...   (one race: what the parent runs)
 *   npx tsx scripts/racingLabels.ts --in stable.json --solo-only <index> --out rows.bin ...   (every driver's solo drives on that oval)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptWeights, CAUTION_FROM, DAMAGE_FROM, DRIVER_LAYERS } from '../src/ai/drivers';
import { Network, trainSupervised, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { apprenticeTrack, soloDrives, type StableDriver } from '../src/school/ovalApprentice';
import { labelledRace, ROW, rowsToExamples, type RaceDriver } from '../src/school/raceLabels';
import { setLeadLabels } from '../src/school/recorder';
import { hashSeed } from '../src/trackgen/generator';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const num = (k: string, d: number) => Number(args.get(k) ?? d);
const seed = num('seed', 1);
/** The apprenticeship's ovals, past where raceLabels.ts's (1000+) and racingFit's dumps (2000-2007) are. */
const trackOf = (index: number) => apprenticeTrack(3000 + index, seed);

if (args.has('race-only') || args.has('solo-only')) {
  const roster: RaceDriver[] = JSON.parse(readFileSync(args.get('in')!, 'utf8')).drivers;
  const t0 = Date.now();
  setLeadLabels(num('lead', 0) > 0);
  if (args.has('race-only')) {
    const index = Number(args.get('race-only'));
    const track = trackOf(index);
    const r = labelledRace(track, roster, hashSeed(seed, `race${index}`) % 1000, {
      km: num('km', 80), sample: num('sample', 0.05), debris: num('debris', 0.03), wrecks: num('wrecks', 0.5),
    });
    writeFileSync(args.get('out')!, Buffer.from(r.rows.buffer, r.rows.byteOffset, r.rows.byteLength));
    console.log(`race ${index} (${track.length.toFixed(0)} m): ${r.out} out, ${r.cautions} cautions, ${r.green} racing moments (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } else {
    const index = Number(args.get('solo-only'));
    const track = trackOf(index);
    const students: StableDriver[] = roster.map((d) => ({
      lineage: d.lineage, nerve: d.nerve, talent: d.talent, limits: d.limits, weights: adaptWeights(Float32Array.from(d.weights)),
      caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : null, tactics: d.tactics ? Float32Array.from(d.tactics.weights) : null,
    }));
    const examples: Example[][] = students.map(() => []);
    const crashed = soloDrives(track, students, { kind: 'student' }, examples, new Rng(hashSeed(seed, `solo${index}`)), index, seed);
    const n = examples.reduce((a, e) => a + e.length, 0);
    const rows = new Float32Array(n * ROW);
    let o = 0;
    examples.forEach((list, who) => {
      for (const e of list) {
        rows[o] = who;
        rows.set(e.x.subarray(0, DRIVER_LAYERS[0]), o + 1);
        rows[o + ROW - 2] = e.y[0];
        rows[o + ROW - 1] = e.y[1];
        o += ROW;
      }
    });
    writeFileSync(args.get('out')!, Buffer.from(rows.buffer));
    console.log(`solo ${index} (${track.length.toFixed(0)} m): ${n} moments, ${crashed} of ${3 * students.length} drives crashed (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  process.exit(0);
}

const input = args.get('in')!, out = args.get('out') ?? 'labelled.json';
const rounds = num('rounds', 4), races = num('races', 8), keep = num('keep', 8), epochs = num('epochs', 4), moments = num('moments', 60_000);
const perRace = num('per-race', 20_000), perSolo = num('per-solo', 30_000), fieldShare = num('field-share', 0.5);
const brakeWeight = Math.max(1, Math.round(num('brake-weight', 1)));
const jobs = num('jobs', Math.max(1, cpus().length - 1));
const file = JSON.parse(readFileSync(input, 'utf8'));
const roster: RaceDriver[] = file.drivers;
const dir = mkdtempSync(join(tmpdir(), 'racing-labels-'));
const rng = new Rng(hashSeed(seed, 'racing labels training'));
/** n of them at random (all, if there are no more). */
function pick<T>(all: T[], n: number): T[] {
  if (all.length <= n) return all.slice();
  const pool = all.slice();
  for (let i = 0; i < n; i++) { const j = i + rng.int(pool.length - i); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

/** One child per race or solo set, `jobs` at a time. */
function runAll(tasks: Array<{ kind: 'race' | 'solo'; index: number; file: string }>, bundle: string): Promise<void> {
  const queue = tasks.slice();
  const pass = ['km', 'sample', 'debris', 'wrecks', 'seed', 'lead'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));
  return Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      const task = t;
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/racingLabels.ts', '--in', bundle, `--${task.kind}-only`, String(task.index), '--out', task.file, ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${task.kind} ${task.index} exited ${code}`))));
      });
    }
  })).then(() => undefined);
}

type Moment = { who: number; example: Example };
/** A file's moments; racing ones only (green, sound car), at most `max` of them, copied out of the file's buffer. */
function load(f: string, racingOnly: boolean, max = Infinity): Moment[] {
  const b = readFileSync(f);
  let all = rowsToExamples(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
  if (racingOnly) all = all.filter((m) => m.example.x[CAUTION_FROM] === 0 && m.example.x[DAMAGE_FROM] === 0);
  return pick(all, max).map((m) => ({ who: m.who, example: { x: m.example.x.slice(), y: m.example.y.slice(), mask: m.example.mask } }));
}

/** Racing networks against their teachers on these moments: pedal error, braking missed, steering error. */
function score(set: Moment[]): string {
  let n = 0, pedal = 0, braking = 0, miss = 0, steer = 0;
  const nets = new Map<number, Network>();
  for (const { who, example: e } of set) {
    const net = nets.get(who) ?? nets.set(who, new Network(DRIVER_LAYERS, adaptWeights(Float32Array.from(roster[who].weights)))).get(who)!;
    const o = net.forward(e.x);
    n++; pedal += Math.abs(o[0] - e.y[0]); steer += Math.abs(o[1] - e.y[1]);
    if (e.y[0] < -0.3) { braking++; if (o[0] > -0.1) miss++; }
  }
  const d = Math.max(1, n);
  return `pedal err ${(pedal / d).toFixed(3)}, braking missed ${(100 * miss / Math.max(1, braking)).toFixed(0)}%, steer err ${(steer / d).toFixed(3)} (${n})`;
}

/** Per round: the field's racing moments, and each driver's solo moments. */
const racingPool: Moment[][] = [], soloPool: Moment[][] = [];
const t0 = Date.now();
for (let round = 0; round < rounds; round++) {
  const t1 = Date.now();
  const bundle = join(dir, `round${round}.json`);
  writeFileSync(bundle, JSON.stringify(file));
  const raceIdx = Array.from({ length: races }, (_, j) => round * races + j);
  const tasks = [
    ...raceIdx.map((index) => ({ kind: 'race' as const, index, file: join(dir, `race${index}.bin`) })),
    // Solo drives on the round's ovals but the held-out race's.
    ...raceIdx.slice(0, -1).map((index) => ({ kind: 'solo' as const, index, file: join(dir, `solo${index}.bin`) })),
  ];
  await runAll(tasks, bundle);
  const raceFiles = tasks.filter((t) => t.kind === 'race').map((t) => t.file);
  const held = load(raceFiles[raceFiles.length - 1], true);
  const before = score(held);
  racingPool.push(raceFiles.slice(0, -1).flatMap((f) => load(f, true, perRace)));
  soloPool.push(tasks.filter((t) => t.kind === 'solo').flatMap((t) => load(t.file, false, perSolo)));
  while (racingPool.length > keep) { racingPool.shift(); soloPool.shift(); }
  const field = racingPool.flat(), solo = soloPool.flat();
  const ownRacing = new Map<number, Example[]>(), ownSolo = new Map<number, Example[]>();
  // (A braking moment goes in brakeWeight times: drawn that much more often.)
  const weighted = field.flatMap((m) => Array<Moment>(m.example.y[0] < -0.3 ? brakeWeight : 1).fill(m));
  for (const m of weighted) (ownRacing.get(m.who) ?? ownRacing.set(m.who, []).get(m.who)!).push(m.example);
  for (const m of solo) (ownSolo.get(m.who) ?? ownSolo.set(m.who, []).get(m.who)!).push(m.example);
  const fieldExamples = weighted.map((m) => m.example);
  const half = Math.floor(moments / 2);
  const losses: number[] = [];
  roster.forEach((d, who) => {
    const own = pick(ownRacing.get(who) ?? [], Math.round(half * (1 - fieldShare)));
    const data = [...pick(ownSolo.get(who) ?? [], half), ...own, ...pick(fieldExamples, half - own.length)];
    const w = adaptWeights(Float32Array.from(d.weights));
    const keepW = w.slice();
    const loss = trainSupervised(DRIVER_LAYERS, w, data, epochs, 0.01, () => rng.next());
    const ok = Number.isFinite(loss) && w.every(Number.isFinite);
    d.weights = Array.from(ok ? w : keepW);
    if (ok) losses.push(loss);
  });
  // Next round the held-out race's moments are training moments like the rest.
  racingPool[racingPool.length - 1].push(...pick(held, perRace));
  const meanLoss = losses.reduce((a, b) => a + b, 0) / Math.max(1, losses.length);
  console.log(`round ${round}: ${field.length} racing moments pooled, ${solo.length} solo; loss ${meanLoss.toFixed(4)}; held-out race before ${before}; after ${score(held)} (${((Date.now() - t1) / 60000).toFixed(1)} min)`);
  writeFileSync(out, JSON.stringify(file));
}
rmSync(dir, { recursive: true, force: true });
console.log(`${roster.length} drivers -> ${out} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
