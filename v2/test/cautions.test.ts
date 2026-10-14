import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights, DRIVER_LAYERS, NeuralDriver, PIT_DRIVER_LAYERS, Team } from '../src/ai/drivers';
import { CAUTION_SIZE, observeCaution } from '../src/ai/observe';
import { TowerSpotter } from '../src/ai/spotter';
import { genomeSize, Network } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { CautionDrill, packCar, scriptBaseline } from '../src/school/cautionLesson';
import { presetTrack } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
const veteran = () => adaptWeights(Float32Array.from(bundled[0].weights));

describe('drivers doing their own cautions', () => {
  it('widening to the caution inputs keeps a driver racing exactly as before', () => {
    const rng = new Rng(5);
    const old = Float32Array.from({ length: genomeSize(PIT_DRIVER_LAYERS) }, () => rng.gaussian() * 0.3);
    const wide = adaptWeights(old);
    expect(wide.length).toBe(genomeSize(DRIVER_LAYERS));
    const x = Float32Array.from({ length: PIT_DRIVER_LAYERS[0] }, () => rng.gaussian());
    const before = new Network(PIT_DRIVER_LAYERS, old).forward(x);
    const xWide = new Float32Array(DRIVER_LAYERS[0]);
    xWide.set(x);
    const after = new Network(DRIVER_LAYERS, wide).forward(xWide);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it('runs a drill: green, a debris caution, the restart; the formation script holds its place and file', () => {
    const r = scriptBaseline(presetTrack('short'), 3, veteran());
    expect(r.laps).toBeGreaterThan(0.3);
    expect(r.passes).toBe(0); // the line keeps its order: side by side in a row isn't a pass
    expect(r.laneError).toBeLessThan(0.5); // ... and nobody's file swaps under them
    expect(r.placeError).toBeLessThan(15);
  });

  it('sees the caution only while pacing, and the student drives it when licensed', () => {
    const track = presetTrack('short');
    const slot = 2;
    let team: Team | null = null;
    const drill = new CautionDrill(track, slot, (k) => (k === slot
      ? (team = new Team(new NeuralDriver(veteran()), new TowerSpotter(), null, false, true))
      : packCar(k)));
    const out = new Float32Array(CAUTION_SIZE);
    let sawGreen = false, sawPacing = false;
    while (!drill.done) {
      drill.step();
      observeCaution(drill.student, drill.world, out);
      if (drill.control.pacing) {
        sawPacing = true;
        expect(out[0]).toBe(1);
        expect(team!.mode).not.toBe('formation'); // never handed to the script
      } else {
        sawGreen = true;
        expect(out.every((v) => v === 0)).toBe(true);
      }
    }
    expect(sawGreen && sawPacing).toBe(true);
    expect(drill.control.cautions).toBe(1);
  });
});
