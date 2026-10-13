import { describe, expect, it } from 'vitest';
import { Car, stepCar } from '../src/sim/car';
import { G, PHYSICS as P, SURFACES } from '../src/sim/constants';
import { resolveWalls } from '../src/sim/collisions';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track, type OvalSpec } from '../src/sim/track';
import { World } from '../src/sim/world';
import { ScriptedDriver } from '../src/ai/drivers';

const deg = (x: number) => (x * Math.PI) / 180;

function stepOnTrack(car: Car, track: Track) {
  stepCar(car, track, P.DT);
  const p = track.project(car.x, car.y, car.trackIdx);
  car.trackIdx = p.idx;
  car.s = p.s;
  car.d = p.d;
}

describe('track', () => {
  const track = new Track(SPEEDWAY);

  it('closes into a loop of the expected length', () => {
    const { straightLength: S, turnRadius: R, easementLength: Le } = SPEEDWAY;
    expect(track.length).toBeCloseTo(2 * S + 2 * Math.PI * R + 2 * Le, 0);
    const n = track.n;
    const gap = Math.hypot(track.x[0] - track.x[n - 1], track.y[0] - track.y[n - 1]);
    expect(gap).toBeCloseTo(track.ds, 2);
  });

  it('projects world points back to the same track coordinates', () => {
    for (const [s, d] of [[10, 0], [700, 5], [900, -8], [1800, 3], [2300, -2]]) {
      const [x, y] = track.toWorld(s, d);
      const p = track.project(x, y);
      expect(p.s).toBeCloseTo(s, 0);
      expect(p.d).toBeCloseTo(d, 1);
    }
  });

  it('banks progressively: steeper toward the outside of the turn', () => {
    const mid = track.indexAt(SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + 200);
    expect(track.turn[mid]).toBeCloseTo(1, 5);
    expect(track.bankAt(mid, -track.halfWidth)).toBeCloseTo(SPEEDWAY.bankOuter, 5);
    expect(track.bankAt(mid, track.halfWidth)).toBeCloseTo(SPEEDWAY.bankInner, 5);
  });
});

describe('powertrain', () => {
  it('reaches the power/drag terminal speed on a long flat straight', () => {
    const spec: OvalSpec = { ...SPEEDWAY, straightLength: 30000, bankStraight: 0 };
    const track = new Track(spec);
    const car = new Car(0);
    car.placeOnTrack(track, 10, 0);
    car.inputX = 1;
    let t10 = 0;
    for (let k = 0; k < 120 / P.DT; k++) {
      stepOnTrack(car, track);
      if (!t10 && car.speed >= 27.8) t10 = k * P.DT; // 0-100 km/h
    }
    // P = (0.5 rho CdA v^2 + Crr m g) v
    const m = car.mass;
    let lo = 1, hi = 200;
    for (let k = 0; k < 60; k++) {
      const v = (lo + hi) / 2;
      if ((0.5 * P.AIR_DENSITY * P.CDA * v * v + SURFACES.track.rolling * m * G) * v > P.ENGINE_POWER) hi = v; else lo = v;
    }
    const v = lo;
    expect(car.speed).toBeGreaterThan(v * 0.97);
    expect(car.speed).toBeLessThan(v * 1.01);
    expect(t10).toBeGreaterThan(2.5);
    expect(t10).toBeLessThan(4.5);
  });
});

describe('banking', () => {
  it('carries a car around the turn at neutral speed with zero tire input', () => {
    const track = new Track(SPEEDWAY);
    const lane = 0;
    const sMid = SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + 50;
    const idx = track.indexAt(sMid);
    const bank = track.bankAt(idx, lane);
    const vNeutral = Math.sqrt((G * Math.tan(bank)) / track.kappa[idx]);

    const car = new Car(0);
    car.placeOnTrack(track, sMid, lane);
    car.vx = track.tx[idx] * vNeutral;
    car.vy = track.ty[idx] * vNeutral;
    for (let k = 0; k < 2 / P.DT; k++) {
      // Hold speed against drag by topping it up; no lateral input at all.
      stepOnTrack(car, track);
      const sp = car.speed;
      car.vx *= vNeutral / sp;
      car.vy *= vNeutral / sp;
    }
    expect(Math.abs(car.d - lane)).toBeLessThan(1.0);
  });

  it('lets cars corner far faster on a banked turn than a flat one', () => {
    const vMax = (spec: OvalSpec) => {
      const b = spec.bankOuter, mu = P.TIRE_MU;
      return Math.sqrt((G * (Math.sin(b) + mu * Math.cos(b))) / (Math.cos(b) - mu * Math.sin(b)) * spec.turnRadius);
    };
    expect(vMax(SPEEDWAY) / vMax(FLAT_TRACK)).toBeGreaterThan(1.3);
  });
});

