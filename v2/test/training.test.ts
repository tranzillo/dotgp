import { describe, expect, it } from 'vitest';
import { initialWeights } from '../src/ai/es';
import { Trial, type TrialOptions } from '../src/ai/evaluate';
import { genomeSize, Network, trainSupervised, type Example } from '../src/ai/network';
import { Centerline } from '../src/sim/centerline';
import { Rng } from '../src/ai/rng';
import { Classroom, type ClassSpec, type GhostRunner, type RoadcraftRound } from '../src/school/classroom';
import { roadcraftDrill } from '../src/school/roadcraftLesson';
import type { TrackLayout } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { generateLayout, PRESETS, presetLayout } from '../src/trackgen';

/** Headless training's speed-ups must not change what drivers learn. */

/** A round split into parts the way the worker pool splits it, all on this thread. */
const splitRunner = (parts: number): GhostRunner => async (layout: TrackLayout, genomes: Float32Array[], opts: TrialOptions) => {
  const track = new Track(layout);
  const per = Math.ceil(genomes.length / parts);
  const trials = Array.from({ length: parts }, (_, i) => new Trial(track, genomes.slice(i * per, (i + 1) * per), opts));
  for (const t of trials) while (!t.done) t.step();
  const until = Math.max(...trials.map((t) => t.stepsRun));
  for (const t of trials) t.continueTo(until);
  return { results: trials.flatMap((t) => t.results()), time: trials[0].world.time };
};

describe('headless training', () => {
  it('drives a road-course round split into parts exactly as in one world', async () => {
    const spec = (): ClassSpec => ({
      lesson: 'circuits', presets: Object.keys(PRESETS).map(presetLayout), seed: 5,
      // Untrained drivers crash and stall at different times, so parts end at different steps; already apprenticed.
      students: [0, 1].map((k) => ({ key: k, id: `D${k}`, name: `D${k}`, weights: initialWeights(new Rng(k + 1)), rounds: 1, licensed: true })),
    });
    const one = new Classroom(spec());
    const split = new Classroom(spec());
    expect(split.runnerRounds).toBe(true);
    for (let round = 0; round < 2; round++) {
      while (one.round === round) one.step();
      await split.runRound({ ghost: splitRunner(3), roadcraft: () => { throw new Error('no drills here'); } });
    }
    const a = one.takeReports(), b = split.takeReports();
    expect(b.map((r) => [r.fitness, r.laps, r.health])).toEqual(a.map((r) => [r.fitness, r.laps, r.health]));
    split.students.forEach((s, k) => expect(Array.from(s.weights)).toEqual(Array.from(one.students[k].weights)));
    expect(split.time).toBeCloseTo(one.time, 9);
  });

  it('runs a circuit racecraft round through a runner exactly as in one thread', async () => {
    const spec = (): ClassSpec => ({
      lesson: 'roadcraft', presets: Object.keys(PRESETS).map(presetLayout), seed: 9, practice: { pairs: 2 },
      students: [0, 1].map((k) => ({ key: k, id: `D${k}`, name: `D${k}`, weights: initialWeights(new Rng(k + 3)), rounds: 1, licensed: true, roadLicensed: true })),
    });
    const one = new Classroom(spec()), split = new Classroom(spec());
    expect(split.runnerRounds).toBe(true);
    // Drills built one by one as the pool's workers build them; the solo anchor split into parts.
    const runner = {
      ghost: splitRunner(2),
      roadcraft: async (r: RoadcraftRound) => {
        const track = new Track(r.layout);
        const drills = r.candidates.map((g, i) => roadcraftDrill(track, r.slot, g, Math.floor(i / r.perStudent), r.classmates, r.pack, r.nerves[Math.floor(i / r.perStudent)]));
        for (const d of drills) while (!d.done) d.step();
        return { results: drills.map((d) => d.result()), time: drills[0].world.time };
      },
    };
    while (one.round === 0) one.step();
    await split.runRound(runner);
    split.students.forEach((s, k) => expect(Array.from(s.weights)).toEqual(Array.from(one.students[k].weights)));
    expect(split.takeReports().map((r) => r.fitness)).toEqual(one.takeReports().map((r) => r.fitness));
  });

  it('scores valid laps only when asked: a lap past the track limits is thrown away', () => {
    const track = new Track(generateLayout({ type: 'circuit', seed: 3, variant: 'club' }));
    const genomes = [0, 1, 2, 3, 4, 5].map((k) => initialWeights(new Rng(k + 1)));
    const run = (validLaps: boolean) => { const t = new Trial(track, genomes, { seconds: 60, validLaps }); while (!t.done) t.step(); return t.results(); };
    const all = run(false), valid = run(true);
    expect(valid.some((r) => r.trackLimits > 0)).toBe(true);
    valid.forEach((r, k) => {
      expect(r.trackLimits).toBe(all[k].trackLimits);
      if (r.trackLimits === 0) expect(r.fitness).toBe(all[k].fitness);
      else expect(r.fitness).toBeLessThan(all[k].fitness);
    });
  });

  it('keeps road-course students practising after their license', () => {
    const c = new Classroom({
      lesson: 'circuits', presets: Object.keys(PRESETS).map(presetLayout), seed: 5,
      students: [0, 1].map((k) => ({
        key: k, id: `D${k}`, name: `D${k}`, weights: initialWeights(new Rng(k + 1)), rounds: 1, licensed: true, roadLicensed: true, roadRadius: 13,
      })),
    });
    expect(c.finished).toBe(false);
    const before = c.students[0].weights.slice();
    while (c.round < 1) c.step();
    expect(c.students[0].weights.some((w, i) => w !== before[i])).toBe(true);
  });

  it('trains supervised exactly as the plain textbook loop does, zero inputs and all', () => {
    const layers = [9, 6, 5, 2] as const;
    const rng = new Rng(11);
    const w0 = Float32Array.from({ length: genomeSize(layers) }, () => rng.gaussian() * 0.5);
    // Inputs mostly zero, as a driver's radio, pit and caution inputs are in ghost laps.
    const data: Example[] = Array.from({ length: 40 }, () => ({
      x: Float32Array.from({ length: 9 }, (_, k) => (k < 3 || rng.next() < 0.3 ? rng.gaussian() : 0)),
      y: Float32Array.of(rng.next() - 0.5, rng.next() - 0.5),
      mask: Float32Array.of(1, rng.next() < 0.8 ? 1 : 0),
    }));
    const fast = w0.slice(), plain = w0.slice();
    const r1 = new Rng(4), r2 = new Rng(4);
    const loss = trainSupervised(layers, fast, data, 3, 0.05, () => r1.next());
    const plainLoss = textbookTrain(layers, plain, data, 3, 0.05, () => r2.next());
    expect(Array.from(fast)).toEqual(Array.from(plain));
    expect(loss).toBe(plainLoss);
  });
});

