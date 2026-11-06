// Preload for incidents.ts: wall hits around pit road's way in, by what was hit (the pit wall's nose, its track-side
// or pit-side face, another wall), where the car was (m past the nose, m inside the wall's line), how fast it came in
// and at what angle to the track, how far short of pit road's fast lane it was on its way in, whether it was pitting and who drove (the pit skill, the pit maneuver's script, the
// racing or caution skill). Prints PITENTRY lines at exit: a table by what was hit, then the worst hits one by one.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8ra-lines.json --tracks oval:3148308672:speedway --seeds 2 --field 40 --rules 1
import { World } from '../src/sim/world';
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';
import type { Track } from '../src/sim/track';
import { pitLanes } from '../src/ai/pitting';

/** Metres before the nose and past it that count as the way in. */
const BEFORE = 150, AFTER = 80;

interface Hit {
  track: string; what: string; phase: string; by: string; flag: string;
  past: number; inside: number; speed: number; angle: number; health: number;
  /** Before the step: speed and angle to the track (the hit's approach, not its bounce). */
  speedIn: number; angleIn: number;
  /** Its way in: m short of pit road's fast lane (+: still toward the track) and speed, 60, 30 and 10 m before the nose. */
  marks: string;
}
/** Points before the nose (m) where a pitting car's lateral lag and speed are noted. */
const MARKS = [60, 30, 10];
const ways = new WeakMap<Car, Array<{ lag: number; speed: number; beside: boolean } | undefined>>();
/** Every pitting car's lag 10 m before the nose (m), and whether a car was beside it on pit road's side. */
const at10: Array<{ lag: number; beside: boolean; hit: boolean }> = [];
/** Each pitting car's way in this time (its at10 entry), so a hit on the nose marks that entry. */
const current = new WeakMap<Car, { lag: number; beside: boolean; hit: boolean }>();
/** Ways in that reached 10 m before the nose, and those that went on into it. */
let entries = 0, noseCars = 0;
const way = (c: Car) => { let w = ways.get(c); if (!w) { w = []; ways.set(c, w); } return w; };
const angleOf = (t: Track, c: { vx: number; vy: number; trackIdx: number }) => {
  const i = c.trackIdx;
  return (Math.atan2(c.vx * -t.ty[i] + c.vy * t.tx[i], c.vx * t.tx[i] + c.vy * t.ty[i]) * 180) / Math.PI;
};
const hits: Hit[] = [];
let trackName = '';
const seen = new WeakSet<Track>();

