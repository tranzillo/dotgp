/**
 * The stable's caution practice: learning cautions by how they turn out.
 *
 * Copying the traffic racer works for racing but not for cautions: under
 * caution its driving comes from the formation's rules, full of thresholds
 * (near your place or not, ahead of it by a line's spacing or not, in a
 * file or not), and a small smooth network can't copy a jump; near one it
 * averages, which is where a student off its line always is. So once a
 * student has copied what it can, it practises: evolution strategies on its
 * caution skill (the network that drives while the field is pacing, so its
 * racing can't change), in caution drills (a debris caution, the line forming,
 * the restart) among classmates driving their own cautions, no script in the
 * field. Every variation of a student drives the same drill from the same
 * slot among the same classmates, so they're compared fairly; the drill's
 * score is the caution lesson's (place and lane in line, passes under
 * caution, damage taken and done, getting going at the green).
 */
import { centeredRanks, adamStep, type AdamState } from '../ai/es';
import { NeuralDriver, Team } from '../ai/drivers';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { hashSeed } from '../trackgen';
import { CautionDrill, cleanCaution, DRILL_FIELD, type CautionResult } from './cautionLesson';
import { apprenticeTrack, type StableDriver } from './ovalApprentice';

export interface CautionPracticeOptions {
  rounds?: number;
  /** Antithetic pairs per student per round. */
  pairs?: number;
  sigma?: number;
  learningRate?: number;
  /** Share of drills that begin mid-race with the field strung out round the lap (the rest: a bunched field). */
  spread?: number;
  onRound?: (round: number, report: { mean: number; clean: number; harm: number; seconds: number }) => void;
}

/** A stable driver in a drill, driving its own cautions (its caution skill, or the one given), with its human limits. */
function stableTeam(d: StableDriver, seed: number, caution?: Float32Array): Team {
  const driver = new NeuralDriver(d.weights, undefined, undefined, { limits: { ...d.limits, seed }, caution: caution ?? d.caution ?? undefined });
  return new Team(driver, new TowerSpotter(), null, false, true);
}

/** Practise a group of students' cautions (their caution networks trained in place) among the stable. */
export function practiseCautions(students: StableDriver[], stable: StableDriver[], seed: number, options: CautionPracticeOptions = {}): void {
  const { rounds = 40, pairs = 4, sigma = 0.02, learningRate = 0.01, spread = 0.5 } = options;
  const rng = new Rng(hashSeed(seed, 'cautions'));
  const states: AdamState[] = students.map((d) => {
    d.caution ??= d.weights.slice();
    return { weights: d.caution, m: new Float32Array(d.caution.length), v: new Float32Array(d.caution.length), adamSteps: 0 };
  });
  for (let round = 0; round < rounds; round++) {
    const t0 = Date.now();
    const track = apprenticeTrack(round, seed);
    let sum = 0, clean = 0, harm = 0, n = 0;
    students.forEach((d, s) => {
      const slot = rng.int(DRILL_FIELD);
      const spreadSeed = rng.next() < spread ? hashSeed(seed, `spread${round}:${s}`) : undefined;
      // The same classmates for every variation (drawn from the rest of the stable).
      const others = stable.filter((o) => o.lineage !== d.lineage);
      const pack = Array.from({ length: DRILL_FIELD }, () => others[rng.int(others.length)]);
      const handsSeed = hashSeed(seed, `hands${round}:${d.lineage}`);
      const base = states[s].weights;
      const eps = Array.from({ length: pairs }, () => Float32Array.from({ length: base.length }, () => rng.gaussian()));
      const results: CautionResult[] = [];
      for (const e of eps) {
        for (const sign of [1, -1]) {
          const candidate = base.map((w, i) => w + sign * sigma * e[i]);
          const drill = new CautionDrill(track, slot, (k) => (k === slot
            ? stableTeam(d, handsSeed, candidate)
            : stableTeam(pack[k], hashSeed(handsSeed, `pack${k}`))), spreadSeed);
          while (!drill.done) drill.step();
          results.push(drill.result());
        }
      }
      const ranks = centeredRanks(results.map((r) => r.fitness));
      const grad = new Float32Array(base.length);
      eps.forEach((e, p) => {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        for (let i = 0; i < grad.length; i++) grad[i] += w * e[i];
      });
      adamStep(states[s], grad, 1 / (2 * pairs * sigma), learningRate, 0);
      for (const r of results) { sum += r.fitness; clean += cleanCaution(r) ? 1 : 0; harm += r.harm; n++; }
    });
    options.onRound?.(round, { mean: sum / n, clean: clean / n, harm: harm / n, seconds: (Date.now() - t0) / 1000 });
  }
}
