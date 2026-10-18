import { describe, expect, it } from 'vitest';
import { Car, type TrainingWheels, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { resolveWalls } from '../src/sim/collisions';
import { buildLayout, ovalTrack, SPEEDWAY } from '../src/trackgen';
import { Track } from '../src/sim/track';

const speedwayLayout = () => buildLayout('oval', SPEEDWAY);
import { World } from '../src/sim/world';

const track = ovalTrack(SPEEDWAY);

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
    expect(track.surfaceAt(0, track.pit.wallD + 3)).toBe('pit');
    expect(track.surfaceAt(0, track.pit.roadD + 2)).toBe('garage');
    expect(track.surfaceAt(0, track.infield.garage.lot.d1 + 2)).toBe('grass');
    const midTurn = SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + 100;
    expect(track.surfaceAt(midTurn, track.halfWidth + 2)).toBe('apron');
    expect(track.surfaceAt(midTurn, track.apronEdgeAt(0) + 2)).toBe('grass');
  });

  it('widens the apron into pit road at the exit of turn 4 and back after the wall', () => {
    expect(track.pavedInnerD(track.pit.wallStart - 200)).toBeCloseTo(track.apronEdgeAt(0), 5);
    expect(track.pavedInnerD(track.pit.wallStart - 75)).toBeGreaterThan(track.apronEdgeAt(0));
    expect(track.pavedInnerD(track.pit.wallStart)).toBeCloseTo(track.pit.roadD, 5);
    expect(track.pavedInnerD(track.pit.wallEnd + 200)).toBeCloseTo(track.apronEdgeAt(0), 5);
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
    const onGrass = coast(track.apronEdgeAt(0) + 10);
    expect(onGrass.surface).toBe('grass');
    expect(40 - onGrass.speed).toBeGreaterThan(2.5 * (40 - onTrack.speed));
  });
});

describe('road circuit surfaces', () => {
  // Strips of each surface laid across the speedway's back straight (on top of the track), coasting and braking.
  const back = SPEEDWAY.straightLength / 2 + 2 * SPEEDWAY.easementLength + Math.PI * SPEEDWAY.turnRadius + 30;
  const strip = (surface: 'kerb' | 'runoff' | 'gravel' | 'grass' | 'track') => {
    const layout = speedwayLayout();
    layout.surfaces.push({ id: 'test', surface, shape: { kind: 'band', range: [back - 20, back + 400], d0: -8, d1: 8 } });
    return new Track(layout);
  };
  const run = (t: Track, input: number, wheels?: TrainingWheels, speed = 50) => {
    const car = new Car(0);
    car.placeOnTrack(t, back, 0);
    const i = car.trackIdx;
    car.vx = t.tx[i] * speed; car.vy = t.ty[i] * speed;
    car.frameX = t.tx[i]; car.frameY = t.ty[i];
    car.inputX = input;
    for (let k = 0; k < 1.5 / P.DT; k++) {
      stepCar(car, t, P.DT, 1, wheels);
      const p = t.project(car.x, car.y, car.trackIdx);
      car.trackIdx = p.idx; car.s = p.s; car.d = p.d;
    }
    return car;
  };

  it('gravel stops a car far harder than grass, which stops it harder than pavement', () => {
    const lost = (surface: Parameters<typeof strip>[0]) => 50 - run(strip(surface), 0).speed;
    expect(run(strip('gravel'), 0).surface).toBe('gravel');
    expect(lost('gravel')).toBeGreaterThan(2 * lost('grass'));
    expect(lost('grass')).toBeGreaterThan(2 * lost('track'));
  });

  it('kerbs brake nearly like the track, run-off less well, grass worse', () => {
    const braked = (surface: Parameters<typeof strip>[0]) => 50 - run(strip(surface), -1).speed;
    expect(braked('kerb')).toBeGreaterThan(0.85 * braked('track'));
    expect(braked('runoff')).toBeLessThan(braked('track'));
    expect(braked('runoff')).toBeGreaterThan(braked('grass'));
    // Braking on loose ground: less grip, though the drag helps (gravel's drag more than makes up for it).
    expect(braked('grass')).toBeLessThan(braked('track'));
  });

  it('running wide onto run-off costs speed: it is safe, not free', () => {
    const lost = (surface: Parameters<typeof strip>[0]) => 50 - run(strip(surface), 0).speed;
    expect(lost('runoff')).toBeGreaterThan(lost('track') + 0.3); // ~0.25 m/s² more drag (grip, 80%, costs more at a traction-limited exit)
  });

  it('training wheels: forgiving gravel slows a learner no more than run-off; a speed limit stops the drive', () => {
    const lost = (surface: Parameters<typeof strip>[0], wheels?: TrainingWheels) => 50 - run(strip(surface), 0, wheels).speed;
    const soft = { forgiving: 1, speedCap: Infinity };
    expect(lost('gravel', soft)).toBeCloseTo(lost('runoff'), 6);
    expect(lost('gravel', { forgiving: 0.5, speedCap: Infinity })).toBeLessThan(lost('gravel'));
    expect(lost('track', soft)).toBe(lost('track')); // the track itself is untouched
    // Full throttle from 20 m/s: with a 25 m/s limit the car stops gaining there.
    expect(run(strip('track'), 1, { forgiving: 0, speedCap: 25 }, 20).speed).toBeLessThan(26);
    expect(run(strip('track'), 1, undefined, 20).speed).toBeGreaterThan(30);
  });

  it('kerbs unsettle a car; run-off does not', () => {
    const drift = (surface: Parameters<typeof strip>[0]) => Math.abs(run(strip(surface), 0).d);
    expect(drift('kerb')).toBeGreaterThan(drift('runoff') + 0.05); // (both drift a little: the straight is banked)
  });
});

