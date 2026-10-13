import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { resolveWalls } from '../src/sim/collisions';
import { buildLayout, generateLayout, ovalTrack, OVAL_SIZE_CLASSES, presetTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';

describe('track generation', () => {
  it('is deterministic: the same seed gives the same layout', () => {
    const a = generateLayout({ type: 'oval', seed: 42 });
    const b = generateLayout({ type: 'oval', seed: 42 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(generateLayout({ type: 'oval', seed: 43 }))).not.toBe(JSON.stringify(a));
  });

  it('round-trips through JSON: a saved layout rebuilds the same track', () => {
    const layout = generateLayout({ type: 'oval', seed: 5, variant: 'short' });
    const a = new Track(layout);
    const b = new Track(JSON.parse(JSON.stringify(layout)));
    expect(b.length).toBe(a.length);
    for (let s = 0; s < a.length; s += 7) {
      for (let d = -10; d < 60; d += 3) {
        const [x, y] = a.toWorld(s, d);
        expect(b.surfaceAt(s, d, x, y)).toBe(a.surfaceAt(s, d, x, y));
        expect(b.bankAt(b.indexAt(s), d)).toBe(a.bankAt(a.indexAt(s), d));
      }
    }
  });

  for (const variant of Object.keys(OVAL_SIZE_CLASSES)) {
    it(`makes ${variant} ovals a scripted driver can lap cleanly`, () => {
      for (const seed of [1, 2, 3]) {
        const track = new Track(generateLayout({ type: 'oval', seed, variant }));
        const world = new World(track, { collisions: false });
        const car = new Car(0);
        car.placeOnTrack(track, track.length - 20, 0);
        world.addCar(car, new ScriptedDriver(0, 0.9));
        while (car.lapsCompleted < 1 && world.time < 200) world.step();
        expect(car.lapsCompleted, `${variant} seed ${seed}`).toBe(1);
        expect(car.health, `${variant} seed ${seed}`).toBe(1);
      }
    });
  }

  it('rejects layouts that do not fit: a garage reaching across a tiny infield', () => {
    expect(() => buildLayout('oval', { ...SHORT_TRACK, turnRadius: 40, easementLength: 15 })).toThrow(/infield/);
  });

  it('keeps every preset valid, with its features in place', () => {
    for (const id of ['speedway', 'short', 'flat']) {
      const t = presetTrack(id);
      expect(t.pit.stalls.length).toBeGreaterThan(0);
      expect(t.infield.escapeLanes.length).toBeGreaterThan(0);
      expect(t.walls.map((w) => w.id)).toEqual(['outer', 'pit-wall']);
      expect(t.wallCaps.length).toBe(2);
    }
  });

  it('widens the turns: surface, wall and banking follow the wider outside edge', () => {
    const track = ovalTrack({ ...SPEEDWAY, turnWidening: 6 });
    const straight = track.indexAt(0);
    const midTurn = track.indexAt(SPEEDWAY.straightLength / 2 + SPEEDWAY.easementLength + 300);
    expect(track.innerEdge(straight) - track.outerEdge(straight)).toBeCloseTo(18, 5);
    expect(track.innerEdge(midTurn) - track.outerEdge(midTurn)).toBeCloseTo(24, 5);
    expect(track.innerEdge(midTurn)).toBeCloseTo(9, 5); // widened to the outside only
    const s = midTurn * track.ds;
    expect(track.surfaceAt(s, -13)).toBe('track'); // beyond the straight's edge, still racing surface
    expect(track.bankAt(midTurn, -15)).toBeCloseTo(SPEEDWAY.bankOuter, 5); // full banking at the new outside edge
    // The wall stands at the new edge (d = -15): a car of radius 1.5 at d = -13 is clear of it, at -14 it touches.
    const touches = (d: number) => {
      const car = new Car(0);
      car.placeOnTrack(track, s, d);
      resolveWalls(car, track, 0);
      return car.wallContact;
    };
    expect(touches(-13)).toBe(false);
    expect(touches(-14)).toBe(true);
    // And the scripted driver still laps it cleanly.
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    car.placeOnTrack(track, track.length - 20, 0);
    world.addCar(car, new ScriptedDriver(0, 0.9));
    while (car.lapsCompleted < 1 && world.time < 200) world.step();
    expect(car.lapsCompleted).toBe(1);
    expect(car.health).toBe(1);
  });
});
