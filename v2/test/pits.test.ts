import { describe, expect, it } from 'vitest';
import { ScriptedDriver, Team } from '../src/ai/drivers';
import { followLine } from '../src/ai/lineFollower';
import { pitLanes, StrategistCrewChief, type CrewChief } from '../src/ai/pitting';
import { TowerSpotter } from '../src/ai/spotter';
import { Car, type PitCall } from '../src/sim/car';
import { PIT_SERVICE } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { FLAT_TRACK, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';

class CallOnce implements CrewChief {
  lastMessage = 'Box this lap';
  private called = false;
  constructor(private readonly call: PitCall) {}
  decide(): PitCall | null {
    if (this.called) return null;
    this.called = true;
    return this.call;
  }
}

describe('pit stop', () => {
  for (const [name, spec] of [['speedway', SPEEDWAY], ['short', SHORT_TRACK], ['flat', FLAT_TRACK]] as const) {
    it(`completes a full cycle on the ${name}: in, stop, service, out, rejoin`, () => {
      const track = ovalTrack(spec);
      const world = new World(track, { collisions: false });
      const car = new Car(0);
      placeOnGrid(car, track, 0, true);
      car.fuel = 20;
      car.tireLife = 0.5;
      world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), new CallOnce({ tires: true, fuel: 30, repair: false })));

      let maxPitSpeed = 0;
      let rejoinedOnTrack = false;
      while (world.time < 300) {
        world.step();
        if (car.surface === 'pit' && car.pit.phase === 'in' && track.signedS(car.s) > track.pit.wallStart + 30) {
          maxPitSpeed = Math.max(maxPitSpeed, car.speed);
        }
        if (car.pit.stops === 1 && car.pit.phase === 'none') {
          for (let k = 0; k < 120 * 3; k++) world.step(); // a few seconds back in the driver's hands
          rejoinedOnTrack = car.d < track.halfWidth;
          break;
        }
      }
      const kinds = world.events.map((e) => e.kind);
      expect(kinds).toContain('crew');
      expect(kinds).toContain('pit-in');
      expect(kinds).toContain('pit-out');
      expect(car.pit.stops).toBe(1);
      expect(car.tireLife).toBeGreaterThan(0.95);
      expect(car.fuel).toBeGreaterThan(40);
      expect(maxPitSpeed).toBeLessThan(PIT_SERVICE.SPEED_LIMIT + 1);
      expect(car.health).toBe(1);
      expect(rejoinedOnTrack).toBe(true);
    });
  }
});

describe('reverse', () => {
  /** A car on its in-lap, driven in by the pit maneuver to `short` metres short of its box. */
  function nearItsBox(short: number) {
    const track = ovalTrack(SHORT_TRACK);
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    placeOnGrid(car, track, 0, true);
    world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), new CallOnce({ tires: true, fuel: 30, repair: false })));
    while (world.time < 300 && !(car.pit.phase === 'in' && car.surface === 'pit' && track.pitInR(car) > car.pit.boxS - short)) world.step();
    return { track, world, car };
  }

  it('on pit road, held on the brakes at a standstill a car shifts into reverse and backs up, at a crawl; off the brakes, back in drive', () => {
    const { track, world, car } = nearItsBox(25);
    car.vx = 0; car.vy = 0;
    world.controllers[0] = { decide: (c: Car) => { c.inputX = -1; c.inputY = 0; } };
    const r0 = track.pitInR(car);
    for (let k = 0; k < 0.4 * 120; k++) world.step();
    expect(car.reversing).toBe(false);
    expect(Math.abs(track.pitInR(car) - r0)).toBeLessThan(0.1); // the brakes only hold it, until it shifts
    for (let k = 0; k < 4 * 120; k++) world.step();
    expect(car.reversing).toBe(true);
    expect(track.pitInR(car)).toBeLessThan(r0 - 3);
    expect(car.speed).toBeLessThan(2.8); // its reverse speed (banking adds a little)
    world.controllers[0] = { decide: (c: Car) => { c.inputX = 0.5; c.inputY = 0; } };
    for (let k = 0; k < 3 * 120; k++) world.step();
    expect(car.reversing).toBe(false);
    expect(track.pitInR(car)).toBeGreaterThan(r0 - 20); // stopped rolling back, then drove on
  });

  it('on the track the brakes only ever stop a car', () => {
    const track = ovalTrack(FLAT_TRACK);
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    placeOnGrid(car, track, 0, true);
    car.vx = 0; car.vy = 0;
    world.addCar(car, { decide: (c: Car) => { c.inputX = -1; c.inputY = 0; } });
    const d0 = car.dist;
    let least = d0;
    for (let k = 0; k < 5 * 120; k++) { world.step(); least = Math.min(least, car.dist); }
    expect(car.reversing).toBe(false);
    expect(d0 - least).toBeLessThan(0.05); // never backwards
  });

  it('the pit maneuver stopped past its box backs up into it and makes its stop', () => {
    for (const past of [4, 9, 14]) {
      const { track, world, car } = nearItsBox(30);
      const move = car.pit.boxS + past - track.pitInR(car);
      car.placeOnTrack(track, track.wrapS(car.s + move), car.d, car.dist + move);
      car.vx = 0; car.vy = 0;
      let serviced = false;
      for (let k = 0; k < 40 * 120 && car.pit.phase !== 'out'; k++) {
        world.step();
        if (car.pit.phase === 'service') serviced = true;
      }
      expect(serviced).toBe(true);
    }
  });
});