describe('pit wall', () => {
  it('stops a car crossing from the track into the pits', () => {
    const car = rolling(50, track.pit.wallD - P.CAR_RADIUS - 0.2, 60, 0.3);
    car.frameX = car.vx / 60; car.frameY = car.vy / 60;
    for (let k = 0; k < 10; k++) {
      car.x += car.vx * P.DT; car.y += car.vy * P.DT;
      const p = track.project(car.x, car.y, car.trackIdx);
      car.trackIdx = p.idx; car.s = p.s; car.d = p.d;
      resolveWalls(car, track);
    }
    expect(car.d).toBeLessThan(track.pit.wallD);
    expect(car.health).toBeLessThan(1);
  });

  it('punishes hitting the end of the wall head-on', () => {
    const car = rolling(track.pit.wallStart - 3, track.pit.wallD, 50);
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
    const g = track.infield.garage.lot;
    const sMid = (g.s0 + g.s1) / 2;
    expect(track.surfaceAt(sMid, track.pit.roadD - 1)).toBe('pit');
    expect(track.surfaceAt(sMid, track.pit.roadD + 1)).toBe('garage');
    expect(track.surfaceAt(sMid, g.d1 + 3)).toBe('grass');
    expect(g.d0).toBeCloseTo(track.pit.roadD, 5); // no gap between pit road and garage
    expect(track.layout.decor.filter((d) => d.kind === 'building').length).toBeGreaterThan(4);
    expect(track.infield.garage.parking.length).toBeGreaterThanOrEqual(12);
  });

  it('has a paved escape lane from the back-straight apron across the infield', () => {
    const pts = track.infield.escapeLanes[0].points;
    const [x0, y0] = pts[0];
    const p0 = track.project(x0, y0);
    expect(p0.d).toBeLessThanOrEqual(track.apronEdgeAt(0)); // starts at the track's edge
    // Midway across the infield it is road, while beside it is grass.
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const p = track.project(mx, my);
    expect(track.surfaceAt(p.s, p.d, mx, my)).toBe('road');
    expect(track.surfaceAt(p.s, p.d, mx + 20, my)).toBe('grass');
  });
});
