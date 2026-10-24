import { describe, expect, it } from 'vitest';
import { initialWeights } from '../src/ai/es';
import { ScriptedDriver, Team } from '../src/ai/drivers';
import { pitPath, type CrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { PERFECT_SPOTTER, TowerSpotter } from '../src/ai/spotter';
import { Session } from '../src/events/session';
import { Car, type PitCall } from '../src/sim/car';
import { PIT_SERVICE } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { setBackPitTrack } from '../src/school/classroom';
import { generateLayout, PRESETS, presetLayout, type ShapedOvalParams } from '../src/trackgen';
import { noseClearance } from '../src/trackgen/stages';

class CallOnce implements CrewChief {
  lastMessage = 'Box this lap';
  private called = false;
  decide(): PitCall | null {
    if (this.called) return null;
    this.called = true;
    return { tires: true, fuel: 30, repair: false };
  }
}

/** A scripted car called in once: the whole pit cycle, as the pit tests run it. */
function pitCycle(track: Track, box = 0): { stops: number; health: number; maxPitSpeed: number; rejoined: boolean } {
  const world = new World(track, { collisions: false });
  const car = new Car(0);
  placeOnGrid(car, track, 0, true);
  car.fuel = 20;
  car.tireLife = 0.5;
  world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), new CallOnce()));
  car.pit.boxS = track.pit.stalls[box];
  let maxPitSpeed = 0;
  while (world.time < 400) {
    world.step();
    if (car.surface === 'pit' && car.pit.phase === 'in' && track.pitInR(car) > track.pit.wallStart + 30) maxPitSpeed = Math.max(maxPitSpeed, car.speed);
    if (car.pit.stops === 1 && car.pit.phase === 'none') {
      for (let k = 0; k < 360; k++) world.step();
      return { stops: 1, health: car.health, maxPitSpeed, rejoined: car.d < track.halfWidth };
    }
  }
  return { stops: car.pit.stops, health: car.health, maxPitSpeed, rejoined: false };
}

const setBack = setBackPitTrack(5);

