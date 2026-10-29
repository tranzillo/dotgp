/**
 * An oval's centreline from OpenStreetMap, as a survey CSV for
 * trackgen/realtrack.ts (public/tracks/osm/): the raceway ways around a
 * point fetched from the Overpass API, the oval's loop assembled from them
 * (starting on a seed way, taking the connecting way that carries on
 * straightest each time, so road courses and pit lanes branching off are
 * passed by), its start line where it passes the pit lane's middle, and the
 * published width either side.
 *
 *   npx tsx scripts/osmtrack.ts <out.csv> <lat> <lon> <seed way name or id> <width m> [radius m]
 *
 * The data is © OpenStreetMap contributors (ODbL): the CSV says which ways.
 */
import { writeFileSync } from 'node:fs';

type Pt = [number, number];
interface Way { id: number; tags: Record<string, string>; geometry: Array<{ lat: number; lon: number }>; xy: Pt[] }

const [out, latText, lonText, seedName, widthText, radiusText] = process.argv.slice(2);
if (!out || !seedName || !widthText) throw new Error('usage: osmtrack.ts <out.csv> <lat> <lon> <seed way> <width m> [radius m]');
const query = `[out:json][timeout:60];way["highway"="raceway"](around:${Number(radiusText ?? 2500)},${latText},${lonText});out tags geom;`;
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'dotgp-track-import/0.1' },
});
if (!res.ok) throw new Error(`Overpass: ${res.status}`);
const ways = ((await res.json()) as { elements: Way[] }).elements.filter((w) => (w.geometry?.length ?? 0) >= 2);
// A local frame in metres round the ways' middle.
const all = ways.flatMap((w) => w.geometry);
const lat0 = all.reduce((a, p) => a + p.lat, 0) / all.length, lon0 = all.reduce((a, p) => a + p.lon, 0) / all.length;
for (const w of ways) w.xy = w.geometry.map((p) => [(p.lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), (p.lat - lat0) * 110574]);
const key = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
const heading = (a: Pt, b: Pt) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const seed = ways.find((w) => w.tags?.name === seedName || String(w.id) === seedName);
if (!seed) throw new Error(`no raceway "${seedName}" there: ${ways.map((w) => w.tags?.name ?? w.id).join(', ')}`);
const loop: Pt[] = [...seed.xy];
const used = [seed.id];
for (let guard = 0; guard < 80 && !(loop.length > 10 && key(loop[loop.length - 1]) === key(loop[0])); guard++) {
  const h = heading(loop[loop.length - 2], loop[loop.length - 1]);
  let best: { turn: number; w: Way; pts: Pt[] } | null = null;
  for (const w of ways) {
    if (used.includes(w.id) && w.id !== seed.id) continue;
    for (const pts of w.tags?.oneway === 'yes' ? [w.xy] : [w.xy, [...w.xy].reverse()]) {
      if (key(pts[0]) !== key(loop[loop.length - 1])) continue;
      const d = heading(pts[0], pts[1]) - h, turn = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      if (!best || turn < best.turn) best = { turn, w, pts };
    }
  }
  if (!best) throw new Error(`the loop comes to a dead end after ${used.length} ways`);
  loop.push(...best.pts.slice(1));
  if (best.w.id !== seed.id) used.push(best.w.id);
}
if (key(loop[loop.length - 1]) !== key(loop[0])) throw new Error("the loop doesn't close");
loop.pop();
const length = loop.reduce((a, p, i) => a + Math.hypot(p[0] - loop[(i + 1) % loop.length][0], p[1] - loop[(i + 1) % loop.length][1]), 0);
// The start line where the loop passes nearest the (oval's) pit lane's middle.
const pits = ways.filter((w) => /pit/i.test(w.tags?.name ?? '') && !/road course/i.test(w.tags?.name ?? ''));
let first = 0;
if (pits.length) {
  const lane = pits.reduce((a, b) => (b.xy.length > a.xy.length ? b : a)).xy, [px, py] = lane[Math.floor(lane.length / 2)];
  loop.forEach(([x, y], i) => { if ((x - px) ** 2 + (y - py) ** 2 < (loop[first][0] - px) ** 2 + (loop[first][1] - py) ** 2) first = i; });
}
const half = Number(widthText) / 2;
const rows = [...loop.slice(first), ...loop.slice(0, first)].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)},${half.toFixed(3)},${half.toFixed(3)}`);
writeFileSync(out, [
  '# x_m,y_m,w_tr_right_m,w_tr_left_m',
  `# OpenStreetMap ways ${used.join(',')} (c) OpenStreetMap contributors, ODbL; origin lat,lon ${lat0.toFixed(6)},${lon0.toFixed(6)}; widths from published specs`,
  ...rows, '',
].join('\n'));
console.log(`${out}: ${used.length} ways, ${loop.length} points, ${length.toFixed(0)} m${pits.length ? '' : ' (no pit lane found: the start line is the seed way\'s start)'}`);