describe('pit limiter', () => {
  it('a car coming in flat out is braked to the speed limit by the line, and held to it down pit road', () => {
    const track = ovalTrack(SPEEDWAY);
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    const lanes = pitLanes(track);
    car.placeOnTrack(track, track.wrapS(track.pit.wallStart - 120), lanes.fastLane + track.pitOffset(track.pit.wallStart - 120));
    car.vx = track.tx[car.trackIdx] * 45;
    car.vy = track.ty[car.trackIdx] * 45;
    // A driver holding the fast lane with its foot to the floor.
    world.addCar(car, { decide: (c: Car, w: World) => followLine(c, w, (s) => lanes.fastLane + track.pitOffset(s), () => Infinity, 1) });
    car.pit.phase = 'in';
    car.pit.call = { tires: true, fuel: 0, repair: false };
    car.pit.boxS = track.pit.stalls[track.pit.stalls.length - 1];
    let atLine = NaN, worst = 0;
    while (world.time < 20 && track.pitInR(car) < track.pit.wallStart + 80) {
      world.step();
      const r = track.pitInR(car);
      if (Number.isNaN(atLine) && r >= track.pit.wallStart) atLine = car.speed;
      if (r >= track.pit.wallStart) worst = Math.max(worst, car.speed);
    }
    expect(atLine).toBeLessThanOrEqual(PIT_SERVICE.SPEED_LIMIT);
    expect(worst).toBeLessThanOrEqual(PIT_SERVICE.SPEED_LIMIT + 0.1);
  });
});

describe('pit box', () => {
  it('a car stopped beside its box, short of it, is not serviced; the crew waves it in and the maneuver pulls it into the box', () => {
    const track = ovalTrack(FLAT_TRACK);
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    const lanes = pitLanes(track);
    const box = track.pit.stalls[5];
    car.placeOnTrack(track, track.wrapS(box), lanes.boxLane - 3 + track.pitOffset(box));
    car.vx = 0;
    car.vy = 0;
    // A pit-trained driver that has stopped short and stays there.
    const parked = { decide: (c: Car) => { c.inputX = 0; c.inputY = 0; } } as unknown as ScriptedDriver;
    world.addCar(car, new Team(parked, new TowerSpotter(), null, true));
    car.pit.phase = 'in';
    car.pit.call = { tires: true, fuel: 0, repair: false };
    car.pit.boxS = box;
    while (world.time < 1.9) world.step();
    expect(car.pit.phase).toBe('in');
    while (world.time < 15 && car.pit.phase === 'in') world.step();
    expect(car.pit.phase).toBe('service');
    expect(Math.abs(car.d - lanes.boxLane - track.pitOffset(car.s))).toBeLessThan(1.5);
  });
});

describe('crew chief', () => {
  it('calls the car in for fuel before it runs dry, and fuels only to the finish late on', () => {
    const track = ovalTrack(SPEEDWAY);
    const world = new World(track, { collisions: false, wearScale: 6 });
    world.raceLaps = 30;
    const car = new Car(0);
    placeOnGrid(car, track, 0, true);
    const chief = new StrategistCrewChief({ fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 });
    world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), chief));
    let minFuel = Infinity;
    while (world.time < 30 * 45 && car.lapsCompleted < 30) {
      world.step();
      minFuel = Math.min(minFuel, car.fuel);
    }
    expect(car.pit.stops).toBeGreaterThanOrEqual(1);
    expect(minFuel).toBeGreaterThan(0);
    expect(car.lapsCompleted).toBe(30);
  });
});

