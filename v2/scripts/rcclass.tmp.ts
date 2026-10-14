import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { Classroom } from '../src/school/classroom';
import { PRESETS, presetLayout } from '../src/trackgen';
const file = JSON.parse(readFileSync('public/drivers/default.json', 'utf8'));
const t0 = Date.now();
const c = new Classroom({
  lesson: 'racecraft', presets: Object.keys(PRESETS).map(presetLayout), seed: 5,
  students: file.drivers.map((d: { weights: number[] }, k: number) => ({ key: k, id: 'D' + k, name: 'Driver ' + k, weights: adaptWeights(Float32Array.from(d.weights)), rounds: 0, licensed: true })),
});
const ROUNDS = Number(process.argv[2] ?? 120);
let harm = 0, hurt = 0, laps = 0, n = 0;
while (c.round < ROUNDS) {
  c.step();
  for (const r of c.takeReports()) { harm += r.pack!.harm; hurt += r.health < 0.95 ? 1 : 0; laps += r.laps; n++; }
  if (c.round % 10 === 0 && n) {
    console.log('rounds ' + (c.round - 9) + '-' + c.round + ': harm ' + (harm / n).toFixed(3) + ', hurt ' + (100 * hurt / n).toFixed(0) + '%, laps ' + (laps / n).toFixed(3) + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
    harm = hurt = laps = n = 0;
  }
  if (c.round % 40 === 0) {
    const out = { ...file, drivers: file.drivers.map((d: object, k: number) => ({ ...d, weights: Array.from(c.students[k].weights) })) };
    writeFileSync('C:/Users/kappa/AppData/Local/Temp/claude/c--Users-kappa-OneDrive-Documents-projects-dotgp/ca0ee53f-fe24-46a3-91f1-22a5353e8065/scratchpad/rcC-' + c.round + '.json', JSON.stringify(out));
  }
}
