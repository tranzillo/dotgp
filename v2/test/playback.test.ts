import { describe, expect, it } from 'vitest';
import type { CarView, SessionSnapshot } from '../src/events/session';
import { Playback } from '../src/render/playback';
import { PRESETS, presetTrack } from '../src/trackgen';

const track = presetTrack(Object.keys(PRESETS)[0]);
const SPEED = 80; // m/s
const LANE = 3; // m left of the centreline

/** A car lapping at a steady speed in one lane, as a snapshot would show it at sim time t. */
function snapshotAt(t: number): SessionSnapshot {
  const s = track.wrapS(SPEED * t);
  const [x, y] = track.toWorld(s, LANE);
  const car = { id: 0, key: 0, x, y, s, d: LANE, dist: SPEED * t, speed: SPEED, frameX: 1, frameY: 0 } as CarView;
  return { time: t, cars: [car], order: [0], standings: null, race: null, technique: [] };
}

/** Frames from the worker at ~60 Hz with jitter, played on a 144 Hz screen; the car's track position each screen frame. */
function watch(speed: number, seconds: number): number[] {
  const pb = new Playback();
  const shown: number[] = [];
  let simTime = 0, nextArrival = 0;
  let jitter = 1;
  for (let now = 0; now < seconds * 1000; now += 1000 / 144) {
    while (nextArrival <= now) {
      pb.push(snapshotAt(simTime), new Float32Array(0), nextArrival);
      jitter = (jitter * 7919) % 101; // deterministic unevenness, 0..100
      const gap = 1000 / 60 + (jitter / 100 - 0.5) * 10; // 11.7..21.7 ms
      nextArrival += gap;
      simTime += (gap / 1000) * speed;
    }
    const { cars } = pb.tick(track, now);
    const p = track.project(cars[0].x, cars[0].y);
    expect(Math.abs(p.d - LANE)).toBeLessThan(0.5); // on its line, even mid-corner between frames 100 m apart
    shown.push(cars[0].dist);
  }
  return shown;
}

describe('playback between snapshots', () => {
  for (const speed of [1, 64]) {
    it(`moves the car evenly every screen frame at ${speed}x`, () => {
      const dist = watch(speed, 3).slice(144); // past the first second (settling in)
      const steps = dist.slice(1).map((d, i) => d - dist[i]);
      const expected = (SPEED * speed) / 144;
      for (const step of steps) {
        expect(step).toBeGreaterThan(expected * 0.85);
        expect(step).toBeLessThan(expected * 1.15);
      }
    });
  }
});
