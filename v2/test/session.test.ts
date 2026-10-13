import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec, type SessionSpec } from '../src/events/session';
import { PHYSICS as P } from '../src/sim/constants';
import { presetLayout } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;

function entrants(n: number): EntrantSpec[] {
  return Array.from({ length: n }, (_, k) => ({
    key: 100 + k,
    fill: '#ffffff',
    driver: { id: `D${k}`, weights: adaptWeights(Float32Array.from(bundled[k % bundled.length].weights)) },
    spotter: { id: `S${k}`, skill: PERFECT_SPOTTER },
    chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
  }));
}

const spec = (kind: SessionSpec['kind'], laps = 3): SessionSpec => ({
  kind, layout: presetLayout('short'), entrants: entrants(4), laps, pace: 4, seed: 7,
});

describe('session', () => {
  it('runs a race from the pace laps to the checkered flag and classifies everyone', () => {
    const s = new Session(spec('race'));
    for (let k = 0; k < 600 / P.DT && !s.finished; k++) s.step();
    expect(s.finished).toBe(true);
    const results = s.results();
    expect(results.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(new Set(results.map((r) => r.key))).toEqual(new Set([100, 101, 102, 103]));
    const winner = results[0];
    expect(winner.status).toBe('finished');
    expect(winner.laps).toBe(3);
    expect(winner.bestLap).toBeGreaterThan(20);
    expect(winner.driver).toMatch(/^D/);
  });

  it('snapshots are plain data: every car, in classification order, with what the viewer draws', () => {
    const s = new Session(spec('race', 20));
    s.advance(60);
    const snap = s.snapshot();
    expect(snap.cars).toHaveLength(4);
    expect([...snap.order].sort()).toEqual(snap.cars.map((c) => c.id).sort());
    expect(snap.race?.laps).toBe(20);
    expect(snap.technique.length).toBe(4);
    // Survives a structured clone (what crossing to the page does).
    const copy = structuredClone(snap);
    expect(copy.cars[0].key).toBe(snap.cars[0].key);
    expect(s.takeRadio().length).toBeGreaterThan(0); // at least the race-control calls
  });

  it('puts wrecked cars back out in open sessions, never in races', () => {
    for (const kind of ['practice', 'race'] as const) {
      const s = new Session(spec(kind));
      s.advance(5);
      const car = s.world.cars[0];
      car.retired = true;
      car.vx = car.vy = 0;
      s.advance(5);
      expect(s.world.cars[0].retired, kind).toBe(kind === 'race');
    }
  });

  it('drives with new weights as soon as practice improves a driver', () => {
    const s = new Session(spec('practice'));
    const zeros = new Float32Array(adaptWeights(Float32Array.from(bundled[0].weights)).length);
    s.updateDriver('D0', zeros);
    s.advance(1);
    // A driver with all-zero weights asks for nothing.
    const car = s.world.cars.find((c) => s.snapshot().cars.find((v) => v.id === c.id)!.key === 100)!;
    expect(Math.hypot(car.inputX, car.inputY)).toBeLessThan(1e-6);
  });

  it('collects tire-mark strokes only while watched', () => {
    const s = new Session(spec('practice'));
    s.advance(3);
    expect(s.strokes.drain().length).toBe(0);
    s.collectStrokes = true;
    s.advance(3);
    expect(s.strokes.drain().length).toBeGreaterThan(0);
  });
});
