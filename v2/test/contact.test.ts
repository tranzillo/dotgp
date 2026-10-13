import { describe, expect, it } from 'vitest';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { computeDraft, resolveCarCollisions } from '../src/sim/collisions';
import { SPEEDWAY, Track } from '../src/sim/track';

const track = new Track(SPEEDWAY);

function carAt(s: number, d: number, speed: number): Car {
  const car = new Car(0);
  car.placeOnTrack(track, s, d);
  const i = car.trackIdx;
  car.vx = track.tx[i] * speed;
  car.vy = track.ty[i] * speed;
  car.frameX = track.tx[i];
  car.frameY = track.ty[i];
  return car;
}

describe('car-to-car contact', () => {
  it('a rear-end hurts the hitter (deceleration -> aero) far more than the car hit', () => {
    const hitter = carAt(100, 0, 70);
    const victim = carAt(100 + 2 * P.CAR_RADIUS - 0.05, 0, 55);
    resolveCarCollisions([hitter, victim]);
    expect(hitter.speed).toBeLessThan(70);
    expect(victim.speed).toBeGreaterThan(55);
    expect(1 - hitter.health).toBeGreaterThan(3 * (1 - victim.health));
    expect(hitter.damageAero).toBeGreaterThan(hitter.damageHandling);
  });

  it('side-by-side rubbing at matched speed does no damage', () => {
    const a = carAt(100, -1.45, 70);
    const b = carAt(100, 1.45, 70);
    // Drift together at 1 m/s lateral: "rubbin' is racin'".
    a.vx += -track.ty[a.trackIdx] * 0.5; a.vy += track.tx[a.trackIdx] * 0.5;
    b.vx -= -track.ty[b.trackIdx] * 0.5; b.vy -= track.tx[b.trackIdx] * 0.5;
    resolveCarCollisions([a, b]);
    expect(a.health).toBe(1);
    expect(b.health).toBe(1);
  });
});

describe('drafting', () => {
  it('cuts drag for the follower and slightly for the leader', () => {
    const leader = carAt(200, 0, 70);
    const follower = carAt(190, 0, 70);
    const alone = carAt(900, 5, 70);
    computeDraft([leader, follower, alone], track);
    expect(follower.draftFactor).toBeLessThan(0.85);
    expect(leader.draftFactor).toBeLessThan(1);
    expect(leader.draftFactor).toBeGreaterThan(follower.draftFactor);
    expect(alone.draftFactor).toBe(1);
  });

  it('needs lateral overlap', () => {
    const leader = carAt(200, 0, 70);
    const offset = carAt(190, 5, 70);
    computeDraft([leader, offset], track);
    expect(offset.draftFactor).toBe(1);
  });
});
