import { writeFileSync } from 'node:fs';
import { generateLayout } from '../src/trackgen';
import { Track } from '../src/sim/track';
import { compileRoval } from '../src/trackgen/roval';
// Road-course networks for quick plots: npx tsx scripts/_rovalshapes.ts out.json [first seed] [count]
const first = Number(process.argv[3] ?? 1), count = Number(process.argv[4] ?? 4);
const rows: unknown[] = [];
const ring = (t: Track, d: (s: number) => number, step = 6) => { const o: number[][] = []; for (let s = 0; s < t.length; s += step) o.push(t.toWorld(s, d(s))); return o; };
for (const variant of ['intermediate', 'speedway', 'superspeedway']) for (let seed = first; seed < first + count; seed++) {
  const t0 = performance.now();
  const lay = generateLayout({ type: 'oval', seed, variant });
  const ms = performance.now() - t0;
  const track = new Track({ ...lay, neighbours: undefined });
  const innerLayout = lay.neighbours?.find((n) => n.id.endsWith('/inner'));
  const inner = innerLayout ? new Track({ ...innerLayout, neighbours: undefined }) : null;
  const layouts = (lay.infield.rovals ?? []).map((spec) => {
    try {
      const r = compileRoval(lay, spec);
      const t = new Track({ ...r, neighbours: undefined });
      return { name: spec.name, length: Math.round(t.length), lap: ring(t, () => 0, 4), err: t.closureError };
    } catch (e) { return { name: spec.name, length: 0, lap: [], err: String(e) }; }
  });
  rows.push({
    label: `${variant} ${seed} ${Math.round(track.length)}m ${ms.toFixed(0)}ms`,
    outer: ring(track, (s) => track.outerEdgeAt(s)), inner: ring(track, (s) => track.pavedInnerD(s)), centre: ring(track, () => 0),
    innerOval: inner ? ring(inner, () => 0, 3) : [], width: lay.infield.rovals?.[0]?.width ?? 12, layouts,
  });
}
writeFileSync(process.argv[2], JSON.stringify(rows));
