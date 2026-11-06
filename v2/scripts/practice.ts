/**
 * ES practice run: each lineage is one persistent driver improving round by round.
 *
 *   npx tsx scripts/practice.ts --rounds 150 --tracks speedway,short,flat --lineages 4
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { techniqueSummary } from '../src/ai/evaluate';
import { EsTrainer } from '../src/ai/es';
import { FLAT_TRACK, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);

const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK };
const trackNames = (args.get('tracks') ?? 'speedway,short,flat').split(',') as Array<keyof typeof specs>;
const tracks = trackNames.map((name) => ovalTrack(specs[name]));
const rounds = num('rounds', 150);
const every = num('every', 10);
const es = new EsTrainer(tracks, {
  seed: num('seed', 1),
  lineages: num('lineages', 4),
  pairs: num('pairs', 16),
  sigma: num('sigma', 0.05),
  learningRate: num('lr', 0.03),
  trialSeconds: num('seconds', 80),
  curriculumRounds: num('curriculum', 40),
  traffic: num('traffic', 0) === 1,
});
if (args.has('from')) {
  const saved = JSON.parse(readFileSync(args.get('from')!, 'utf8'));
  const list: Array<{ weights: number[]; rounds?: number }> = saved.drivers ?? saved.champions;
  es.loadDrivers(list.map((d) => ({ weights: Float32Array.from(d.weights), rounds: d.rounds ?? saved.round ?? 0 })));
  console.log(`resumed ${list.length} drivers from ${args.get('from')} at round ${es.round}`);
}

const pct = (x: number) => `${Math.round(x * 100)}`.padStart(3);
console.log(`ES ${es.config.traffic ? 'TRAFFIC' : 'solo'}  tracks=${trackNames.join(',')}  lineages=${es.config.lineages}  pairs=${es.config.pairs}  sigma=${es.config.sigma}  lr=${es.config.learningRate}`);

let last;
for (let r = 0; r < rounds; r++) {
  last = es.step();
  if (r % every !== every - 1 && r !== 0) continue;
  console.log(`round ${r} (${(last.elapsedMs / 1000).toFixed(1)}s) damage x${last.damageScale.toFixed(2)}`);
  for (const l of last.lineages) {
    const cols = l.results.map((res, t) => {
      const tech = techniqueSummary(res.signature);
      const lap = Number.isFinite(res.bestLap) ? res.bestLap.toFixed(2) : '  -  ';
      return `${trackNames[t]} ${res.laps} ${lap} h${res.wallHits} ${res.health.toFixed(2)} ${pct(tech.drive)}/${pct(tech.corner)}/${pct(tech.brake)}`;
    });
    console.log(`  L${l.lineage} fit ${l.fitness.toFixed(2).padStart(5)} | ${cols.join(' | ')}`);
  }
}

if (last) {
  mkdirSync('runs', { recursive: true });
  const out = `runs/es-${es.config.traffic ? 'traffic-' : ''}${trackNames.join('+')}-seed${es.config.seed}-r${es.round}.json`;
  writeFileSync(out, JSON.stringify({
    tracks: trackNames,
    track: trackNames[0],
    round: es.round,
    drivers: es.drivers.map((d) => ({
      lineage: d.lineage,
      rounds: d.rounds,
      fitness: last!.lineages.find((l) => l.lineage === d.lineage)?.fitness ?? null,
      weights: Array.from(d.weights),
    })),
  }));
  console.log(`saved drivers -> ${out}`);
}
