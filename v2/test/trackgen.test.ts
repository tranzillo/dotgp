import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { resolveWalls } from '../src/sim/collisions';
import {
  buildLayout, generateLayout, hashSeed, OVAL_SHAPES, OVAL_SIZE_CLASSES, ovalTrack, presetLayout, presetTrack, SHORT_TRACK, SPEEDWAY, type ShapedOvalParams,
} from '../src/trackgen';

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

  it('keeps the presets exactly as they were: drivers are trained on them', () => {
    // A change here means every trained driver is racing a different track. Change only on purpose.
    // (Changed 2026-10-23 on purpose: the pit wall a car's width and a metre clear of the track, the inside pit wall and
    // crews' strip behind the boxes, at most 40 boxes, a blend ending soon after the exit: training/TRACK-CHANGES.md.)
    expect(hashSeed(0, JSON.stringify(presetLayout('speedway')))).toBe(1551759429);
    expect(hashSeed(0, JSON.stringify(presetLayout('short')))).toBe(979755758);
    expect(hashSeed(0, JSON.stringify(presetLayout('flat')))).toBe(2102541862);
  });

  for (const [variant, cls] of Object.entries(OVAL_SIZE_CLASSES)) {
    for (const shape of Object.keys(cls.shapes)) {
      it(`makes ${variant} ${shape}s that close and lap cleanly`, () => {
        for (const seed of [11, 12]) {
          const layout = generateLayout({ type: 'oval', seed, variant, params: { shape } });
          const track = new Track(layout);
          expect(track.closureError, `${shape} seed ${seed}`).toBeLessThan(0.1);
          expect((layout.params as unknown as ShapedOvalParams).shape).toBe(shape);
          // The line is on the front stretch, inside pit road's wall.
          expect(layout.pit.wallStart).toBeLessThan(0);
          expect(layout.pit.wallEnd).toBeGreaterThan(0);
          const world = new World(track, { collisions: false });
          const car = new Car(0);
          car.placeOnTrack(track, track.length - 20, 0);
          world.addCar(car, new ScriptedDriver(0, 0.9));
          while (car.lapsCompleted < 1 && world.time < 400) world.step();
          expect(car.lapsCompleted, `${shape} seed ${seed}`).toBe(1);
          expect(car.health, `${shape} seed ${seed}`).toBe(1);
        }
      });
    }
  }

  it('banks each corner by its design speed: a tri-oval bend much less than the turns', () => {
    const layout = generateLayout({ type: 'oval', seed: 3, variant: 'superspeedway', params: { shape: 'tri-oval' } });
    const [bend, t1, t2] = (layout.params as unknown as ShapedOvalParams).corners;
    expect(bend.dogleg).toBe(true);
    expect(bend.radius).toBeGreaterThan(2 * t1.radius);
    expect(bend.bankInner).toBeLessThan(0.75 * Math.min(t1.bankInner, t2.bankInner));
    // The line is at the bend's apex: the track curves there.
    const track = new Track(layout);
    expect(track.curvatureAt(0)).toBeCloseTo(1 / bend.radius, 6);
  });

  it('lays out the shapes it is asked for, with their corners', () => {
    const corners = (shape: string) => (generateLayout({ type: 'oval', seed: 7, variant: 'speedway', params: { shape } }).params as unknown as ShapedOvalParams).corners;
    expect(corners('rectangle').map((c) => Math.round(c.angle * 180 / Math.PI))).toEqual([90, 90, 90, 90]);
    expect(corners('triangle')).toHaveLength(3);
    expect(corners('quad-oval').filter((c) => c.dogleg)).toHaveLength(2);
    const [a, b] = corners('egg');
    expect(a.radius).not.toBe(b.radius);
    for (const shape of OVAL_SHAPES.filter((s) => OVAL_SIZE_CLASSES.speedway.shapes[s])) {
      expect(corners(shape).reduce((x, c) => x + c.angle, 0), shape).toBeCloseTo(2 * Math.PI, 9);
    }
  });

  it('rejects layouts that do not fit: a garage reaching across a tiny infield', () => {
    expect(() => buildLayout('oval', { ...SHORT_TRACK, turnRadius: 40, easementLength: 15 })).toThrow(/infield/);
  });

  it('keeps every preset valid, with its features in place', () => {
    for (const id of ['speedway', 'short', 'flat']) {
      const t = presetTrack(id);
      expect(t.pit.stalls.length).toBeGreaterThan(0);
      expect(t.infield.escapeLanes.length).toBeGreaterThan(0);
      // The outer wall, the pit wall, and the inside pit wall behind the boxes (in pieces round the garage's way in).
      const ids = t.walls.map((w) => w.id);
      expect(ids.slice(0, 2)).toEqual(['outer', 'pit-wall']);
      expect(ids.slice(2).every((id) => id.startsWith('pit-inner-wall'))).toBe(true);
      expect(t.wallCaps.length).toBe(2 * (ids.length - 1));
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