describe('race', () => {
  it('waves the checkered flag and classifies everyone', () => {
    const track = ovalTrack(SHORT_TRACK);
    const world = new World(track, { collisions: false });
    const cars = [0, 1, 2].map((k) => {
      const car = new Car(k);
      placeOnGrid(car, track, k, true);
      world.addCar(car, new ScriptedDriver(0, 0.85 + k * 0.04));
      return car;
    });
    const race = new Race(world, 3);
    while (race.state !== 'finished' && world.time < 300) race.step();
    expect(race.state).toBe('finished');
    const results = race.standings();
    expect(results.map((r) => r.status)).toEqual(['finished', 'finished', 'finished']);
    expect(results[0].car).toBe(cars[2]); // the bravest margin wins
    expect(results[0].laps).toBe(3);
    expect(results[1].time).toBeGreaterThan(results[0].time);
  });

  it('classifies lead-lap finishers ahead of lapped cars that flag first', () => {
    const track = ovalTrack(SHORT_TRACK);
    const world = new World(track, { collisions: false });
    const fast = new Car(0), slow = new Car(1), mid = new Car(2);
    for (const [k, car] of [fast, slow, mid].entries()) {
      placeOnGrid(car, track, k, true);
      world.addCar(car, new ScriptedDriver(0, [0.95, 0.55, 0.8][k]));
    }
    const race = new Race(world, 6);
    while (race.state !== 'finished' && world.time < 400) race.step();
    const st = race.standings();
    expect(st[0].car).toBe(fast);
    for (let i = 1; i < st.length; i++) expect(st[i].laps).toBeLessThanOrEqual(st[i - 1].laps);
  });
});

describe('pit exit merge', () => {
  it('waits on the apron while a car is alongside, then merges once clear', () => {
    const track = ovalTrack(SPEEDWAY);
    const world = new World(track, { collisions: true, drafting: false });
    // A: leaving the pits, on the apron just inside the merge zone.
    const a = new Car(0);
    world.addCar(a, new Team(new ScriptedDriver(0), new TowerSpotter(), null));
    const startS = track.pit.blendEnd - PIT_SERVICE.MERGE_ZONE + 5;
    a.placeOnTrack(track, startS, (track.halfWidth + track.apronEdgeAt(0)) / 2);
    a.pit.phase = 'out';
    a.pit.boxS = track.pit.wallStart + 25;
    const ia = a.trackIdx;
    a.vx = track.tx[ia] * 40; a.vy = track.ty[ia] * 40;
    // B: on the racing surface, low line, right alongside and a touch quicker.
    const b = new Car(1);
    world.addCar(b, new ScriptedDriver(4, 0.9));
    b.placeOnTrack(track, startS - 2, 4);
    const ib = b.trackIdx;
    b.vx = track.tx[ib] * 46; b.vy = track.ty[ib] * 46;

    let mergedWhileAlongside = false;
    let minGapWhenOnTrack = Infinity;
    while (world.time < 30 && a.pit.phase === 'out') {
      world.step();
      const gap = Math.abs(((b.s - a.s + track.length / 2) % track.length) - track.length / 2);
      if (a.d < track.halfWidth) {
        minGapWhenOnTrack = Math.min(minGapWhenOnTrack, gap);
        if (gap < 6) mergedWhileAlongside = true;
      }
    }
    expect(a.pit.phase).toBe('none'); // merged in the end
    expect(mergedWhileAlongside).toBe(false);
    expect(a.health).toBe(1);
    expect(b.health).toBe(1);
  });

  it('does not call for repairs lap after lap as a damaged car keeps scraping', () => {
    const track = ovalTrack(SPEEDWAY);
    const world = new World(track, { collisions: false });
    world.raceLaps = 60;
    const car = new Car(0);
    placeOnGrid(car, track, 0, true);
    const chief = new StrategistCrewChief({ fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.85, minLapsForTires: 5 });
    let repairs = 0;
    // Thirty laps of a car losing a little health every lap (and getting a repair whenever asked).
    for (let lap = 0; lap < 30; lap++) {
      car.lapTimes.push(35);
      car.health = Math.max(0.2, car.health - 0.04);
      const call = chief.decide(car, world);
      if (call?.repair) {
        repairs++;
        car.pit.stops++;
        car.health = 1 - (1 - car.health) * (1 - PIT_SERVICE.REPAIR_FRACTION) - 0.03; // a scrape on the way in
      }
    }
    expect(repairs).toBeGreaterThan(0);
    expect(repairs).toBeLessThanOrEqual(7); // about one per 5 laps of steady damage (the old rule called nearly every other lap)
  });
});
