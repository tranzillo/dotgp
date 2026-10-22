/**
 * Road courses learned with a gradient (PPO), headless: an experiment beside
 * practice (ES). The policy starts from a brand-new driver's random wiring
 * (or a drivers file's road skill) and learns on the road-course curriculum.
 *
 *   npx tsx scripts/ppo.ts --out policy.json [--radius 80] [--fixed] [--iterations 300] [--seed 7]
 *     [--worlds 4] [--cars 6] [--seconds 30] [--eval-every 10] [--from drivers.json]
 *
 * --init blank: the brand-new driver's output layer starts near zero (its gas instinct kept), so its first
 * drives hold no random steering habit and practice's variation does the exploring.
 * --resume policy.json: carry on from an earlier run's output (policy, value, spread and stage).
 * --stall-ends: a car that stops ends its drive with nothing more to earn (default: the drive is cut short there).
 * --from drivers.json [--driver k]: start from driver k's road skill (default 0); --drivers-out: also write the
 *   file with that driver's skill replaced by the policy. --value-warmup N: the first N iterations train only the
 *   value estimate (for a policy that already drives). --keep-checkpoints: each evaluation also writes the
 *   drivers file with -i<iteration> before .json. --valid-laps: only valid laps count (default at full tightness).
 * --wear: drives start on tyres anywhere from worn to new, and any fuel load.
 * --recoveries X: this share of drives start slow, anywhere, pointing off the road's direction (getting going again).
 * --chicanes X: this share of drives start at the approach to a chicane (on circuits that have one).
 * --packs N: also N circuit racecraft drills per iteration (12-car packs, every other car the learner, the rest
 *   the --classmates file's road skills, default the --from file's); the radio's inputs train then too.
 *   --nerve: what fear costs the driver (default the middle). --worlds 0: packs only.
 * --radius: the stage to start at (the curriculum's tightest corner, m); --fixed: stay there.
 * Otherwise the corners tighten (as practice's do) once the policy, as it races, drives
 * half its evaluation drives cleanly with the stage's training wheels.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights, DRIVER_LAYERS } from '../src/ai/drivers';
import { randomWeights } from '../src/ai/mlp';
import { PpoLearner, type PpoOptions } from '../src/ai/ppo';
import { Rng } from '../src/ai/rng';
import { ROAD_FULL_RADIUS } from '../src/school/classroom';
import { packRollout, roadRollout, stageReport, type DriveStat } from '../src/school/ppoLesson';
import { ROADCRAFT_WEIGHTS } from '../src/school/roadcraftLesson';
import { initialRoadWeights, ROAD_WEIGHTS } from '../src/school/roadLesson';
import { hashSeed } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? '' : process.argv[++i]);
}
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const outFile = args.get('out');
if (!outFile) throw new Error('--out policy.json');
const seed = num('seed', 7);
const iterations = num('iterations', 300);
const worlds = num('worlds', 4), cars = num('cars', 6), seconds = num('seconds', 30);
const evalEvery = num('eval-every', 10);
const fixed = args.has('fixed');
const resume = args.has('resume') ? JSON.parse(readFileSync(args.get('resume')!, 'utf8')) : null;
let radius = num('radius', resume?.radius ?? 80);
const stallEnds = args.has('stall-ends');
const warmup = num('value-warmup', 0);
const driversOut = args.get('drivers-out');
const packs = num('packs', 0);
const classmatesFile = args.get('classmates') ?? args.get('from');
type FileDriver = { weights: number[]; roadCourse?: { weights: number[]; style?: { grip: number; margin: number } } };
/** What a driver knows of circuits: its style's line (if it has a style), else the usual. */
const knowledgeOf = (d: FileDriver) => (d.roadCourse?.style ? { grip: d.roadCourse.style.grip, margin: d.roadCourse.style.margin } : undefined);
const mates: FileDriver[] = packs && classmatesFile ? JSON.parse(readFileSync(classmatesFile, 'utf8')).drivers : [];
const classmates = mates.map((d) => adaptWeights(Float32Array.from(d.roadCourse?.weights ?? d.weights)));
const classmateKnowledge = mates.map(knowledgeOf);
const knowledge = args.get('from') ? knowledgeOf(JSON.parse(readFileSync(args.get('from')!, 'utf8')).drivers[num('driver', 0)]) : undefined;
if (packs && !classmates.length) throw new Error('--packs needs --from or --classmates');
const ppo: Partial<PpoOptions> = {};
for (const k of ['gamma', 'lambda', 'clip', 'epochs', 'minibatch', 'policyLr', 'valueLr', 'entropy', 'targetKl'] as const) {
  if (args.has(k)) ppo[k] = Number(args.get(k));
}

// The value estimate's hidden layers (--value-hidden 64,64): most of an update's cost.
const VALUE_LAYERS = [DRIVER_LAYERS[0], ...(args.get('value-hidden') ?? '64,64').split(',').map(Number), 1];
const rng = new Rng(hashSeed(seed, 'ppo'));
const from = args.get('from');
const policy = resume ? Float32Array.from(resume.weights) : from
  ? adaptWeights(Float32Array.from(JSON.parse(readFileSync(from, 'utf8')).drivers[num('driver', 0)].roadCourse.weights))
  : initialRoadWeights(new Rng(hashSeed(seed, 'init')));
