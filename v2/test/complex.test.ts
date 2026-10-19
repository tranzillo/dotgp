import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { resolveWalls } from '../src/sim/collisions';
import { layoutKind } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { complexLayouts, MEGA_COMPLEX, type ComplexSpec } from '../src/trackgen';
import { multiLayoutVenue, venueSeries } from '../src/venue/venue';

const layouts = complexLayouts(MEGA_COMPLEX);
const tracks = layouts.map((l) => new Track(l));
const [superspeedway, speedway] = tracks;

describe('the mega complex', () => {
  it('is a venue of four layouts, each with the other three as scenery', () => {
    expect(layouts.map((l) => l.name)).toEqual(['Superspeedway', 'Speedway', 'Short track', 'Bullring']);
    expect(layouts.map(layoutKind)).toEqual(['superspeedway', 'speedway', 'short-oval', 'short-oval']);
    for (const l of layouts) {
      expect(l.neighbours!.map((n) => n.name).sort()).toEqual(layouts.filter((o) => o !== l).map((o) => o.name).sort());
      expect(l.neighbours!.every((n) => !n.neighbours)).toBe(true);
    }
    expect(new Set(layouts.map((l) => l.id)).size).toBe(4);
    // Stock cars race all of it, the short track series the two short ovals; road racing waits for the road courses.
    const venue = multiLayoutVenue(MEGA_COMPLEX.id, MEGA_COMPLEX.name, layouts);
    expect(venueSeries(venue).map((s) => s.id)).toEqual(['stock', 'short']);
    expect(superspeedway.length).toBeGreaterThan(4500);
    expect(superspeedway.length).toBeGreaterThan(speedway.length);
  });

  it('can be lapped cleanly on every ring, the others round it', () => {
    for (const track of tracks) {
      const world = new World(track, { collisions: false });
      const car = new Car(0);
      car.placeOnTrack(track, track.length - 20, 0);
      world.addCar(car, new ScriptedDriver(0, 0.9));
      while (car.lapsCompleted < 1 && world.time < 300) world.step();
      expect(car.lapsCompleted, track.name).toBe(1);
      expect(car.health, track.name).toBe(1);
    }
  });

  it('keeps world positions with each ring when it is placed', () => {
    const bullring = tracks[3];
    expect(bullring.layout.placement).toEqual({ x: -700, y: 0, angle: 0 });
    const lot = bullring.infield.garage.lot;
    const [x, y] = bullring.toWorld(lot.s0 + 8, lot.d1 - 3);
    expect(bullring.infield.garage.parking[0][0]).toBeCloseTo(x, 6);
    expect(bullring.infield.garage.parking[0][1]).toBeCloseTo(y, 6);
    // The escape lane starts at the bullring's apron, where it is now.
    const start = bullring.project(...bullring.infield.escapeLanes[0].points[0]);
    expect(start.d).toBeGreaterThan(bullring.innerEdgeAt(start.s) - 1);
    expect(start.d).toBeLessThan(bullring.pavedInnerD(start.s));
  });

  it('lets cars drive on the other rings: their pavement, not more of this one', () => {
    // From the superspeedway: the speedway's racing surface and apron in its infield, grass between.
    const s = 300; // a long straight of the speedway
    const on = (t: Track, d: number) => t.toWorld(s, d);
    const at = (t: Track, [x, y]: [number, number]) => {
      const p = t.project(x, y);
      return t.surfaceAt(p.s, p.d, x, y);
    };
    expect(at(superspeedway, on(speedway, 0))).toBe('track');
    expect(at(superspeedway, on(speedway, speedway.innerEdgeAt(s) + 2))).toBe('apron');
    expect(at(superspeedway, on(speedway, speedway.outerEdgeAt(s) - 40))).toBe('grass');
    // From the speedway, out past its wall: grass, then the superspeedway's surface (not the speedway's open run-on).
    expect(at(speedway, on(speedway, speedway.outerEdgeAt(s) - 20))).toBe('grass');
    const ssPoint = superspeedway.toWorld(superspeedway.length / 2, 0);
    expect(at(speedway, ssPoint)).toBe('track');
  });

  it('makes the other rings walls solid from outside too', () => {
    // A car on the superspeedway's infield grass, touching the speedway's outer wall from outside, gets pushed back out.
    const s = 300;
    const wallFace = speedway.outerEdgeAt(s) - 0.8;
    const car = new Car(0);
    const [x, y] = speedway.toWorld(s, wallFace - 1.2); // 0.3 m into the wall
    const p = superspeedway.project(x, y);
    car.placeOnTrack(superspeedway, p.s, p.d);
    const [nx, ny] = [-speedway.ty[speedway.indexAt(s)], speedway.tx[speedway.indexAt(s)]];
    car.vx = nx * 10; car.vy = ny * 10; // heading for the wall
    resolveWalls(car, superspeedway);
    expect(car.wallContact).toBe(true);
    expect(speedway.project(car.x, car.y).d).toBeLessThan(wallFace - 0.8);
    expect(car.vx * nx + car.vy * ny).toBeLessThan(0); // bounced back out
  });

  it('runs a field on the speedway with the complex round it', () => {
    const world = new World(speedway);
    for (let k = 0; k < 6; k++) {
      const car = new Car(k);
      car.placeOnTrack(speedway, speedway.length - 30 - 12 * k, k % 2 ? -4 : 4);
      world.addCar(car, new ScriptedDriver(k, 0.85));
    }
    while (world.time < 90) world.step();
    expect(world.cars.every((c) => c.lapsCompleted >= 1)).toBe(true);
  });

  it('refuses rings that get in each other\'s way', () => {
    const crowded: ComplexSpec = {
      ...MEGA_COMPLEX,
      rings: MEGA_COMPLEX.rings.map((r) => (r.id === 'bullring' ? { ...r, placement: { x: -330, y: 0, angle: 0 } } : r)),
    };
    expect(() => complexLayouts(crowded)).toThrow(/Bullring.*within 20 m of Speedway|Speedway.*within 20 m of Bullring/);
  });
});
