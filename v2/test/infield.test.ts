import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, venueLayouts, validateVenue, type ShapedOvalParams } from '../src/trackgen';
import { validateLayout } from '../src/trackgen/validate';
import type { TrackLayout } from '../src/sim/layout';

/**
 * Generated ovals whose infields have services (the first `count` from `seed` on): where a road course goes in, the
 * infield is the course's and the services (placeholders for now) stay out.
 */
const withServices = (variant: string, count: number, seed = 1): TrackLayout[] => {
  const out: TrackLayout[] = [];
  for (let s = seed; out.length < count && s < seed + 200; s++) {
    const layout = generateLayout({ type: 'oval', seed: s, variant });
    if (!layout.infield.rovals?.length) out.push(layout);
  }
  return out;
};
const generated = (variant: string, count: number) => withServices(variant, count).map((l) => new Track(l));

describe('generated infields', () => {
  const tracks = [...generated('short', 2), ...generated('intermediate', 2), ...generated('speedway', 2), ...generated('superspeedway', 2)];

  it('lays out a service road, escape roads and the garage as one network', () => {
    for (const t of tracks) {
      const roads = t.roads;
      const escapes = roads.roads.filter((r) => r.grade === 'escape');
      expect(escapes.length, t.name).toBeGreaterThanOrEqual(1);
      expect(roads.roads.some((r) => r.id.startsWith('ring')), t.name).toBe(true);
      // Every way off the oval leads to a garage, and the escape roads are the infield's escape lanes.
      for (const n of roads.accesses) expect(roads.pathToGarage(n.id), `${t.name} ${n.id}`).not.toBeNull();
      expect(t.infield.escapeLanes).toHaveLength(escapes.length);
      expect(validateLayout(t.layout, t).filter((p) => p.severity === 'error')).toEqual([]);
    }
  });

  it('keeps escape roads off pit road, leaving the apron before and after the turns', () => {
    for (const t of tracks) {
      for (const n of t.roads.accesses.filter((a) => a.id.startsWith('escape'))) {
        const s = n.s!;
        expect(s > t.pit.entryStart - 40 && s < t.pit.exitEnd + 20, `${t.name} ${n.id}`).toBe(false);
        const p = t.project(...n.at);
        expect(p.d).toBeGreaterThan(t.innerEdgeAt(p.s) - 1);
        expect(p.d).toBeLessThan(t.pavedInnerD(p.s));
      }
    }
  });

  it('tows wreckers from an escape road along the service road to the garage', () => {
    const t = tracks[4];
    const path = t.roads.pathToGarage('escape0')!;
    expect(path.length).toBeGreaterThan(5); // escape road, then service road, then into the garage
    const [x, y] = path[path.length - 1];
    const p = t.project(x, y);
    const lot = t.infield.garage.lot;
    expect(t.inRange(p.s, [lot.s0 - 5, lot.s1 + 5]) && p.d >= lot.d0 - 1 && p.d <= lot.d1 + 1).toBe(true);
  });

  it('sometimes puts a smaller oval in the infield: a venue of two layouts', () => {
    const found = withServices('speedway', 30).map((l) => new Track(l)).find((t) => t.neighbours.length) ?? null;
    expect(found).not.toBeNull();
    const outer = found!;
    const plan = (outer.layout.params as unknown as ShapedOvalParams).infield!;
    expect(plan.inner).not.toBeNull();
    const layouts = venueLayouts(outer.layout).filter((l) => l.kind !== 'road'); // (its road courses aside)
    expect(layouts).toHaveLength(2);
    expect(layouts[1].neighbours!.map((l) => l.id)).toEqual([outer.layout.id]);
    expect(validateVenue(layouts.map((l) => ({ ...l, neighbours: undefined })))).toEqual([]);
    // No cross-infield roads through it.
    expect(outer.roads.roads.some((r) => r.id.startsWith('link'))).toBe(false);
    // Both can be lapped, each with the other round it.
    for (const layout of layouts) {
      const t = new Track(layout);
      const world = new World(t, { collisions: false });
      const car = new Car(0);
      car.placeOnTrack(t, t.length - 20, 0);
      world.addCar(car, new ScriptedDriver(0, 0.9));
      while (car.lapsCompleted < 1 && world.time < 300) world.step();
      expect(car.lapsCompleted, t.name).toBe(1);
      expect(car.health, t.name).toBe(1);
    }
  });

  it('puts inner ovals in different places, sometimes turned across an end; and lays skidpads', () => {
    const layouts = withServices('superspeedway', 24, 100);
    const inners = layouts.flatMap((l) => l.neighbours ?? []);
    expect(inners.length).toBeGreaterThan(3);
    const places = new Set(inners.map((l) => `${Math.round(l.placement!.x / 50)},${Math.round(l.placement!.y / 50)},${l.placement!.angle}`));
    expect(places.size).toBeGreaterThan(1);
    const pads = layouts.filter((l) => l.surfaces.some((r) => r.id === 'skidpad'));
    expect(pads.length).toBeGreaterThan(0);
    for (const l of pads) {
      const t = new Track(l);
      const pad = l.surfaces.find((r) => r.id === 'skidpad')!.shape as { points: Array<[number, number]>; width: number };
      const [x, y] = pad.points[0];
      const p = t.project(x, y);
      expect(t.surfaceAt(p.s, p.d, x, y)).toBe('road'); // a disc you can drive on
      expect(t.roads.nodes.has('skidpad')).toBe(true);
    }
  });

  it('parks lots off the service road, clear of each other and the infield\'s middle', () => {
    for (const t of tracks) {
      const lots = t.layout.surfaces.filter((r) => r.id.startsWith('lot') && r.shape.kind === 'rect');
      expect(t.layout.decor.filter((d) => d.kind === 'bays')).toHaveLength(lots.length);
      for (const r of lots) {
        const rect = (r.shape as { rect: { s0: number; s1: number; d0: number; d1: number } }).rect;
        // The back of the lot is still on this side of the infield.
        const [x, y] = t.toWorld((rect.s0 + rect.s1) / 2, rect.d1);
        const p = t.project(x, y);
        expect(Math.abs(t.signedS(p.s - (rect.s0 + rect.s1) / 2))).toBeLessThan(1);
      }
    }
  });
});