if (!from && !resume && args.get('init') === 'blank') {
  const nOut = DRIVER_LAYERS[DRIVER_LAYERS.length - 1], nIn = DRIVER_LAYERS[DRIVER_LAYERS.length - 2];
  for (let o = 0; o < nOut; o++) {
    const row = policy.length - (nOut - o) * (nIn + 1);
    for (let k = 1; k <= nIn; k++) policy[row + k] *= 0.01;
  }
}
const learner = new PpoLearner(
  DRIVER_LAYERS, policy, VALUE_LAYERS, resume ? Float32Array.from(resume.value) : randomWeights(VALUE_LAYERS, () => rng.gaussian(), 0.1),
  ppo, num('std', 0.3), packs ? ROADCRAFT_WEIGHTS : ROAD_WEIGHTS,
);
if (resume) learner.logStd.set(resume.logStd);

const log = console.log;
console.log = () => {}; // the generator's chatter
const started = Date.now();
const recent: DriveStat[] = [];
for (let it = 1; it <= iterations; it++) {
  const t0 = Date.now();
  const solo = roadRollout(learner, { radius, stallEnds, chicanes: num('chicanes', 0), recoveries: num('recoveries', 0), wear: args.has('wear'), knowledge, validLaps: args.has('valid-laps') || radius <= ROAD_FULL_RADIUS }, hashSeed(seed, `it${it}`), worlds, cars, seconds);
  const pack = packs ? packRollout(learner, hashSeed(seed, `pack${it}`), packs, classmates, args.has('nerve') ? num('nerve', 0.5) : undefined, undefined, knowledge, classmateKnowledge) : null;
  const segments = pack ? [...solo.segments, ...pack.segments] : solo.segments;
  const drives = solo.drives;
  const t1 = Date.now();
  const stats = learner.update(segments, rng, it > warmup);
  const t2 = Date.now();
  recent.push(...drives);
  if (recent.length > 100) recent.splice(0, recent.length - 100);
  const share = (f: (d: DriveStat) => boolean) => recent.length ? recent.filter(f).length / recent.length : 0;
  const perSecond = (segs: typeof segments) => {
    let r = 0, n = 0;
    for (const sg of segs) for (const x of sg.steps) { r += x.r; n++; }
    return n ? r / (n * 4 / 120) : 0;
  };
  const reward = perSecond(solo.segments);
  log(`it ${it} r${radius.toFixed(0)}: ${reward.toFixed(3)} s/s${pack ? ` (packs ${perSecond(pack.segments).toFixed(3)}, crashed ${pack.drives.filter((d) => d.crashed).length}/${pack.drives.length})` : ''}, drives crash ${pct(share((d) => d.crashed))} stop ${pct(share((d) => d.stopped))}`
    + ` lap ${pct(share((d) => d.laps >= 1))}; kl ${stats.kl.toFixed(4)} clip ${pct(stats.clipFraction)} ev ${stats.explainedVariance.toFixed(2)}`
    + ` std ${stats.std.map((s) => s.toFixed(2)).join('/')} ep ${stats.epochs} (${((t1 - t0) / 1000).toFixed(1)}+${((t2 - t1) / 1000).toFixed(1)} s)`);
  if (it % evalEvery === 0 || it === iterations) {
    const w = stageReport(learner.policy.weights, radius, hashSeed(seed, `eval${it}`), 16, true, knowledge);
    const real = stageReport(learner.policy.weights, radius, hashSeed(seed, `eval${it}`), 16, false, knowledge);
    log(`  eval at ${radius.toFixed(0)} m — wheels: ${w.laps.toFixed(2)} laps, ${pct(w.clean)} clean, ${pct(w.stopped)} stopped`
      + ` | real: ${real.laps.toFixed(2)} laps, ${pct(real.clean)} clean, ${pct(real.stopped)} stopped (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    if (!fixed && w.clean >= 0.5 && radius > ROAD_FULL_RADIUS) {
      radius = Math.max(ROAD_FULL_RADIUS, radius * 0.9);
      log(`  corners tighten: down to ${radius.toFixed(0)} m`);
    }
    writeFileSync(outFile, JSON.stringify({
      radius, iteration: it, weights: Array.from(learner.policy.weights), logStd: Array.from(learner.logStd),
      value: Array.from(learner.value.weights),
    }));
    if (from && driversOut) {
      const file = JSON.parse(readFileSync(from, 'utf8'));
      const d = file.drivers[num('driver', 0)];
      d.roadCourse = { ...d.roadCourse, weights: Array.from(learner.policy.weights), radius };
      writeFileSync(driversOut, JSON.stringify(file));
      if (args.has('keep-checkpoints')) writeFileSync(driversOut.replace(/\.json$/, `-i${it}.json`), JSON.stringify(file));
    }
  }
}

function pct(x: number): string {
  return `${Math.round(100 * x)}%`;
}
