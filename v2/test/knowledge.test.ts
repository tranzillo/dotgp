import { describe, expect, it } from 'vitest';
import { adaptWeights, DRIVER_LAYERS, KNOWLEDGE_FROM, PREVIEW_DRIVER_LAYERS } from '../src/ai/drivers';
import { randomWeights } from '../src/ai/mlp';
import { Network } from '../src/ai/network';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import { KNOWLEDGE_AHEAD, KNOWLEDGE_SIZE, observeKnowledge } from '../src/ai/observe';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { generateLayout, hashSeed } from '../src/trackgen';

describe('track knowledge', () => {
  const track = new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, 'race-club4'), variant: 'club' }));

  it('is where the driver\'s own line runs ahead, and the speed it takes there', () => {
    const car = new Car(0);
    car.placeOnTrack(track, 300, 1);
    const out = observeKnowledge(car, track, new Float32Array(KNOWLEDGE_SIZE), { grip: 0.85, margin: 1.2 });
    const line = fastestLine(track, 1.2);
    expect(out[0]).toBeCloseTo((lineAt(line, 300).d - car.d) / 10, 3);
    expect(out[3]).toBeCloseTo((lineAt(line, 300 + KNOWLEDGE_AHEAD[3]).d - car.d) / 10, 3);
    // A different line (more margin) is different knowledge.
    const other = observeKnowledge(car, track, new Float32Array(KNOWLEDGE_SIZE), { grip: 0.85, margin: 0.6 });
    expect(Array.from(other.slice(0, KNOWLEDGE_AHEAD.length))).not.toEqual(Array.from(out.slice(0, KNOWLEDGE_AHEAD.length)));
    // Less grip, slower known speeds.
    const timid = observeKnowledge(car, track, new Float32Array(KNOWLEDGE_SIZE), { grip: 0.7, margin: 1.2 });
    expect(timid[KNOWLEDGE_AHEAD.length + 2]).toBeLessThan(out[KNOWLEDGE_AHEAD.length + 2]);
  });

  it('shows the line on ovals too (the oval teacher drives it): where it runs across the track, and its speed', () => {
    const oval = new Track(generateLayout({ type: 'oval', seed: 3 }));
    const car = new Car(0);
    car.placeOnTrack(oval, 100, 0);
    const out = observeKnowledge(car, oval, new Float32Array(KNOWLEDGE_SIZE));
    expect(out.every(Number.isFinite)).toBe(true);
    // A car sitting still on the track is far below the speed its line takes.
    expect(out[KNOWLEDGE_AHEAD.length]).toBeGreaterThan(1);
  });

  it('leaves drivers from before it driving as they did', () => {
    const rng = new Rng(4);
    const old = randomWeights(PREVIEW_DRIVER_LAYERS, () => rng.gaussian());
    const widened = adaptWeights(old);
    const x = new Float32Array(DRIVER_LAYERS[0]).map(() => rng.gaussian());
    const before = new Network(PREVIEW_DRIVER_LAYERS, old).forward(x.slice(0, KNOWLEDGE_FROM));
    const after = new Network(DRIVER_LAYERS, widened).forward(x);
    Array.from(after).forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
  });
});
