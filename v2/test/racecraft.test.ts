import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { Classroom } from '../src/school/classroom';
import { PACK_SIZE, RacecraftDrill } from '../src/school/racecraftLesson';
import { PRESETS, presetLayout, presetTrack } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
const w = (k: number) => adaptWeights(Float32Array.from(bundled[k % bundled.length].weights));

describe('racecraft', () => {
  it('runs a restart in a pack and charges the student only for damage it caused', () => {
    const d = new RacecraftDrill(presetTrack('short'), 3, w(3), w);
    expect(d.world.cars).toHaveLength(PACK_SIZE);
    while (!d.done) d.step();
    const r = d.result();
    expect(r.laps).toBeGreaterThan(0.5);
    expect(r.harm).toBe(d.student.harmDone);
    const lost = d.world.cars.filter((c) => c !== d.student).reduce((a, c) => a + (1 - c.health), 0);
    expect(r.harm).toBeLessThanOrEqual(lost + 1e-9);
  });

  it('a class runs round by round with the class as the pack, and keeps going', () => {
    const c = new Classroom({
      lesson: 'racecraft', presets: Object.keys(PRESETS).map(presetLayout), seed: 2,
      students: [0, 1].map((k) => ({ key: k, id: `D${k}`, name: `D${k}`, weights: w(k), rounds: 0, licensed: true })),
    });
    c.step();
    while (c.round < 1) c.step();
    const reports = c.takeReports();
    expect(reports).toHaveLength(2);
    expect(reports[0].pack).toBeDefined();
    expect(c.finished).toBe(false);
  });
});
