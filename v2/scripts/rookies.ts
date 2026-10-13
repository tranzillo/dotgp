/**
 * Rookie school check: a field of brand-new drivers practising the way the
 * viewer does (4 per round, traffic once licensed). Reports licenses earned.
 *
 *   npx tsx scripts/rookies.ts --field 8 --rounds 300
 */
import { EsTrainer } from '../src/ai/es';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track } from '../src/sim/track';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const field = Number(args.get('field') ?? 8);
const rounds = Number(args.get('rounds') ?? 300);
const tracks = [new Track(SPEEDWAY), new Track(SHORT_TRACK), new Track(FLAT_TRACK)];
const es = new EsTrainer(tracks, { lineages: field, seed: Number(args.get('seed') ?? 7), traffic: true, pairs: 8, trialSeconds: 60, learningRate: 0.01 });
const t0 = Date.now();
for (let r = 0; r < rounds; r++) {
  const rep = es.step();
  for (const l of rep.lineages) if (l.graduated) console.log(`round ${r}: driver ${l.lineage} licensed after ${es.drivers[l.lineage].rounds} lessons`);
  if ((r + 1) % 25 === 0) {
    const lic = es.drivers.filter((d) => d.licensed).length;
    const sample = rep.lineages.map((l) => `D${l.lineage}${l.rookie ? 'r' : ''} laps ${l.results.map((x) => x.laps).join('/')} hp ${l.results.map((x) => x.health.toFixed(1)).join('/')}`).join('  ');
    console.log(`round ${r + 1} (${((Date.now() - t0) / 60000).toFixed(1)} min) licensed ${lic}/${field} walls x${rep.damageScale.toFixed(2)} | ${sample}`);
  }
}