describe('sim speed-ups', () => {
  it('wraps track positions exactly as the double modulo does', () => {
    const rng = new Rng(3);
    for (const len of [3103.217, 1234.567891234, 0.5]) {
      const line = new Centerline({ kind: 'curvature', sections: [[len, 0, 0]] });
      const L = line.length;
      const edges = [0, -0, L, -L, 2 * L, L * (1 - 1e-16), -L * (1 - 1e-16), 5e-324, -5e-324, L / 2, Infinity, NaN];
      const values = [...edges, ...edges.map((v) => v + 1e-12), ...edges.map((v) => v - 1e-12)];
      for (let i = 0; i < 20000; i++) values.push((rng.next() - 0.5) * 6 * L, L + (rng.next() - 0.5) * 1e-9, -L + (rng.next() - 0.5) * 1e-9);
      for (const s of values) expect(Object.is(line.wrapS(s), ((s % L) + L) % L), `wrapS(${s}) on ${L}`).toBe(true);
    }
  });

  it('runs the network exactly as the plain loop does, zero inputs skipped', () => {
    const layers = [9, 6, 5, 2] as const;
    const rng = new Rng(5);
    const w = Float32Array.from({ length: genomeSize(layers) }, () => rng.gaussian() * 0.5);
    const net = new Network(layers, w);
    for (let n = 0; n < 200; n++) {
      const x = Float32Array.from({ length: 9 }, () => (rng.next() < 0.5 ? rng.gaussian() : 0));
      expect(Array.from(net.forward(x))).toEqual(Array.from(textbookForward(layers, w, x)));
    }
  });
});

function textbookForward(layers: readonly number[], weights: Float32Array, input: Float32Array): Float32Array {
  let prev = Float32Array.from(input);
  let w = 0;
  for (let l = 1; l < layers.length; l++) {
    const out = new Float32Array(layers[l]);
    for (let o = 0; o < layers[l]; o++) {
      let sum = weights[w++];
      for (let k = 0; k < layers[l - 1]; k++) sum += prev[k] * weights[w++];
      out[o] = Math.tanh(sum);
    }
    prev = out;
  }
  return prev;
}

/** Backprop as first written (before the speed-ups): the reference. */
function textbookTrain(layers: readonly number[], weights: Float32Array, data: Example[], epochs: number, learningRate: number, random: () => number): number {
  const L = layers.length;
  const acts = layers.map((n) => new Float32Array(n));
  const deltas = layers.map((n) => new Float32Array(n));
  const offsets: number[] = [];
  let off = 0;
  for (let l = 1; l < L; l++) { offsets.push(off); off += layers[l] * (layers[l - 1] + 1); }
  const order = data.map((_, i) => i);
  let loss = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    loss = 0;
    for (const idx of order) {
      const ex = data[idx];
      acts[0].set(ex.x);
      for (let l = 1; l < L; l++) {
        const nIn = layers[l - 1];
        let w = offsets[l - 1];
        for (let o = 0; o < layers[l]; o++) {
          let sum = weights[w++];
          for (let k = 0; k < nIn; k++) sum += acts[l - 1][k] * weights[w++];
          acts[l][o] = Math.tanh(sum);
        }
      }
      const out = acts[L - 1];
      for (let o = 0; o < layers[L - 1]; o++) {
        const err = (out[o] - ex.y[o]) * ex.mask[o];
        loss += err * err;
        deltas[L - 1][o] = err * (1 - out[o] * out[o]);
      }
      for (let l = L - 1; l >= 1; l--) {
        const nIn = layers[l - 1];
        const base = offsets[l - 1];
        if (l > 1) {
          deltas[l - 1].fill(0);
          for (let o = 0; o < layers[l]; o++) {
            const row = base + o * (nIn + 1) + 1;
            for (let k = 0; k < nIn; k++) deltas[l - 1][k] += deltas[l][o] * weights[row + k];
          }
          for (let k = 0; k < nIn; k++) deltas[l - 1][k] *= 1 - acts[l - 1][k] * acts[l - 1][k];
        }
        for (let o = 0; o < layers[l]; o++) {
          const row = base + o * (nIn + 1);
          const d = deltas[l][o] * learningRate;
          if (d === 0) continue;
          weights[row] -= d;
          for (let k = 0; k < nIn; k++) weights[row + 1 + k] -= d * acts[l - 1][k];
        }
      }
    }
    loss /= Math.max(1, data.length);
  }
  return loss;
}
