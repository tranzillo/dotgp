import { describe, expect, it } from 'vitest';
import { adaptWeights, CAUTION_DRIVER_LAYERS, DRIVER_LAYERS, mirrorDriverInputs, PREVIEW_FROM } from '../src/ai/drivers';
import { genomeSize, Network } from '../src/ai/network';
import { LOOKAHEAD, observePreview, PREVIEW, PREVIEW_SIZE } from '../src/ai/observe';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import type { TrackLayout } from '../src/sim/layout';
import { presetLayout } from '../src/trackgen';

describe('the preview of the road', () => {
  it('leaves drivers from before it driving exactly as they did, whatever it shows', () => {
    const rng = new Rng(3);
    const old = Float32Array.from({ length: genomeSize(CAUTION_DRIVER_LAYERS) }, () => rng.gaussian() * 0.4);
    const before = new Network(CAUTION_DRIVER_LAYERS, old), after = new Network(DRIVER_LAYERS, adaptWeights(old));
    for (let n = 0; n < 100; n++) {
      const x = Float32Array.from({ length: DRIVER_LAYERS[0] }, () => rng.gaussian());
      expect(Array.from(after.forward(x))).toEqual(Array.from(before.forward(x.slice(0, PREVIEW_FROM))));
    }
  });

  it('sees a short corner between the lookahead points, and turns with the mirrored view', () => {
    // A speedway with a 12 m kink of curvature laid 40-52 m ahead of the car: between the 30 and 60 m lookahead points.
    const layout: TrackLayout = presetLayout('speedway');
    const sections = layout.centerline.sections;
    const [len] = sections[0];
    sections.splice(0, 1, [100, 0, 0], [12, 0.05, 0.05], [len - 112 - 12, 0, 0], [12, -0.05, -0.05]);
    const track = new Track(layout);
    const car = new Car(0);
    car.placeOnTrack(track, 58, 0); // the kink at 100-112 m: 42-54 m ahead
    expect(LOOKAHEAD.filter((a) => a <= 100).some((a) => Math.abs(track.curvatureAt(car.s + a)) > 0.01)).toBe(false);
    const out = observePreview(car, track, new Float32Array(PREVIEW_SIZE));
    const w = PREVIEW.findIndex(([lo, hi]) => lo <= 45 && hi >= 45);
    expect(out[w]).toBeCloseTo(0.05 * 200, 3);
    // Mirrored, every corner is the other way round.
    const x = new Float32Array(DRIVER_LAYERS[0]);
    x.set(out, PREVIEW_FROM);
    mirrorDriverInputs(x);
    expect(x[PREVIEW_FROM + w]).toBeCloseTo(-0.05 * 200, 3);
  });
});
