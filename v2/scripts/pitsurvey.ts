// Pit survey: every kind of track (generated ovals of every size, generated club and GP circuits, the real tracks),
// its pit lane against feedback/pit-layout.md's checks (the nose clear of the track, a long enough entry on circuits,
// boxes for a field, the blend soon after the exit), and a scripted car called in once on each (the full pit cycle, as
// the pit tests run it): clean stops.   npx tsx scripts/pitsurvey.ts [seeds per kind] [--real [--placed]] [--quiet]
// (The real tracks' pit lanes where OpenStreetMap has them, public/tracks/pits.json, and ours fits them; --placed: our
// own choice everywhere, as before they were.)
import { readFileSync } from 'node:fs';
import { ScriptedDriver, Team } from '../src/ai/drivers';
import type { CrewChief } from '../src/ai/pitting';
import { TowerSpotter } from '../src/ai/spotter';
import { Car, type PitCall } from '../src/sim/car';
import { PIT_SERVICE } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import type { TrackLayout } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout } from '../src/trackgen';
import { type MappedPits, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';
import { noseClearance } from '../src/trackgen/stages';

class CallOnce implements CrewChief {
  lastMessage = 'Box this lap'; private called = false;
  decide(): PitCall | null { if (this.called) return null; this.called = true; return { tires: true, fuel: 30, repair: false }; }
}

const args = process.argv.slice(2);
const seeds = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
const quiet = args.includes('--quiet');

/** The checks a pit lane should pass (feedback/pit-layout.md), each null if it does or why not. */
function checks(t: Track): string[] {
  const p = t.pit, out: string[] = [];
  const nose = p.wallD - p.wallThickness / 2 + t.pitOffset(p.wallStart) - t.innerEdgeAt(p.wallStart);
  if (nose < noseClearance() - 0.05) out.push(`nose ${nose.toFixed(1)} m`);
  const entry = p.wallStart - p.entryStart;
  if (t.kind === 'road' && entry < 199) out.push(`entry ${entry.toFixed(0)} m`);
  const blend = t.distanceFrom(p.wallEnd, p.blendEnd);
  if (blend > 500) out.push(`blend ${blend.toFixed(0)} m past the wall`);
  if (p.stalls.length < 12) out.push(`${p.stalls.length} boxes`);
  return out;
}

/** A scripted car called in once: a clean stop (serviced, unhurt, back on track, under the limit on pit road)? */
function stop(t: Track): string | null {
  const world = new World(t, { collisions: false });
  const car = new Car(0);
  placeOnGrid(car, t, 0, true);
  car.fuel = 20; car.tireLife = 0.5;
  world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), new CallOnce()));
  let maxPitSpeed = 0, rejoined = false;
  while (world.time < 600) {
    world.step();
    if (car.surface === 'pit' && car.pit.phase === 'in' && t.signedS(car.s) > t.pit.wallStart + 30) maxPitSpeed = Math.max(maxPitSpeed, car.speed);
    if (car.pit.stops === 1 && car.pit.phase === 'none') { for (let k = 0; k < 360; k++) world.step(); rejoined = car.d < t.innerEdge(car.trackIdx); break; }
  }
  const good = car.pit.stops === 1 && car.health > 0.99 && rejoined && maxPitSpeed < PIT_SERVICE.SPEED_LIMIT + 1;
  return good ? null : `stop failed: stops=${car.pit.stops} health=${car.health.toFixed(2)} rejoined=${rejoined} vmax=${maxPitSpeed.toFixed(1)}`;
}

const kinds: Array<{ name: string; layouts: () => Array<{ id: string; layout: () => TrackLayout }> }> = [
  ...['short', 'intermediate', 'speedway', 'superspeedway'].map((variant) => ({
    name: `oval ${variant}`, layouts: () => Array.from({ length: seeds }, (_, i) => ({ id: String(i + 1), layout: () => generateLayout({ type: 'oval', seed: i + 1, variant }) })),
  })),
  ...['club', 'gp'].map((variant) => ({
    name: `circuit ${variant}`, layouts: () => Array.from({ length: seeds }, (_, i) => ({ id: String(i + 1), layout: () => generateLayout({ type: 'circuit', seed: i + 1, variant }) })),
  })),
  ...(args.includes('--real') ? [{
    name: 'real', layouts: () => {
      const pits = (args.includes('--placed') ? {} : JSON.parse(readFileSync('public/tracks/pits.json', 'utf8'))) as MappedPits;
      return REAL_TRACKS.map((r) => ({ id: r.id, layout: () => realLayout(r, readFileSync(`public/tracks/${r.file}`, 'utf8'), pits[r.id]?.points) }));
    },
  }] : []),
];
for (const kind of kinds) {
  let laid = 0, passed = 0, clean = 0, total = 0;
  const boxes: number[] = [];
  for (const { id, layout } of kind.layouts()) {
    total++;
    let t: Track;
    try { t = new Track(layout()); } catch (e) { if (!quiet) console.log(`  ${kind.name} ${id}: not laid out: ${(e as Error).message.slice(0, 100)}`); continue; }
    laid++;
    boxes.push(t.pit.stalls.length);
    const failed = checks(t), stopped = stop(t);
    if (!failed.length) passed++;
    if (!stopped) clean++;
    if (!quiet && (failed.length || stopped)) console.log(`  ${kind.name} ${id}: ${[...failed, ...(stopped ? [stopped] : [])].join('; ')}`);
  }
  boxes.sort((a, b) => a - b);
  console.log(`${kind.name.padEnd(20)} laid out ${laid}/${total}, checks passed ${passed}/${laid}, clean stops ${clean}/${laid}, boxes ${boxes[0]}/${boxes[Math.floor(boxes.length / 2)]}/${boxes[boxes.length - 1]}`);
}