describe('scripted baseline', () => {
  for (const [name, spec] of [['speedway', SPEEDWAY], ['short', SHORT_TRACK], ['flat', FLAT_TRACK]] as const) {
    it(`laps the ${name} oval cleanly`, () => {
      const track = new Track(spec);
      const world = new World(track);
      const car = new Car(0);
      car.placeOnTrack(track, track.length - 20, 0);
      world.addCar(car, new ScriptedDriver(0));
      while (world.time < 180 && car.lapsCompleted < 3) world.step();
      expect(car.lapsCompleted).toBe(3);
      expect(car.wallHits).toBe(0);
      expect(car.health).toBe(1);
      console.log(`${name}: L=${track.length.toFixed(0)}m laps=${car.lapTimes.map((t) => t.toFixed(2)).join(', ')} tire=${car.tireLife.toFixed(4)}`);
    });
  }
});

describe('walls', () => {
  const hit = (angleDeg: number, speed: number) => {
    const track = new Track(SPEEDWAY);
    const car = new Car(0);
    car.placeOnTrack(track, 20, -track.halfWidth + P.CAR_RADIUS + 0.01);
    const i = car.trackIdx;
    const a = deg(angleDeg);
    // Heading toward the outer wall (negative normal) at the given angle.
    car.vx = (track.tx[i] * Math.cos(a) + track.ty[i] * Math.sin(a)) * speed;
    car.vy = (track.ty[i] * Math.cos(a) - track.tx[i] * Math.sin(a)) * speed;
    car.frameX = car.vx / speed;
    car.frameY = car.vy / speed;
    car.x += car.vx * P.DT;
    car.y += car.vy * P.DT;
    const p = track.project(car.x, car.y, car.trackIdx);
    car.d = p.d;
    car.trackIdx = p.idx;
    resolveWalls(car, track);
    return car;
  };

  it('turns a shallow contact into a scrape that keeps most of the speed', () => {
    const brush = hit(3, 70);
    expect(brush.speed / 70).toBeGreaterThan(0.96);
    expect(brush.health).toBeGreaterThan(0.95);
    const scrape = hit(8, 70);
    expect(scrape.speed / 70).toBeGreaterThan(0.9);
    expect(scrape.health).toBeGreaterThan(0.65);
    expect(scrape.damageHandling).toBeGreaterThan(scrape.damageAero);
  });

  it('punishes a steep hit with speed loss and damage', () => {
    const car = hit(45, 25);
    expect(car.speed / 25).toBeLessThan(0.75);
    expect(car.health).toBeLessThan(0.6);
    // At 45 deg the velocity change mostly opposes travel: a deceleration hit.
    expect(car.damageAero).toBeGreaterThan(car.damageHandling);
  });
});

describe('tire wear', () => {
  it('wears hardest under lateral load, least driving straight', () => {
    const wear = (ix: number, iy: number) => {
      const track = new Track({ ...SPEEDWAY, straightLength: 8000, bankStraight: 0 });
      const car = new Car(0);
      car.placeOnTrack(track, 100, 0);
      car.vx = 60;
      car.vy = 0;
      car.inputX = ix;
      car.inputY = iy;
      for (let k = 0; k < 60; k++) {
        const vx = car.vx, vy = car.vy; // hold the state: we only measure wear rate
        stepCar(car, track, P.DT);
        car.vx = vx; car.vy = vy;
      }
      return 1 - car.tireLife;
    };
    const lateral = wear(0, 0.8);
    const braking = wear(-0.8, 0);
    const driving = wear(0.8, 0);
    expect(lateral).toBeGreaterThan(braking * 2);
    expect(braking).toBeGreaterThan(driving);
  });
});
