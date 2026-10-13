/**
 * Train crew chiefs in strategy races, benchmarking against the scripted
 * strategist on a fixed set of races every few rounds.
 *
 *   npx tsx scripts/chiefs.ts --rounds 200 --drivers public/drivers/default.json [--from runs/chiefs-...json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ChiefTrainer, runStrategyRace, type StrategyRaceConditions } from '../src/ai/chiefTraining';
import { adaptWeights } from '../src/ai/drivers';
import { trainSupervised, type Example } from '../src/ai/network';
import { ApprenticeRecorder, CHIEF_LAYERS, initialChiefWeights, NeuralCrewChief } from '../src/ai/neuralChief';
import { StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track } from '../src/sim/track';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);

const tracks = [new Track(SPEEDWAY), new Track(SHORT_TRACK), new Track(FLAT_TRACK)];
const driverFile = JSON.parse(readFileSync(args.get('drivers') ?? 'public/drivers/default.json', 'utf8'));
const drivers: Float32Array[] = (driverFile.drivers ?? driverFile.champions).map((d: { weights: number[] }) => adaptWeights(Float32Array.from(d.weights)));
/** The veteran: a sensible scripted strategy, used as benchmark and as the apprentices' teacher. */
const SCRIPTED = { fuelMarginLaps: 1.2, tireLimit: 0.45, repairBelow: 0.7, minLapsForTires: 6 };
const trainer = new ChiefTrainer(tracks, drivers, {
  seed: num('seed', 1),
  lineages: num('lineages', 4),
  pairs: num('pairs', 8),
  sigma: num('sigma', 0.1),
  learningRate: num('lr', 0.03),
});
/**
 * Apprenticeship: record a veteran (scripted) crew chief's calls across many
 * strategy races, train a network to imitate them, then let every lineage
 * start from that apprentice (with a little individual variation).
 */
if (args.has('apprentice')) {
  const races = num('apprentice', 60);
  const rng = new Rng(num('seed', 1) + 99);
  const examples: Example[] = [];
  for (let k = 0; k < races; k++) {
    const track = tracks[rng.int(tracks.length)];
    const cond = { track, laps: 15 + rng.int(31), pace: 3 + rng.next() * 5 };
    // One consistent veteran, so the apprentice learns a coherent strategy.
    const recorders = drivers.map(() => new ApprenticeRecorder(new StrategistCrewChief(SCRIPTED)));
    runStrategyRace(cond, drivers.map((driver, i) => ({ driver, chief: recorders[i], damage: rng.next() < 0.25 ? 0.2 + rng.next() * 0.4 : 0 })));
    for (const r of recorders) examples.push(...r.examples);
  }
  // Pit calls are rare; weight them up so "never pit" isn't the easy answer.
  const pits = examples.filter((e) => e.y[0] > 0).length;
  const weight = Math.min(12, (examples.length - pits) / Math.max(1, pits));
  for (const e of examples) if (e.y[0] > 0) for (let i = 0; i < 4; i++) e.mask[i] *= i === 0 ? weight : 1;
  const w = initialChiefWeights(rng);
  const loss = trainSupervised(CHIEF_LAYERS, w, examples, num('epochs', 150), num('bclr', 0.01), () => rng.next());
  console.log(`apprentice: ${examples.length} decisions (${pits} pit calls, weight ${weight.toFixed(1)}) from ${races} races, loss ${loss.toFixed(4)}`);
  trainer.loadChiefs(trainer.chiefs.map((_, l) => {
    const copy = w.slice();
    if (l > 0) for (let i = 0; i < copy.length; i++) copy[i] += rng.gaussian() * 0.03;
    return { weights: copy, rounds: 0 };
  }));
}
if (args.has('from')) {
  const saved = JSON.parse(readFileSync(args.get('from')!, 'utf8'));
  trainer.loadChiefs(saved.chiefs.map((c: { weights: number[]; rounds: number }) => ({ weights: Float32Array.from(c.weights), rounds: c.rounds })));
}

// Fixed benchmark: every track at two distances, at 4x race pace.
const bench: StrategyRaceConditions[] = tracks.flatMap((track) => [20, 40].map((laps) => ({ track, laps, pace: 4 })));

function benchmark(): string {
  let scriptedTotal = 0;
  const learnedTotal = trainer.chiefs.map(() => 0);
  const learnedStops = trainer.chiefs.map(() => 0);
  let dnfs = 0;
  for (const cond of bench) {
    const entries = [
      ...drivers.map((driver) => ({ driver, chief: new StrategistCrewChief(SCRIPTED), damage: 0 })),
      ...trainer.chiefs.flatMap((c) => drivers.map((driver) => ({ driver, chief: new NeuralCrewChief(c.weights), damage: 0 }))),
    ];
    const res = runStrategyRace(cond, entries);
    const n = drivers.length;
    scriptedTotal += res.slice(0, n).reduce((a, r) => a + r.time, 0) / n;
    trainer.chiefs.forEach((_, l) => {
      const mine = res.slice(n + l * n, n + (l + 1) * n);
      learnedTotal[l] += mine.reduce((a, r) => a + r.time, 0) / n;
      learnedStops[l] += mine.reduce((a, r) => a + r.stops, 0) / n;
      dnfs += mine.filter((r) => !r.finished).length;
    });
  }
  const rel = learnedTotal.map((t, l) => {
    const pct = (t / scriptedTotal - 1) * 100;
    return `C${l} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${(learnedStops[l] / bench.length).toFixed(1)} stops)`;
  });
  return `race time vs scripted (lower is better): ${rel.join('  ')}  learned DNFs ${dnfs}`;
}

const rounds = num('rounds', 200);
const every = num('every', 20);
console.log(`chief training: ${trainer.config.lineages} lineages, ${trainer.config.pairs} pairs, ${drivers.length} drivers`);
console.log(`round 0 benchmark ${benchmark()}`);
for (let r = 0; r < rounds; r++) {
  const rep = trainer.step();
  if ((r + 1) % every === 0) {
    const c = rep.conditions;
    console.log(`round ${r + 1} (${(rep.elapsedMs / 1000).toFixed(1)}s, last race ${c.trackLength.toFixed(0)}m x${c.laps} @${c.pace.toFixed(1)}x) ${benchmark()}`);
  }
}
mkdirSync('runs', { recursive: true });
const out = `runs/chiefs-seed${trainer.config.seed}-r${trainer.round}.json`;
writeFileSync(out, JSON.stringify({ round: trainer.round, chiefs: trainer.chiefs.map((c) => ({ lineage: c.lineage, rounds: c.rounds, weights: Array.from(c.weights) })) }));
console.log(`saved chiefs -> ${out}`);
