import { describe, expect, it } from 'vitest';
import { adaptWeights, DRIVER_LAYERS, RADIO_DRIVER_LAYERS, NeuralDriver, Team } from '../src/ai/drivers';
import { OBS_SIZE, observePit, PIT_SIZE } from '../src/ai/observe';
import { pitRoute } from '../src/ai/pitting';
import { RADIO_SIZE, TowerSpotter } from '../src/ai/spotter';
import { genomeSize, Network } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { World } from '../src/sim/world';
import { presetTrack } from '../src/trackgen';
import { PitTrial } from '../src/school/pitLesson';

describe('drivers doing their own pit stops', () => {
  it('widening to the pit inputs keeps a driver racing exactly as before', () => {
    const rng = new Rng(4);
    const old = Float32Array.from({ length: genomeSize(RADIO_DRIVER_LAYERS) }, () => rng.gaussian() * 0.3);
    const wide = adaptWeights(old);
    expect(wide.length).toBe(genomeSize(DRIVER_LAYERS));
    const x = Float32Array.from({ length: OBS_SIZE + RADIO_SIZE }, () => rng.gaussian());
    const before = new Network(RADIO_DRIVER_LAYERS, old).forward(x);
    const xWide = new Float32Array(DRIVER_LAYERS[0]);
    xWide.set(x);
    const after = new Network(DRIVER_LAYERS, wide).forward(xWide);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it('sees nothing of the pit stop unless one is under way, and the route ends back on the racing surface', () => {
    const track = presetTrack('speedway');
    const car = new Car(0);
    car.placeOnTrack(track, track.pit.entryStart - 200, 0);
    const out = new Float32Array(PIT_SIZE);
    observePit(car, track, null, false, 22, out);
    expect(out.every((v) => v === 0)).toBe(true);
    car.pit.phase = 'in';
    car.pit.boxS = track.pit.stalls[0];
    observePit(car, track, pitRoute(track, car.pit, 0), false, 22, out);
    expect(out[0]).toBe(1); // in-lap
    // The route starts near where the car is (200 m out it has begun easing toward the pit entry, which stands a car's
    // width and a metre clear of the racing surface).
    expect(out[2]).toBeLessThan(0.6);
    car.pit.phase = 'out';
    const route = pitRoute(track, car.pit, 0);
    expect(route(track.pit.blendEnd + 50)).toBeLessThan(track.innerEdgeAt(track.pit.blendEnd + 50)); // merged
  });

  it('scores a pit trial so that getting further through the stop always pays', () => {
    const track = presetTrack('flat');
    const trial = new PitTrial(track, [adaptWeights(new Float32Array(genomeSize(RADIO_DRIVER_LAYERS)))], 30);
    while (!trial.done) trial.step();
    const r = trial.results()[0];
    expect(r.serviced).toBe(false); // a driver that does nothing doesn't stop...
    expect(r.fitness).toBeLessThan(-1); // ...and pays for the skipped stop
  });

  it('a team with a pit-trained driver hands it the whole stop', () => {
    const track = presetTrack('short');
    const world = new World(track, { collisions: false });
    const car = new Car(0);
    const team = new Team(new NeuralDriver(adaptWeights(new Float32Array(genomeSize(RADIO_DRIVER_LAYERS)))), new TowerSpotter(), null, true);
    world.addCar(car, team);
    car.placeOnTrack(track, track.pit.entryStart - 100, 0);
    car.pit.phase = 'in';
    team.decide(car, world);
    expect(team.mode).toBe('pit');
    expect(team.pitInputs[0]).toBe(1);
  });
});
