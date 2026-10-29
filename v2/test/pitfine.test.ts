import { describe, expect, it } from 'vitest';
import { adaptPitWeights, adaptWeights, DRIVER_LAYERS, PIT_NET_LAYERS, ScriptedDriver, Team } from '../src/ai/drivers';
import { genomeSize, Network } from '../src/ai/network';
import { PIT_FINE_SIZE } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { World } from '../src/sim/world';
import { FLAT_TRACK, ovalTrack } from '../src/trackgen';

describe("the pit skill's own inputs", () => {
  it('a pit skill learned before them widens into its network and drives exactly as it did, whatever they say', () => {
    const rng = new Rng(7);
    const old = Float32Array.from({ length: genomeSize(DRIVER_LAYERS) }, () => rng.gaussian() * 0.3);
    const before = new Network(DRIVER_LAYERS, old), after = new Network(PIT_NET_LAYERS, adaptPitWeights(old));
    // (A widened pit skill passes adaptWeights as it is.)
    expect(adaptWeights(adaptPitWeights(old)).length).toBe(genomeSize(PIT_NET_LAYERS));
    for (let t = 0; t < 50; t++) {
      const x = Float32Array.from({ length: DRIVER_LAYERS[0] }, () => rng.next() * 2 - 1);
      const wide = new Float32Array(PIT_NET_LAYERS[0]);
      wide.set(x);
      for (let k = DRIVER_LAYERS[0]; k < wide.length; k++) wide[k] = rng.next() * 2 - 1;
      const a = Array.from(before.forward(x)), b = Array.from(after.forward(wide));
      expect(b[0]).toBeCloseTo(a[0], 6);
      expect(b[1]).toBeCloseTo(a[1], 6);
    }
  });

  it('are zeros off a pit cycle, and say where the route is and how fast the stop allows on one', () => {
    const track = ovalTrack(FLAT_TRACK);
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    car.placeOnTrack(track, track.wrapS(track.pit.entryStart - 200), 0);
    car.vx = track.tx[car.trackIdx] * 40;
    car.vy = track.ty[car.trackIdx] * 40;
    const team = new Team(new ScriptedDriver(0), new TowerSpotter(), null);
    world.addCar(car, team);
    world.step();
    expect(team.pitFine.length).toBe(PIT_FINE_SIZE);
    expect(Array.from(team.pitFine).every((v) => v === 0)).toBe(true);
    car.pit.phase = 'in';
    car.pit.call = { tires: true, fuel: 0, repair: false };
    car.pit.boxS = track.pit.stalls[10];
    team.autopilot.begin(car);
    let sawOver = false, sawOff = false;
    while (world.time < 60 && car.pit.phase === 'in') {
      world.step();
      if (team.pitFine[3] > 0) sawOver = true;
      if (Math.abs(team.pitFine[0]) > 0.05) sawOff = true;
      // Never outside its range.
      for (const v of team.pitFine) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    expect(car.pit.phase).toBe('service');
    // Coming in at 40 m/s it was over what the stop allows somewhere, and off its route somewhere (crossing to it).
    expect(sawOver).toBe(true);
    expect(sawOff).toBe(true);
  });
});
