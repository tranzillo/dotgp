/**
 * Headless neuroevolution run. The spike's question: can raw-control drivers
 * evolve from random weights into clean lappers, and do separate lineages
 * find different techniques?
 *
 *   npm run evolve -- --gens 60 --tracks speedway,short,flat --islands 4 --pop 32 --seed 1
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { techniqueSummary } from '../src/ai/evaluate';
import { Evolution } from '../src/ai/evolution';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track } from '../src/sim/track';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);

const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK };
const trackNames = (args.get('tracks') ?? 'speedway,short,flat').split(',') as Array<keyof typeof specs>;
const tracks = trackNames.map((name) => new Track(specs[name]));
const gens = num('gens', 60);
const printEvery = num('every', 10);
const evo = new Evolution(tracks, {
  seed: num('seed', 1),
  islands: num('islands', 4),
  populationPerIsland: num('pop', 32),
  trialSeconds: num('seconds', 80),
  curriculumGenerations: num('curriculum', 60),
});

const pct = (x: number) => `${Math.round(x * 100)}`.padStart(3);
console.log(`tracks=${trackNames.join(',')}  islands=${evo.config.islands} x ${evo.config.populationPerIsland}  trial=${evo.config.trialSeconds}s`);
console.log('per track: laps / best lap / wall hits / health / technique drive-corner-brake %');

let last;
for (let g = 0; g < gens; g++) {
  last = evo.step();
  if (g % printEvery !== printEvery - 1 && g !== 0) continue;
  console.log(`gen ${g} (${(last.elapsedMs / 1000).toFixed(1)}s) damage x${last.damageScale.toFixed(2)}`);
  for (const { lineage, best } of last.islands) {
    const cols = best.results.map((r, t) => {
      const tech = techniqueSummary(r.signature);
      const lap = Number.isFinite(r.bestLap) ? r.bestLap.toFixed(2) : '  -  ';
      return `${trackNames[t]} ${r.laps} ${lap} h${r.wallHits} ${r.health.toFixed(2)} ${pct(tech.drive)}/${pct(tech.corner)}/${pct(tech.brake)}`;
    });
    console.log(`  L${lineage} fit ${best.fitness.toFixed(2).padStart(5)} | ${cols.join(' | ')}`);
  }
}

if (last) {
  mkdirSync('runs', { recursive: true });
  const out = `runs/${trackNames.join('+')}-seed${evo.config.seed}-gen${evo.generation}.json`;
  writeFileSync(out, JSON.stringify({
    tracks: trackNames,
    track: trackNames[0],
    generation: evo.generation,
    champions: last.islands.map(({ lineage, best }) => ({
      lineage,
      id: best.genome.id,
      fitness: best.fitness,
      results: best.results,
      weights: Array.from(best.genome.weights),
    })),
  }));
  console.log(`saved champions -> ${out}`);
}
