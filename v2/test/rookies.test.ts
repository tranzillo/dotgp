import { describe, expect, it } from 'vitest';
import { EsTrainer } from '../src/ai/es';
import { ovalTrack, SHORT_TRACK } from '../src/trackgen';

describe('rookie school', () => {
  it('gives rookies the practice slots, solo on soft walls, until they are licensed', () => {
    const es = new EsTrainer([ovalTrack(SHORT_TRACK)], {
      lineages: 3, traffic: true, pairs: 1, rookiePairs: 1, trialSeconds: 4, rookieSeconds: 4, seed: 3,
    });
    es.drivers[0].licensed = true; // one experienced driver, two rookies
    const first = es.step();
    expect(first.lineages.map((l) => l.lineage).sort()).toEqual([1, 2]); // rookies only
    expect(first.lineages.every((l) => l.rookie)).toBe(true);
    expect(first.damageScale).toBeLessThan(0.1); // soft walls on lesson one
    expect(first.lineages.some((l) => l.graduated)).toBe(false); // can't pass the test on soft walls

    for (const d of es.drivers) d.licensed = true;
    const later = es.step();
    expect(later.lineages).toHaveLength(3);
    expect(later.lineages.every((l) => !l.rookie)).toBe(true);
    expect(later.damageScale).toBe(1);
  });

  it('starts new drivers with an instinct to accelerate and no attention to the radio', async () => {
    const { initialWeights } = await import('../src/ai/es');
    const { Rng } = await import('../src/ai/rng');
    const { OBS_SIZE } = await import('../src/ai/observe');
    const { DRIVER_LAYERS } = await import('../src/ai/drivers');
    const w = initialWeights(new Rng(1));
    const nIn = DRIVER_LAYERS[0];
    // First hidden neuron: bias, then inputs; radio inputs come after the observations.
    for (let k = OBS_SIZE; k < nIn; k++) expect(w[1 + k]).toBe(0);
  });
});
