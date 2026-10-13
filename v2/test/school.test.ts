import { describe, expect, it } from 'vitest';
import { initialWeights } from '../src/ai/es';
import { Rng } from '../src/ai/rng';
import { Classroom, LESSONS, type ClassSpec } from '../src/school/classroom';
import { PRESETS, presetLayout } from '../src/trackgen';

const presets = Object.keys(PRESETS).map(presetLayout);
const student = (k: number, licensed: boolean) => ({
  key: 10000 + k, id: `D${k}`, name: `Student ${k}`, weights: initialWeights(new Rng(k + 1)), rounds: 0, licensed,
});

function runRounds(c: Classroom, rounds: number) {
  const reports = [];
  while (c.round < rounds) {
    c.step();
    reports.push(...c.takeReports());
  }
  return reports;
}

describe('driving school', () => {
  it('runs rookie school round by round: each student plus its variations as ghosts, one track per round', () => {
    const spec: ClassSpec = { lesson: 'rookie', students: [student(0, false), student(1, false)], presets, seed: 3 };
    const c = new Classroom(spec);
    const per = 1 + 2 * LESSONS.rookie.pairs;
    const snap = c.snapshot();
    expect(snap.cars).toHaveLength(2 * per);
    expect(snap.cars.filter((car) => !car.variant).map((car) => car.key)).toEqual([10000, 10001]);
    expect(snap.school?.walls).toBeLessThan(0.1); // soft walls for brand-new rookies
    const firstTrack = c.track.name;
    const before = c.students[0].weights.slice();

    const reports = runRounds(c, 2);
    expect(reports).toHaveLength(4); // two students, two rounds
    expect(reports.filter((r) => r.key === 10000).map((r) => r.rounds)).toEqual([1, 2]);
    expect(c.track.name).not.toBe(firstTrack); // rotates through the presets
    // The students learned something: their weights moved.
    const after = reports.filter((r) => r.key === 10000).pop()!.weights;
    expect(after.some((w, i) => w !== before[i])).toBe(true);
    expect(reports[0].beaten).toBeGreaterThanOrEqual(0);
    expect(reports[0].beaten).toBeLessThanOrEqual(2 * LESSONS.rookie.pairs);
  });

  it('can still be snapshotted after a round hands its weights to the page', () => {
    const c = new Classroom({ lesson: 'rookie', students: [student(3, false)], presets, seed: 4 });
    const reports = runRounds(c, 1);
    // What the worker does: transfer the weights (the worker's copy is emptied).
    structuredClone(reports[0].weights, { transfer: [reports[0].weights.buffer] });
    expect(reports[0].weights.length).toBe(0);
    expect(() => structuredClone(c.snapshot())).not.toThrow();
  });

  it('gives the variety lesson a new generated track every round', () => {
    const c = new Classroom({ lesson: 'variety', students: [student(2, true)], presets, seed: 9 });
    const names = new Set([c.track.name]);
    expect(c.trackChanged).toBe(true);
    runRounds(c, 2);
    names.add(c.track.name);
    expect(names.size).toBe(2);
    expect(c.finished).toBe(false); // runs until stopped
  });
});
