import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec } from '../src/events/session';
import { STROKE_FIELDS } from '../src/render/marks';
import { Replay } from '../src/render/replay';
import { presetLayout } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
const entrants = (n: number): EntrantSpec[] => Array.from({ length: n }, (_, k) => ({
  key: 100 + k, fill: '#ffffff',
  driver: { id: `D${k}`, weights: adaptWeights(Float32Array.from(bundled[k % bundled.length].weights)) },
  spotter: { id: `S${k}`, skill: PERFECT_SPOTTER },
  chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
}));

describe('replay', () => {
  const s = new Session({ kind: 'race', layout: presetLayout('short'), entrants: entrants(6), laps: 8, pace: 4, seed: 2 });
  s.advance(240);
  const r = new Replay(s.tape, s.track);

  it('starts at the end of the tape and keeps the playhead on it', () => {
    expect(r.time).toBe(r.end);
    r.seek(-5);
    expect(r.time).toBe(r.start);
    r.seek(1e9);
    expect(r.time).toBe(r.end);
  });

  it('draws the cars between frames, on the track, matching the frames at the frames', () => {
    const t0 = s.tape.timeAt(1200); // a frame's own time (sim time is a sum of steps: not exactly 120)
    r.seek(t0);
    const at = r.view();
    expect(at.snap.time).toBe(t0);
    for (const car of at.cars) {
      const frameCar = at.snap.cars.find((c) => c.id === car.id)!;
      expect(car.x).toBeCloseTo(frameCar.x, 3);
    }
    r.seek(t0 + 0.05); // halfway to the next frame
    const mid = r.view();
    const next = r.frame(r.index + 1);
    for (const car of mid.cars) {
      const a = at.snap.cars.find((c) => c.id === car.id)!, b = next.cars.find((c) => c.id === car.id)!;
      expect(car.dist).toBeGreaterThanOrEqual(Math.min(a.dist, b.dist) - 1e-6);
      expect(car.dist).toBeLessThanOrEqual(Math.max(a.dist, b.dist) + 1e-6);
    }
  });

  it('finds when the leader reached a share of the race (the timeline under a drag)', () => {
    const position = (f: ReturnType<Replay['frame']>) => {
      const leader = f.cars.find((c) => c.id === f.order[0])!;
      return f.race!.started ? (leader.laps + s.track.wrapS(leader.s) / s.track.length) / f.race!.laps : 0;
    };
    const t = r.timeWhere(0.25, position);
    r.seek(t);
    expect(position(r.view().snap)).toBeGreaterThanOrEqual(0.25);
    r.seek(t - 0.1);
    expect(position(r.view().snap)).toBeLessThan(0.25);
  });

  it('lays the tire marks from tape, frame to frame', () => {
    const strokes = s.tape.strokes(s.tape.first, s.tape.end - 1);
    expect(strokes.length % STROKE_FIELDS).toBe(0);
    expect(strokes.length / STROKE_FIELDS).toBeGreaterThan(100);
    for (let k = 0; k < strokes.length; k += STROKE_FIELDS) {
      expect(Math.hypot(strokes[k + 2] - strokes[k], strokes[k + 3] - strokes[k + 1])).toBeLessThanOrEqual(30);
      expect(strokes[k + 4]).toBeLessThanOrEqual(1);
    }
  });
});
