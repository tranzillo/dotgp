import { describe, expect, it } from 'vitest';
import { OnlineLearner } from '../src/ai/online';
import { Rng } from '../src/ai/rng';

describe('learning while racing', () => {
  it('climbs toward better laps, comparing each variation with its opposite', () => {
    // A stand-in for lap scores: the closer the driving weights to a target, the better the lap.
    const target = Float32Array.from({ length: 16 }, (_, i) => Math.sin(i));
    const live = new Float32Array(16);
    const learner = new OnlineLearner(live, { sigma: 0.05, pairs: 4, learningRate: 0.05, weightDecay: 0 }, new Rng(1));
    const score = () => -live.reduce((a, w, i) => a + (w - target[i]) ** 2, 0);
    const distance = () => Math.sqrt(learner.weights.reduce((a, w, i) => a + (w - target[i]) ** 2, 0));
    const start = distance();
    for (let lap = 0; lap < 2000; lap++) learner.lapDone(score());
    expect(distance()).toBeLessThan(start * 0.3);
    expect(learner.updates).toBe(250); // 2000 laps / (2 laps per pair x 4 pairs)
  });

  it('runs the same variation again after a lap that does not count, and drives its own weights when done', () => {
    const live = new Float32Array(8);
    const learner = new OnlineLearner(live, { sigma: 0.1, pairs: 1, learningRate: 0.1, weightDecay: 0 }, new Rng(2));
    const varied = live.slice();
    expect(varied.some((w) => w !== 0)).toBe(true); // exploring around the driver's weights
    expect(learner.lapDone(null)).toBe(false);
    expect(Array.from(live)).toEqual(Array.from(varied)); // a caution lap: unchanged
    learner.lapDone(-30);
    expect(learner.lapDone(-31)).toBe(true); // one pair = one step
    learner.finish();
    expect(Array.from(live)).toEqual(Array.from(learner.weights));
  });
});
