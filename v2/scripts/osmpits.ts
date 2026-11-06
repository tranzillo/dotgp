/**
 * The real tracks' pit lanes from OpenStreetMap, in each survey's own frame,
 * for trackgen/realtrack.ts (public/tracks/pits.json): the raceway ways
 * round the track fetched from the Overpass API, the pit lane the longest
 * chain of ways named "pit", and the survey laid over OpenStreetMap's
 * raceway (an OpenStreetMap survey shares its frame; a TUMFTM one is fitted
 * by iterative closest points: a turn and a shift).
 *
 *   npx tsx scripts/osmpits.ts [id ...]
 *
 * The data is © OpenStreetMap contributors (ODbL): the file says which ways.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSurvey, REAL_TRACKS } from '../src/trackgen/realtrack';

type Pt = [number, number];
interface Way { id: number; tags: Record<string, string>; geometry: Array<{ lat: number; lon: number }>; xy: Pt[] }

/** Where each TUMFTM track is (lat, lon); an OpenStreetMap survey says in its header. */
const PLACES: Record<string, [number, number]> = {
  austin: [30.1346, -97.6359], brandshatch: [51.3569, 0.2631], budapest: [47.5789, 19.2486], catalunya: [41.57, 2.2611],
  hockenheim: [49.3278, 8.5656], indianapolis: [39.795, -86.2347], melbourne: [-37.8497, 144.968], mexicocity: [19.4042, -99.0907],
  montreal: [45.5, -73.5228], monza: [45.619, 9.2811], moscow: [55.9744, 35.7928], norisring: [49.4314, 11.1203],
  nurburgring: [50.3356, 6.9475], oschersleben: [52.0272, 11.2797], sakhir: [26.0325, 50.5106], saopaulo: [-23.7036, -46.6997],
  sepang: [2.7608, 101.7382], shanghai: [31.3389, 121.2197], silverstone: [52.0786, -1.0169], sochi: [43.4057, 39.9578],
  spa: [50.4372, 5.9714], spielberg: [47.2197, 14.7647], yasmarina: [24.4672, 54.6031], zandvoort: [52.3888, 4.5409],
};

const OUT = 'public/tracks/pits.json';
const only = process.argv.slice(2);
const saved: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

