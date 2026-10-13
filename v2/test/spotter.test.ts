import { describe, expect, it } from 'vitest';
import { adaptWeights, DRIVER_LAYERS, LEGACY_DRIVER_LAYERS } from '../src/ai/drivers';
import { genomeSize, Network } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { RADIO, RADIO_SIZE, TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { ovalTrack, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';

describe('network widening', () => {
  it('upgrades a solo-era driver without changing what it does', () => {
    const rng = new Rng(7);
    const legacy = Float32Array.from({ length: genomeSize(LEGACY_DRIVER_LAYERS) }, () => rng.gaussian() * 0.4);
    const widened = adaptWeights(legacy);
    expect(widened.length).toBe(genomeSize(DRIVER_LAYERS));
    const oldNet = new Network(LEGACY_DRIVER_LAYERS, legacy);
    const newNet = new Network(DRIVER_LAYERS, widened);
    for (let trial = 0; trial < 20; trial++) {
      const obs = Float32Array.from({ length: LEGACY_DRIVER_LAYERS[0] }, () => rng.gaussian());
      const radio = Float32Array.from({ length: RADIO_SIZE }, () => rng.gaussian()); // ignored until trained
      const input = new Float32Array(DRIVER_LAYERS[0]);
      input.set(obs, 0);
      input.set(radio, obs.length);
      const a = Array.from(oldNet.forward(obs));
      const b = Array.from(newNet.forward(input));
      expect(b[0]).toBeCloseTo(a[0], 6);
      expect(b[1]).toBeCloseTo(a[1], 6);
    }
  });
});

describe('tower spotter', () => {
  const track = ovalTrack(SPEEDWAY);
  const setup = (others: Array<[number, number, number]>) => {
    const world = new World(track);
    const me = new Car(0);
    me.placeOnTrack(track, 200, 0);
    const i = me.trackIdx;
    me.vx = track.tx[i] * 60; me.vy = track.ty[i] * 60;
    world.addCar(me, null);
    others.forEach(([s, d, speed], k) => {
      const c = new Car(k + 1);
      c.placeOnTrack(track, s, d);
      const j = c.trackIdx;
      c.vx = track.tx[j] * speed; c.vy = track.ty[j] * speed;
      world.addCar(c, null);
    });
    const radio = new Float32Array(RADIO_SIZE);
    new TowerSpotter().call(me, world, radio);
    return radio;
  };

  it('calls car low / car high for cars alongside', () => {
    const low = setup([[201, 3.2, 60]]);
    expect(low[RADIO.LOW_PROX]).toBeGreaterThan(0.8);
    expect(low[RADIO.HIGH_PROX]).toBe(0);
    expect(low[RADIO.LOW_REL]).toBeGreaterThan(0);
    const high = setup([[198, -4, 60]]);
    expect(high[RADIO.HIGH_PROX]).toBeGreaterThan(0.3);
    expect(high[RADIO.HIGH_REL]).toBeLessThan(0);
  });

  it('reports the car ahead in our lane and how fast we are closing', () => {
    const r = setup([[230, 0.5, 50]]);
    expect(r[RADIO.AHEAD_PROX]).toBeCloseTo(1 - 30 / 120, 1);
    expect(r[RADIO.AHEAD_CLOSING]).toBeCloseTo(10 / 20, 1);
  });

  it('sees a wreck on the far side of the track', () => {
    const r = setup([[800, -6, 0]]);
    expect(r[RADIO.HAZARD_PROX]).toBeCloseTo(1 - 600 / 800, 1);
    expect(r[RADIO.HAZARD_LANE]).toBeLessThan(-0.5); // up high
    expect(r[RADIO.AHEAD_PROX]).toBe(0); // too far to be "the car ahead"
  });

  it('wraps around the start/finish line', () => {
    const me = setup([[10, 0, 60]]); // we are at 200; a car at 10 is ~190 m behind... check ahead wrap instead
    expect(me[RADIO.BEHIND_PROX]).toBe(0); // 190 m behind is out of range
    const world = new World(track);
    const a = new Car(0); a.placeOnTrack(track, track.length - 10, 0);
    const b = new Car(1); b.placeOnTrack(track, 20, 0);
    world.addCar(a, null); world.addCar(b, null);
    const radio = new Float32Array(RADIO_SIZE);
    new TowerSpotter().call(a, world, radio);
    expect(radio[RADIO.AHEAD_PROX]).toBeCloseTo(1 - 30 / 120, 1);
  });
});
