import { describe, expect, it } from 'vitest';
import { Car } from '../src/sim/car';
import { faultShare, resolveCarCollisions } from '../src/sim/collisions';
import { presetTrack } from '../src/trackgen';

const track = presetTrack('speedway');
function car(id: number, s: number, d: number, speed: number, lateral = 0): Car {
  const c = new Car(id);
  c.placeOnTrack(track, s, d);
  const i = c.trackIdx;
  c.vx = track.tx[i] * speed - track.ty[i] * lateral;
  c.vy = track.ty[i] * speed + track.tx[i] * lateral;
  return c;
}

describe('fault in car contact', () => {
  it('blames the car closing from behind', () => {
    const behind = car(0, 100, 0, 60), ahead = car(1, 102.5, 0, 45);
    expect(faultShare(behind, ahead, track)).toBeGreaterThan(0.9);
    expect(faultShare(ahead, behind, track)).toBeLessThan(0.1);
  });

  it('blames the car moving across into the other', () => {
    // Side by side; car 0 drifts across toward car 1 (which holds its lane).
    const a = car(0, 100, 0, 50), b = car(1, 100, 2.8, 50);
    const toward = Math.sign(b.d - a.d) * 3; // lateral m/s, toward b
    const mover = car(0, 100, 0, 50, toward);
    expect(faultShare(mover, b, track)).toBeGreaterThan(0.9);
    expect(faultShare(a, b, track)).toBe(0.5); // nobody moving: shared
  });

  it('charges damage done to the car at fault', () => {
    const behind = car(0, 100, 0, 70), ahead = car(1, 102.5, 0, 40);
    resolveCarCollisions([behind, ahead], track);
    expect(ahead.health).toBeLessThan(1);
    expect(behind.harmDone).toBeGreaterThan(0);
    expect(ahead.harmDone).toBeLessThan(behind.harmDone * 0.1);
    expect(behind.lastImpact?.fault).toBeGreaterThan(0.9);
  });
});
