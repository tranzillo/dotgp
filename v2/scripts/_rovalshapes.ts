import { writeFileSync } from 'node:fs';
import { generateLayout } from '../src/trackgen';
import { Track } from '../src/sim/track';
import { integrate, ovalPose } from '../src/trackgen/course';
import { generateRoval, ovalTurns } from '../src/trackgen/roval';
import { Rng } from '../src/ai/rng';
const cells: unknown[] = [];
const runs: Array<[string, number]> = [];
for (const v of ['intermediate', 'speedway', 'superspeedway']) for (let seed = 1; seed <= 4; seed++) runs.push([v, seed]);
for (const [variant, seed] of runs) {
  const lay = generateLayout({ type: 'oval', seed, variant });
  const track = new Track({ ...lay, neighbours: undefined });
  const pit = lay.pit, lot = lay.infield.garage.lot;
  const keepOut = (x: number, y: number) => {
    const q = track.project(x, y);
    return track.inRange(q.s, [lot.s0 - 20, lot.s1 + 20]) && q.d < lot.d1 + 20;
  };
  const t0 = performance.now();
  const shape = generateRoval({ cl: track, pavedInner: (s) => track.pavedInnerD(s), turns: ovalTurns(track), keepOut, pitRange: [pit.entryStart, pit.exitEnd], rng: new Rng(seed * 7 + 1) }, { id: 'r', name: 'GP' });
  const ms = performance.now() - t0;
  const ring = (d: (s: number) => number) => { const o: number[][] = []; for (let s = 0; s < track.length; s += 8) o.push(track.toWorld(s, d(s))); return o; };
  let chain: number[][] = [], portion: number[][] = [];
  let len = 0;
  if (shape) {
    const o = ovalPose(track, shape.leave);
    chain = integrate(shape.sections, o.x, o.y, o.h, 4).points;
    const part = track.distanceFrom(shape.join, shape.leave);
    for (let s = 0; s <= part; s += 8) portion.push(track.toWorld(shape.join + s, 0));
    len = part + shape.sections.reduce((a, x) => a + x[0], 0);
  }
  cells.push({
    label: `${variant} ${seed} oval ${Math.round(track.length)}m ` + (shape ? `${shape.character} w${shape.width} lap ${Math.round(len)}m (${(len / track.length).toFixed(2)}) ${ms.toFixed(0)}ms` : `NONE ${ms.toFixed(0)}ms`),
    outer: ring((s) => track.outerEdgeAt(s)), inner: ring((s) => track.pavedInnerD(s)),
    lot: [[lot.s0, lot.d0], [lot.s1, lot.d0], [lot.s1, lot.d1], [lot.s0, lot.d1]].map(([s, d]) => track.toWorld(s, d)),
    chain, portion, width: shape?.width ?? 0, polygon: [], centre: null,
  });
}
writeFileSync(process.argv[2], JSON.stringify(cells));
