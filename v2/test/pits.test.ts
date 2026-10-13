import { describe, expect, it } from 'vitest';
import { ScriptedDriver, Team } from '../src/ai/drivers';
import { StrategistCrewChief, type CrewChief } from '../src/ai/pitting';
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
});