describe('generated pit complexes', () => {
  it('sets some pit roads back across grass, with lanes in and out and a grass island in front', () => {
    expect(setBack.pit.entryRoute).toBeDefined();
    const gap = setBack.pit.wallD - setBack.innerEdgeAt(setBack.pit.wallStart) - setBack.pit.wallThickness / 2;
    expect(gap).toBeGreaterThanOrEqual(4);
    const path = pitPath(setBack);
    expect(path.laid).toBe(true);
    // The lane starts on the apron at the entry and reaches the fast lane before the wall's nose.
    const p = setBack.pit;
    expect(path.inAt(p.entryStart)).toBeLessThan(setBack.innerEdgeAt(p.entryStart) + setBack.apronWidth);
    expect(path.inAt(p.wallStart)).toBeGreaterThan(p.wallD);
    // On it: pavement; between it and the apron, midway down pit road: grass.
    const mid = (p.wallStart + p.wallEnd) / 2;
    const surface = (s: number, d: number) => { const [x, y] = setBack.toWorld(s, d); return setBack.surfaceAt(s, d, x, y); };
    expect(surface(mid, setBack.innerEdgeAt(mid) + setBack.apronWidth + gap / 2)).toBe('grass');
    expect(surface(mid, p.wallD + 6 + setBack.pitOffset(mid))).toBe('pit'); // (further in on a chord)
    const s = (p.entryStart + path.inEnd) / 2;
    expect(['apron', 'track']).toContain(surface(s, path.inAt(s)));
  });

  it('builds the road network: pit road and its lanes, the garage, the escape roads', () => {
    const roads = setBack.roads;
    const ids = roads.accesses.map((n) => n.id);
    expect(ids).toContain('pit-entry');
    // (Escape roads are the infield's services, which stay out where a road course goes in.)
    if (!setBack.layout.infield.rovals?.length) expect(ids.some((id) => id.startsWith('escape'))).toBe(true);
    for (const id of ids) expect(roads.pathToGarage(id)?.length).toBeGreaterThan(0);
    // Pit exit only joins the oval (one way).
    expect(roads.roads.find((r) => r.id === 'pit-exit')?.oneWay).toBe(true);
  });

  it('runs the scripted pit cycle cleanly on set-back and classic pit roads alike', () => {
    const classic = [1, 2, 3].map((seed) => new Track(generateLayout({ type: 'oval', seed, variant: 'speedway' }))).find((t) => !t.pit.entryRoute)!;
    for (const track of [setBack, setBackPitTrack(11), classic]) {
      const r = pitCycle(track);
      expect(r.stops, track.name).toBe(1);
      expect(r.health, track.name).toBe(1);
      expect(r.rejoined, track.name).toBe(true);
      expect(r.maxPitSpeed, track.name).toBeLessThan(PIT_SERVICE.SPEED_LIMIT + 1);
    }
  });

  it('runs pit road straight across a tri-oval on a chord, as at Daytona', () => {
    let chord: Track | null = null;
    for (let seed = 1; seed < 60 && !chord; seed++) {
      const t = new Track(generateLayout({ type: 'oval', seed, variant: 'superspeedway', params: { shape: 'tri-oval' } }));
      if (t.pit.offset) chord = t;
    }
    expect(chord).not.toBeNull();
    const t = chord!;
    const p = t.pit;
    // Furthest from the track mid pit road, close to it at the ends.
    const mid = (p.wallStart + p.wallEnd) / 2;
    expect(t.pitOffset(mid)).toBeGreaterThan(20);
    expect(t.pitOffset(p.wallStart)).toBeLessThan(t.pitOffset(mid) / 3);
    // The wall (where it isn't rounded off at the ends) is straight in the world.
    const pts: Array<[number, number]> = [];
    for (let s = p.wallStart + 0.15 * (p.wallEnd - p.wallStart); s <= p.wallEnd - 0.15 * (p.wallEnd - p.wallStart); s += 10) pts.push(t.toWorld(s, p.wallD + t.pitOffset(s)));
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay);
    const off = Math.max(...pts.map(([x, y]) => Math.abs(((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / len)));
    expect(off).toBeLessThan(2.5);
    // Grass between the bulge and pit road; the garage behind pit road where it's furthest in.
    const surface = (s: number, d: number) => { const [x, y] = t.toWorld(s, d); return t.surfaceAt(s, d, x, y); };
    expect(surface(mid, t.innerEdgeAt(mid) + t.apronWidth + t.pitOffset(mid) / 2)).toBe('grass');
    expect(t.infield.garage.lot.d0).toBeGreaterThanOrEqual(p.roadD + t.pitOffset(mid) - 1e-6);
    const r = pitCycle(t);
    expect(r.stops).toBe(1);
    expect(r.health).toBe(1);
    expect(r.rejoined).toBe(true);
  });

  it('shrinks a set-back pit road to fit a short front stretch, or puts it against the track', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const layout = generateLayout({ type: 'oval', seed, variant: 'short' });
      const t = new Track(layout);
      const plan = (layout.params as unknown as ShapedOvalParams).pits!;
      const gap = t.pit.wallD - t.innerEdgeAt(t.pit.wallStart) - t.pit.wallThickness / 2;
      // (No nearer than the nose clearance: a car on the inside line can't touch the wall.)
      expect(gap).toBeLessThanOrEqual(Math.max(plan.gap, noseClearance()) + 1e-9);
      if (t.pit.entryRoute) expect(t.pit.wallEnd - t.pit.wallStart).toBeGreaterThanOrEqual(12 * plan.stallSpacing + 40);
    }
  });

  it('keeps the presets on the classic pit road, wreckers on their old routes', () => {
    for (const id of Object.keys(PRESETS)) {
      const layout = presetLayout(id);
      expect(layout.pit.entryRoute).toBeUndefined();
      expect(layout.infield.network).toBeUndefined();
    }
  });

  it('finds set-back pit roads for the pit lesson (its every other round)', () => {
    for (const seed of [1, 2, 3]) expect(setBackPitTrack(seed).pit.entryRoute).toBeDefined();
  });

  it('leaves set-back pit roads to the maneuver for drivers who have not made a stop on one', () => {
    const w = initialWeights(new Rng(2));
    const entrant = (setBackPits: boolean) => ({
      key: 1, fill: '#fff', driver: { id: 'D', weights: w, pits: true, setBackPits },
      spotter: { id: 'S', skill: PERFECT_SPOTTER }, chief: { id: 'C', brain: { kind: 'scripted' as const, traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
    });
    const driverPits = (layout: ReturnType<typeof presetLayout>, setBackPits: boolean) => {
      const s = new Session({ kind: 'practice', layout, entrants: [entrant(setBackPits)], laps: 1, pace: 4, seed: 1 });
      return (s.world.controllers[0] as unknown as { driverPits: boolean }).driverPits;
    };
    expect(driverPits(presetLayout('short'), false)).toBe(true);
    expect(driverPits(setBack.layout, false)).toBe(false);
    expect(driverPits(setBack.layout, true)).toBe(true);
  });
});

describe("circuits' laid pit entries", () => {
  it('lays an entry across the inside of the last corner, grass between, and the scripted pit cycle runs it cleanly', () => {
    const track = new Track(generateLayout({ type: 'circuit', seed: 12, variant: 'club' }));
    const p = track.pit;
    expect(p.entryRoute).toBeDefined();
    expect(p.wallStart - p.entryStart).toBeGreaterThanOrEqual(200);
    const path = pitPath(track);
    expect(path.laid).toBe(true);
    // From inside the track's edge, round onto pit road's line before the wall's nose.
    expect(path.inAt(p.entryStart)).toBeLessThan(track.innerEdgeAt(p.entryStart));
    expect(path.inAt(path.inEnd)).toBeGreaterThan(p.wallD);
    // Somewhere across the corner, grass between the track and the lane, and the lane paved.
    const surface = (s: number, d: number) => { const [x, y] = track.toWorld(s, d); return track.surfaceAt(s, d, x, y); };
    let island = false;
    for (let s = p.entryStart; s < path.inEnd; s += 5) {
      expect(surface(s, path.inAt(s))).not.toBe('grass');
      const gap = (track.innerEdgeAt(s) + path.inAt(s)) / 2;
      if (path.inAt(s) - track.innerEdgeAt(s) > 12 && surface(s, gap) === 'grass') island = true;
    }
    expect(island).toBe(true);
    const r = pitCycle(track);
    expect(r.stops).toBe(1);
    expect(r.health).toBeGreaterThan(0.99);
    expect(r.rejoined).toBe(true);
    expect(r.maxPitSpeed).toBeLessThan(PIT_SERVICE.SPEED_LIMIT + 1);
  });
});

describe("short ovals' pit road down both straights", () => {
  it('runs pit road from the back straight round the last turn onto the front stretch, boxes on both, and stops at either end of it', () => {
    const track = new Track(presetLayout('short'));
    const p = track.pit;
    // (Its pit lane runs past the half-lap point, so its s goes on past it.)
    expect(track.pitLong).toBe(true);
    expect(p.entryStart).toBeLessThan(-track.length / 2);
    expect(track.maxField).toBeGreaterThanOrEqual(20);
    // Boxes on the back straight and on the front stretch, none round the turn between.
    const turn = p.stalls.findIndex((s, k) => k > 0 && s - p.stalls[k - 1] > 100);
    expect(turn).toBeGreaterThan(5);
    expect(p.stalls.length - turn).toBeGreaterThan(5);
    for (const box of [0, turn - 1, turn, p.stalls.length - 1]) {
      const r = pitCycle(track, box);
      expect(r.stops).toBe(1);
      expect(r.health).toBeGreaterThan(0.99);
      expect(r.rejoined).toBe(true);
      expect(r.maxPitSpeed).toBeLessThan(PIT_SERVICE.SPEED_LIMIT + 1);
    }
  });
});