/** What the car is touching: the pit wall's nose (a cap near the wall's start), one of its faces, or another wall. */
function touching(car: Car, track: Track): string {
  const p = track.pit;
  const [nx, ny] = p.wallEnds[0];
  if (Math.hypot(car.x - nx, car.y - ny) < car.radius + p.wallThickness / 2 + 0.3) return 'nose';
  for (const cap of track.wallCaps) {
    if (Math.hypot(car.x - cap.x, car.y - cap.y) < car.radius + cap.radius + 0.3) return 'another wall end';
  }
  const wallD = p.wallD + track.pitOffset(car.s);
  if (track.inPitWallZone(car.s) && Math.abs(car.d - wallD) < car.radius + p.wallThickness / 2 + 0.3) {
    return car.d < wallD ? 'pit wall, track side' : 'pit wall, pit side';
  }
  for (const w of track.walls) {
    if (!track.inRange(car.s, w.range)) continue;
    const mid = typeof w.d === 'number' ? w.d : track.edgeAt(w.d, car.s);
    if (Math.abs(car.d - mid) < car.radius + w.thickness / 2 + 0.3) return `wall ${w.id}`;
  }
  return 'other';
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const t = this.track;
  if (!seen.has(t)) {
    seen.add(t);
    trackName = `${t.length.toFixed(0)} m`;
    const p = t.pit;
    console.log(`PITENTRY track ${trackName}: entry ${(p.wallStart - p.entryStart).toFixed(0)} m long, nose ${(p.wallD - p.wallThickness / 2 - t.innerEdgeAt(p.wallStart)).toFixed(1)} m inside the racing surface's edge, apron ${t.apronWidth.toFixed(1)} m, car width ${(2 * P.CAR_RADIUS).toFixed(1)} m`);
  }
  const before = this.cars.map((c, k) => ({
    health: c.health, phase: c.pit.phase, mode: (this.controllers[k] as any)?.mode as string | undefined,
    speed: c.speed, angle: angleOf(t, c), past: t.signedS(c.s) - t.pit.wallStart,
  }));
  step.call(this);
  const p = t.pit;
  const fast = pitLanes(t).fastLane;
  this.cars.forEach((c, k) => {
    if (c.pit.phase === 'in') {
      const past = t.signedS(c.s) - p.wallStart, was = before[k].past;
      MARKS.forEach((m, j) => {
        if (was < -m && past >= -m) {
          // Beside it on pit road's side: overlapping along the track, a car's width or more toward pit road.
          const beside = this.cars.some((o) => o !== c && !o.retired && Math.abs(t.signedS(o.s) - t.signedS(c.s)) < 4 * P.CAR_RADIUS + 1.5
            && o.d - c.d > 2 * P.CAR_RADIUS - 0.5 && o.d - c.d < 6);
          way(c)[j] = { lag: fast + t.pitOffset(c.s) - c.d, speed: c.speed, beside };
          if (m === 10) { entries++; const e = { lag: fast + t.pitOffset(c.s) - c.d, beside, hit: false }; at10.push(e); current.set(c, e); }
        }
      });
    } else if (before[k].phase === 'in' || c.pit.phase === 'none') { ways.delete(c); current.delete(c); }
  });
  this.cars.forEach((c, k) => {
    const lost = before[k].health - c.health;
    if (lost <= 1e-4 || c.lastImpact?.kind !== 'wall') return;
    const past = t.signedS(c.s) - p.wallStart;
    if (past < -BEFORE || past > AFTER) return;
    const ctrl = this.controllers[k] as any;
    const mode = before[k].mode ?? ctrl?.mode ?? '?';
    const phase = before[k].phase;
    const by = mode === 'pit' ? 'pit script' : mode === 'formation' ? 'formation script'
      : phase !== 'none' ? 'pit skill' : this.control?.pacing && ctrl?.driverCautions ? 'caution skill' : 'racing skill';
    const what = touching(c, t);
    const entry = current.get(c);
    if (what === 'nose' && phase === 'in' && entry && !entry.hit) { entry.hit = true; noseCars++; }
    const marks = MARKS.map((m, j) => { const w = ways.get(c)?.[j]; return w ? `${m} m: ${w.lag.toFixed(1)} m short at ${w.speed.toFixed(0)} m/s${w.beside ? ', a car beside' : ''}` : `${m} m: -`; }).join(', ');
    hits.push({
      track: trackName, what, phase, by, flag: this.control?.flag === 'green' ? 'green' : this.control?.flag ?? 'none',
      past, inside: c.d - (p.wallD + t.pitOffset(c.s)), speed: c.speed, angle: angleOf(t, c), health: lost,
      speedIn: before[k].speed, angleIn: before[k].angle, marks,
    });
  });
};

process.on('exit', () => {
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const key = `${h.track.padEnd(8)} ${h.what.padEnd(22)} ${h.phase.padEnd(5)} ${h.by}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const total = hits.reduce((a, h) => a + h.health, 0);
  console.log(`PITENTRY ${entries} cars on their way in reached 10 m before the nose; ${noseCars} of them hit it`);
  const band = (lo: number, hi: number) => at10.filter((e) => e.lag >= lo && e.lag < hi);
  for (const [lo, hi] of [[-Infinity, 1], [1, 2.5], [2.5, Infinity]] as const) {
    const b = band(lo, hi);
    console.log(`PITENTRY 10 m before the nose ${lo === -Infinity ? 'under 1' : hi === Infinity ? `${lo}+` : `${lo}-${hi}`} m short of the fast lane: ${b.length} cars, ${b.filter((e) => e.beside).length} with a car beside on pit road's side, ${b.filter((e) => e.hit).length} hit the nose`);
  }
  console.log(`PITENTRY wall damage within ${BEFORE} m before the pit wall's nose and ${AFTER} m past it: ${total.toFixed(2)} health, ${hits.length} steps`);
  for (const [k, g] of [...groups].sort((a, b) => b[1].reduce((x, h) => x + h.health, 0) - a[1].reduce((x, h) => x + h.health, 0))) {
    console.log(`PITENTRY ${k.padEnd(58)} health ${g.reduce((x, h) => x + h.health, 0).toFixed(2).padStart(6)}  steps ${String(g.length).padStart(5)}`
      + `  past nose med ${med(g.map((h) => h.past)).toFixed(0).padStart(4)} m  speed in med ${med(g.map((h) => h.speedIn)).toFixed(1).padStart(4)}  angle in med ${med(g.map((h) => h.angleIn)).toFixed(0).padStart(3)} deg`);
  }
  for (const h of [...hits].sort((a, b) => b.health - a.health).slice(0, 15)) {
    console.log(`PITENTRY hit ${h.track} ${h.what}, ${h.phase}, ${h.by}, ${h.flag}: ${h.past.toFixed(1)} m past the nose, ${h.inside.toFixed(1)} m from the wall's line, in at ${h.speedIn.toFixed(1)} m/s, ${h.angleIn.toFixed(0)} deg (out at ${h.speed.toFixed(1)}, ${h.angle.toFixed(0)} deg), health ${h.health.toFixed(3)}; ${h.marks}`);
  }
});
