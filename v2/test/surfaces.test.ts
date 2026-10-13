import { describe, expect, it } from 'vitest';
import { Car, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { resolveWalls } from '../src/sim/collisions';
import { SPEEDWAY, Track } from '../src/sim/track';
import { World } from '../src/sim/world';

const track = new Track(SPEEDWAY);

function rolling(s: number, d: number, speed: number, heading = 0): Car {
  const car = new Car(0);
  car.placeOnTrack(track, s, d);
  const i = car.trackIdx;
  const c = Math.cos(heading), sn = Math.sin(heading);
  // heading > 0 turns toward the infield (+d)
  car.vx = (track.tx[i] * c - track.ty[i] * sn) * speed;
  car.vy = (track.ty[i] * c + track.tx[i] * sn) * speed;
  return car;
}

describe('surfaces', () => {
  it('classifies track, apron, pit road and grass', () => {
    expect(track.surfaceAt(0, 0)).toBe('track');
    expect(track.surfaceAt(0, track.pitWallD + 3)).toBe('pit');
    expect(track.surfaceAt(0, track.pitRoadD + 2)).toBe('garage');
    expect(track.surfaceAt(0, track.infield.garage.d1 + 2)).toBe('grass');
    const midTurn = SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + 100;
    expect(track.surfaceAt(midTurn, track.halfWidth + 2)).toBe('apron');
    expect(track.surfaceAt(midTurn, track.apronD + 2)).toBe('grass');
  });

  it('widens the apron into pit road at the exit of turn 4 and back after the wall', () => {
    expect(track.pavedInnerD(track.pitWallStart - 200)).toBeCloseTo(track.apronD, 5);
    expect(track.pavedInnerD(track.pitWallStart - 75)).toBeGreaterThan(track.apronD);
    expect(track.pavedInnerD(track.pitWallStart)).toBeCloseTo(track.pitRoadD, 5);
    expect(track.pavedInnerD(track.pitWallEnd + 200)).toBeCloseTo(track.apronD, 5);
  });

  it('grass slows a car far harder than asphalt', () => {
    const coast = (d: number) => {
      const backStraight = SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + Math.PI * SPEEDWAY.turnRadius + 150;
      const car = rolling(backStraight, d, 40);
      for (let k = 0; k < 2 / P.DT; k++) {
        stepCar(car, track, P.DT);
        const p = track.project(car.x, car.y, car.trackIdx);
        car.trackIdx = p.idx; car.s = p.s; car.d = p.d;
      }
      return car;
    };
    const onTrack = coast(0);
    const onGrass = coast(track.apronD + 10);
    expect(onGrass.surface).toBe('grass');
    expect(40 - onGrass.speed).toBeGreaterThan(2.5 * (40 - onTrack.speed));
  });
});

describe('pit wall', () => {
  it('stops a car crossing from the track into the pits', () => {
    const car = rolling(50, track.pitWallD - P.CAR_RADIUS - 0.2, 60, 0.3);
    car.frameX = car.vx / 60; car.frameY = car.vy / 60;
    for (let k = 0; k < 10; k++) {
      car.x += car.vx * P.DT; car.y += car.vy * P.DT;
      const p = track.project(car.x, car.y, car.trackIdx);
      car.trackIdx = p.idx; car.s = p.s; car.d = p.d;
      resolveWalls(car, track);
    }
    expect(car.d).toBeLessThan(track.pitWallD);
    expect(car.health).toBeLessThan(1);
  });

  it('punishes hitting the end of the wall head-on', () => {
    const car = rolling(track.pitWallStart - 3, track.pitWallD, 50);
    car.frameX = car.vx / 50; car.frameY = car.vy / 50;
    for (let k = 0; k < 30 && car.speed > 30; k++) {
      car.x += car.vx * P.DT; car.y += car.vy * P.DT;
      const p = track.project(car.x, car.y, car.trackIdx);
      car.trackIdx = p.idx; car.s = p.s; car.d = p.d;
      resolveWalls(car, track);
    }
    expect(car.speed).toBeLessThan(30);
    expect(car.damageAero).toBeGreaterThan(car.damageHandling); // nose-first deceleration
  });
});

describe('infield shortcut', () => {
  it('earns no progress for cutting across the grass', () => {
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    // Mid back straight, then teleport-free drive straight across the infield.
    const sBack = SPEEDWAY.straightLength / 2 + 2 * SPEEDWAY.easementLength + (Math.PI * SPEEDWAY.turnRadius - SPEEDWAY.easementLength) + SPEEDWAY.straightLength / 2;
    car.placeOnTrack(track, sBack, track.halfWidth);
    world.addCar(car, null);
    const i = car.trackIdx;
    // Aim straight across, toward the front straight.
    car.vx = -track.ty[i] * 60;
    car.vy = track.tx[i] * 60;
    const before = car.dist;
    const sBefore = car.s;
    for (let k = 0; k < 12 / P.DT; k++) {
      world.step();
      // Keep the speed up as if driving hard across the grass.
      const sp = car.speed;
      if (sp > 1e-6) { car.vx *= 60 / sp; car.vy *= 60 / sp; }
    }
    // The projection jumped about half a lap; credited progress did not.
    let jumped = car.s - sBefore;
    if (jumped < 0) jumped += track.length;
    expect(jumped).toBeGreaterThan(track.length * 0.3);
    expect(Math.abs(car.dist - before)).toBeLessThan(150);
  });
});

describe('infield', () => {
  it('has a garage lot behind pit road, reachable straight from it', () => {
    const g = track.infield.garage;
    const sMid = (g.s0 + g.s1) / 2;
    expect(track.surfaceAt(sMid, track.pitRoadD - 1)).toBe('pit');
    expect(track.surfaceAt(sMid, track.pitRoadD + 1)).toBe('garage');
    expect(track.surfaceAt(sMid, g.d1 + 3)).toBe('grass');
    expect(g.d0).toBeCloseTo(track.pitRoadD, 5); // no gap between pit road and garage
    expect(track.infield.buildings.length).toBeGreaterThan(4);
  });

  it('has a paved escape lane from the back-straight apron across the infield', () => {
    const pts = track.infield.escape;
    const [x0, y0] = pts[0];
    const p0 = track.project(x0, y0);
    expect(p0.d).toBeLessThanOrEqual(track.apronD); // starts at the track's edge
    // Midway across the infield it is road, while beside it is grass.
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const p = track.project(mx, my);
    expect(track.surfaceAt(p.s, p.d, mx, my)).toBe('road');
    expect(track.surfaceAt(p.s, p.d, mx + 20, my)).toBe('grass');
  });
});
