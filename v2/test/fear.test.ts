import { describe, expect, it } from 'vitest';
import { danger, fearScale, trauma } from '../src/ai/fear';
import { Car } from '../src/sim/car';
import { World } from '../src/sim/world';
import { presetTrack } from '../src/trackgen';

const track = presetTrack('speedway');
function world(...cars: Array<[number, number, number]>): World {
  const w = new World(track, { collisions: true, drafting: true });
  cars.forEach(([s, d, speed], k) => {
    const c = new Car(k);
    c.placeOnTrack(track, s, d);
    c.vx = track.tx[c.trackIdx] * speed;
    c.vy = track.ty[c.trackIdx] * speed;
    w.addCar(c, null as never);
  });
  return w;
}

describe('fear', () => {
  it('is calm alone mid-track, and on a car ahead running the same speed', () => {
    const alone = world([100, 0, 60]);
    expect(danger(alone.cars[0], alone)).toBe(0);
    const w = world([100, 0, 60], [115, 0, 60]);
    expect(danger(w.cars[0], w)).toBe(0);
  });

  it('rises as the gap to the car ahead closes too fast, and only for the car closing', () => {
    const near = world([100, 0, 70], [108, 0, 50]); // 5 m gap, closing at 20 m/s: 0.25 s
    const far = world([100, 0, 70], [130, 0, 50]); // 27 m gap: 1.35 s
    expect(danger(near.cars[0], near)).toBeGreaterThan(0.7);
    expect(danger(far.cars[0], far)).toBe(0);
    expect(danger(near.cars[1], near)).toBe(0); // being closed on is the other driver's fear
  });

  it('big hits weigh far more than their size; nerve sets the price', () => {
    expect(trauma(0.5)).toBeGreaterThan(10 * trauma(0.05) * 2);
    expect(fearScale(0)).toBe(2);
    expect(fearScale(0.5)).toBe(1);
    expect(fearScale(1)).toBe(0);
  });
});
