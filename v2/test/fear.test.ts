import { describe, expect, it } from 'vitest';
import { danger, fearScale, hurt, trauma } from '../src/ai/fear';
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

  it('rises as the gap to the car ahead closes too fast; being closed on from behind is feared far less', () => {
    const near = world([100, 0, 70], [108, 0, 50]); // 5 m gap, closing at 20 m/s: 0.25 s
    const far = world([100, 0, 70], [130, 0, 50]); // 27 m gap: 1.35 s
    expect(danger(near.cars[0], near)).toBeGreaterThan(0.7);
    expect(danger(far.cars[0], far)).toBe(0);
    // Any cause counts, but a hit from behind barely hurts (push damage).
    expect(danger(near.cars[1], near)).toBeGreaterThan(0);
    expect(danger(near.cars[1], near)).toBeLessThan(danger(near.cars[0], near) / 2);
  });

  it('is how badly the coming hit would hurt: a rub is nothing, a fast closing the most there is', () => {
    const rub = world([100, 0, 53], [104, 0, 50]); // 1 m gap, closing at 3 m/s: no damage below 4 m/s
    expect(danger(rub.cars[0], rub)).toBe(0);
    expect(hurt(3)).toBe(0);
    expect(hurt(8)).toBeLessThan(0.3);
    expect(hurt(14)).toBe(1); // a hit that could injure the driver
    // Same time to contact (0.4 s), closing at 8 and at 16 m/s.
    const slow = world([100, 0, 58], [106.2, 0, 50]), fast = world([100, 0, 66], [109.4, 0, 50]);
    expect(danger(fast.cars[0], fast)).toBeGreaterThan(3 * danger(slow.cars[0], slow));
  });

  it('big hits weigh far more than their size; nerve sets the price', () => {
    expect(trauma(0.5)).toBeGreaterThan(10 * trauma(0.05) * 2);
    expect(fearScale(0)).toBe(2);
    expect(fearScale(0.5)).toBe(1);
    expect(fearScale(1)).toBe(0);
  });
});