async function raceways(lat: number, lon: number, radius: number): Promise<Way[]> {
  const query = `[out:json][timeout:90];way["highway"="raceway"](around:${radius},${lat},${lon});out tags geom;`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'dotgp-track-import/0.1' },
    });
    if (res.ok) return ((await res.json()) as { elements: Way[] }).elements.filter((w) => (w.geometry?.length ?? 0) >= 2);
    if (attempt >= 3) throw new Error(`Overpass: ${res.status}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

/** A line's points every `step` m or closer. */
function densify(pts: Pt[], step: number, closed: boolean): Pt[] {
  const out: Pt[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let j = 0; j < k; j++) out.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/** A grid of points for nearest-point queries. */
function grid(pts: Pt[], cell: number) {
  const cells = new Map<string, Pt[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const p of pts) (cells.get(key(p[0], p[1])) ?? cells.set(key(p[0], p[1]), []).get(key(p[0], p[1]))!).push(p);
  return (x: number, y: number): Pt | null => {
    let best: Pt | null = null, bd = Infinity;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const p of cells.get(`${cx + i},${cy + j}`) ?? []) {
        const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
    }
    return best;
  };
}

/** The turn and shift laying `from` over `onto` (iterative closest points, pairs within `reach` m): x' = R x + t. */
function register(from: Pt[], onto: Pt[], init: { a: number; tx: number; ty: number }) {
  const near = grid(onto, 40);
  let { a, tx, ty } = init, mean = Infinity, used = 0;
  for (let reach = 40; reach >= 8; reach *= 0.85) {
    for (let it = 0; it < 6; it++) {
      const c = Math.cos(a), s = Math.sin(a);
      const pairs: Array<[Pt, Pt]> = [];
      let sum = 0;
      for (const [x, y] of from) {
        const X = c * x - s * y + tx, Y = s * x + c * y + ty, q = near(X, Y);
        if (!q) continue;
        const d = Math.hypot(q[0] - X, q[1] - Y);
        if (d < reach) { pairs.push([[x, y], q]); sum += d; }
      }
      if (pairs.length < from.length / 3) return null;
      mean = sum / pairs.length; used = pairs.length / from.length;
      // (The best turn and shift for these pairs: Procrustes in 2D.)
      const mx = pairs.reduce((v, p) => v + p[0][0], 0) / pairs.length, my = pairs.reduce((v, p) => v + p[0][1], 0) / pairs.length;
      const qx = pairs.reduce((v, p) => v + p[1][0], 0) / pairs.length, qy = pairs.reduce((v, p) => v + p[1][1], 0) / pairs.length;
      let sxx = 0, sxy = 0;
      for (const [[x, y], [u, v]] of pairs) { sxx += (x - mx) * (u - qx) + (y - my) * (v - qy); sxy += (x - mx) * (v - qy) - (y - my) * (u - qx); }
      a = Math.atan2(sxy, sxx);
      tx = qx - (Math.cos(a) * mx - Math.sin(a) * my);
      ty = qy - (Math.sin(a) * mx + Math.cos(a) * my);
    }
  }
  return { a, tx, ty, mean, used };
}

/** The pit lane's ways. (Named in the local language, often: Boxengasse, voie des stands, пит-лейн, 维修区; or tagged as one.) */
function pitWays(ways: Way[]): Way[] {
  const named = (w: Way) => /pit|box|stand|пит|бокс|维修|維修/i.test(`${w.tags?.name ?? ''} ${w.tags?.['name:en'] ?? ''}`)
    || /pit/i.test(`${w.tags?.service ?? ''} ${w.tags?.raceway ?? ''}`);
  return ways.filter((w) => named(w) && !/road course|kart|short|long lap/i.test(w.tags?.name ?? ''));
}

/** The longest chain of the pit lane's ways (end to start), in driving order. */
function pitLane(pits: Way[]): { ids: number[]; pts: Pt[] } | null {
  if (!pits.length) return null;
  const k = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  let best: { ids: number[]; pts: Pt[]; length: number } | null = null;
  for (const start of pits) {
    const ids = [start.id], pts = [...start.xy];
    for (let more = true; more;) {
      more = false;
      for (const w of pits) {
        if (ids.includes(w.id)) continue;
        if (k(w.xy[0]) === k(pts[pts.length - 1])) { ids.push(w.id); pts.push(...w.xy.slice(1)); more = true; }
        else if (k(w.xy[w.xy.length - 1]) === k(pts[0])) { ids.unshift(w.id); pts.unshift(...w.xy.slice(0, -1)); more = true; }
      }
    }
    const length = pts.reduce((v, p, i) => (i ? v + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
    if (!best || length > best.length) best = { ids, pts, length };
  }
  return best;
}

for (const real of REAL_TRACKS.filter((t) => !only.length || only.includes(t.id))) {
  const csv = readFileSync(`public/tracks/${real.file}`, 'utf8');
  const survey = parseSurvey(csv).points;
  const header = csv.match(/origin lat,lon (-?[\d.]+),(-?[\d.]+)/);
  const place = header ? [Number(header[1]), Number(header[2])] as Pt : PLACES[real.id];
  if (!place) { console.log(`${real.id}: no place`); continue; }
  const ways = await raceways(place[0], place[1], 3000);
  // (An OpenStreetMap survey's frame: metres round its origin. TUMFTM's are local too, north up, so the same frame
  // round the place, then fitted.)
  const [lat0, lon0] = place;
  for (const w of ways) w.xy = w.geometry.map((p) => [(p.lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), (p.lat - lat0) * 110574]);
  const pits = pitWays(ways);
  const lane = pitLane(pits);
  if (!lane) { console.log(`${real.name.padEnd(30)} no pit lane mapped`); continue; }
  let fit = { a: 0, tx: 0, ty: 0, mean: 0, used: 1 };
  if (!header) {
    const track = densify(ways.filter((w) => !pits.includes(w) && !/kart/i.test(w.tags?.name ?? '') && !w.tags?.historic && w.tags?.area !== 'yes').flatMap((w) => densify(w.xy, 4, false)), 4, false);
    const pts = densify(survey, 10, true);
    // (Started from the shift, north up as both are, that puts the most of the survey near the raceway.)
    const near = grid(track, 40);
    const [mx, my] = [pts.reduce((v, p) => v + p[0], 0) / pts.length, pts.reduce((v, p) => v + p[1], 0) / pts.length];
    const [gx, gy] = [track.reduce((v, p) => v + p[0], 0) / track.length, track.reduce((v, p) => v + p[1], 0) / track.length];
    let start = { tx: gx - mx, ty: gy - my, score: -1 };
    for (let dx = -600; dx <= 600; dx += 20) for (let dy = -600; dy <= 600; dy += 20) {
      let score = 0;
      for (let i = 0; i < pts.length; i += 4) {
        const x = pts[i][0] + gx - mx + dx, y = pts[i][1] + gy - my + dy, q = near(x, y);
        if (q && Math.hypot(q[0] - x, q[1] - y) < 15) score++;
      }
      if (score > start.score) start = { tx: gx - mx + dx, ty: gy - my + dy, score };
    }
    const best = register(pts, track, { a: 0, ...start });
    if (!best || best.mean > 6 || best.used < 0.8) {
      console.log(`${real.name.padEnd(30)} the survey doesn't fit the mapped raceway${best ? ` (${best.mean.toFixed(1)} m, ${(best.used * 100).toFixed(0)}% paired)` : ''}`);
      continue;
    }
    fit = best;
  }
  // The pit lane in the survey's frame (the fit's inverse).
  const c = Math.cos(fit.a), s = Math.sin(fit.a);
  const points = lane.pts.map(([x, y]) => [x - fit.tx, y - fit.ty]).map(([x, y]) => [+(c * x + s * y).toFixed(2), +(-s * x + c * y).toFixed(2)]);
  saved[real.id] = { ways: lane.ids, fit: { turn: +((fit.a * 180) / Math.PI).toFixed(3), mean: +fit.mean.toFixed(2) }, points };
  const length = lane.pts.reduce((v, p, i) => (i ? v + Math.hypot(p[0] - lane.pts[i - 1][0], p[1] - lane.pts[i - 1][1]) : 0), 0);
  console.log(`${real.name.padEnd(30)} pit lane ${length.toFixed(0)} m (${lane.ids.length} ways), survey fitted within ${fit.mean.toFixed(1)} m, turned ${((fit.a * 180) / Math.PI).toFixed(2)} deg`);
}
const sorted = Object.fromEntries(Object.keys(saved).sort().map((k) => [k, saved[k]]));
writeFileSync(OUT, JSON.stringify({
  _source: 'Pit lanes from OpenStreetMap (c) OpenStreetMap contributors, ODbL (the ways listed); points in each survey\'s frame (m).',
  ...Object.fromEntries(Object.entries(sorted).filter(([k]) => k !== '_source')),
}, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]') + '\n');
