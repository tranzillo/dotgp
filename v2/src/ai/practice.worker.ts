/// <reference lib="webworker" />
import { PRESETS, presetTrack } from '../trackgen';
import { ChiefTrainer } from './chiefTraining';
import { adaptWeights } from './drivers';
import { EsTrainer } from './es';

export type PracticeRequest =
  | {
    type: 'start';
    seed: number;
    traffic: boolean;
    /** The whole field's drivers, in roster order. Unlicensed drivers go to rookie school. */
    drivers: Array<{ weights: number[]; rounds: number; licensed: boolean }>;
    /** Learned crew chiefs in the field (scripted ones don't practise). index = roster position. */
    chiefs: Array<{ index: number; weights: number[]; rounds: number }>;
  }
  | { type: 'stop' };

export interface PracticeRound {
  type: 'round';
  round: number;
  damageScale: number;
  elapsedMs: number;
  /** Only the drivers that practised this round; index = roster position. */
  drivers: Array<{
    index: number; fitness: number; rounds: number; weights: Float32Array; bestLaps: number[];
    licensed: boolean; rookie: boolean; graduated: boolean;
  }>;
  /** Crew chiefs that ran a strategy race this round, if any. */
  chiefs: Array<{ index: number; rounds: number; weights: Float32Array; relativeTime: number }>;
}

/** A crew chief strategy round runs every few driver rounds (they cost more). */
const CHIEF_EVERY = 3;

const tracks = Object.keys(PRESETS).map(presetTrack);
let trainer: EsTrainer | null = null;
let chiefTrainer: ChiefTrainer | null = null;
let chiefIndex: number[] = [];
let running = false;

self.onmessage = (e: MessageEvent<PracticeRequest>) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    running = false;
    return;
  }
  trainer = new EsTrainer(tracks, {
    lineages: msg.drivers.length,
    seed: msg.seed,
    traffic: msg.traffic,
    // Traffic heats are pricier per sample but cleaner: fewer, shorter ones.
    pairs: msg.traffic ? 8 : 16,
    trialSeconds: msg.traffic ? 60 : 80,
    // Licensed drivers fine-tune gently; rookie school uses its own faster settings.
    learningRate: 0.01,
  });
  trainer.loadDrivers(msg.drivers.map((d) => ({ weights: Float32Array.from(d.weights), rounds: d.rounds, licensed: d.licensed })));

  chiefIndex = msg.chiefs.map((c) => c.index);
  chiefTrainer = null;
  // Strategy races need cars that can actually lap: licensed drivers only.
  const driverWeights = msg.drivers.filter((d) => d.licensed).map((d) => adaptWeights(Float32Array.from(d.weights)));
  if (msg.chiefs.length && driverWeights.length) {
    chiefTrainer = new ChiefTrainer(tracks, driverWeights, {
      lineages: msg.chiefs.length, seed: msg.seed ^ 0x9e3779b9, sigma: 0.05, learningRate: 0.01,
    });
    chiefTrainer.loadChiefs(msg.chiefs.map((c) => ({ weights: Float32Array.from(c.weights), rounds: c.rounds })));
  }
  if (!running) {
    running = true;
    void loop();
  }
};

async function loop(): Promise<void> {
  while (running && trainer) {
    const t = trainer;
    const report = t.step();
    const chiefs: PracticeRound['chiefs'] = [];
    if (chiefTrainer && report.round % CHIEF_EVERY === CHIEF_EVERY - 1) {
      const ct = chiefTrainer;
      const cr = ct.step();
      for (const l of cr.lineages) {
        chiefs.push({ index: chiefIndex[l.lineage], rounds: ct.chiefs[l.lineage].rounds, weights: ct.chiefs[l.lineage].weights.slice(), relativeTime: l.relativeTime });
      }
    }
    const out: PracticeRound = {
      type: 'round',
      round: report.round,
      damageScale: report.damageScale,
      elapsedMs: report.elapsedMs,
      drivers: report.lineages.map((l) => ({
        index: l.lineage,
        fitness: l.fitness,
        rounds: t.drivers[l.lineage].rounds,
        weights: t.drivers[l.lineage].weights.slice(),
        bestLaps: l.results.map((r) => r.bestLap),
        licensed: l.licensed,
        rookie: l.rookie,
        graduated: l.graduated,
      })),
      chiefs,
    };
    self.postMessage(out);
    await new Promise((r) => setTimeout(r, 0)); // let 'stop' messages through
  }
}
