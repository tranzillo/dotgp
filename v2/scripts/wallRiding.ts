// Preload: is riding the wall worth it? In races under green, for each 20 m of the lap, the speed of cars riding the
// outside wall (their side within 0.3 m of it) against cars off it there; and green laps with a second or more riding
// against laps with none (each car's own: its median clean lap against its median riding lap).
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/wallRiding.ts scripts/incidents.ts \
//     lab/cup-retrain/v6.json --tracks speedway --seeds 1 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';
import { World } from '../src/sim/world';

const BIN = 20, RIDE = 0.3;
/** Scrape work (Car.wallScrape) done riding, and the time riding, at each car's last look. */
let scrapeRiding = 0, timeRiding = 0, scrapeAll = 0;
const lastScrape = new WeakMap<Car, number>();
const bins = new Map<number, { ride: number[]; off: number[] }>();
const lapState = new WeakMap<Car, { laps: number; riding: number; green: boolean }>();
const laps = new Map<number, { clean: number[]; riding: number[] }>();
let trackLength = 0;
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const ctl = this.control;
  if (!ctl) return;
  trackLength = this.track.length;
  const outer = this.track.walls.find((w) => w.faces === 'in' && w.range === null);
  if (!outer) return;
  this.cars.forEach((c) => {
    const st = lapState.get(c) ?? { laps: c.lapTimes.length, riding: 0, green: true };
    lapState.set(c, st);
    if (c.lapTimes.length > st.laps) {
      // A lap done: kept if it was all green, on track, sound.
      if (st.green && st.laps > 0) {
        const l = laps.get(c.id) ?? { clean: [], riding: [] };
        laps.set(c.id, l);
        (st.riding >= 1 ? l.riding : st.riding === 0 ? l.clean : []).push(c.lapTimes[c.lapTimes.length - 1]);
      }
      st.laps = c.lapTimes.length; st.riding = 0; st.green = true;
    }
    if (ctl.flag !== 'green' || c.retired || c.pit.phase !== 'none' || c.health < 0.9) { st.green = false; return; }
    const gap = c.d - P.CAR_RADIUS - (this.track.edgeAt(outer.d as never, c.s) + outer.thickness / 2);
    const riding = gap < RIDE;
    const scraped = c.wallScrape - (lastScrape.get(c) ?? c.wallScrape);
    lastScrape.set(c, c.wallScrape);
    scrapeAll += scraped;
    if (riding) { st.riding += P.DT; timeRiding += P.DT; scrapeRiding += scraped; }
    const k = Math.floor(c.s / BIN);
    const b = bins.get(k) ?? { ride: [], off: [] };
    bins.set(k, b);
    if (this.tick % 5 === 0) (riding ? b.ride : b.off).push(c.speed);
  });
};
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
process.on('exit', () => {
  const rows = [...bins].filter(([, b]) => b.ride.length >= 20 && b.off.length >= 20).sort((a, b) => a[0] - b[0]);
  console.error(`RIDING speed by 20 m of the lap (${trackLength.toFixed(0)} m), riding the wall vs off it (samples):`);
  for (const [k, b] of rows) console.error(`RIDING   s ${String(k * BIN).padStart(5)}  ${mean(b.ride).toFixed(1)} vs ${mean(b.off).toFixed(1)} m/s  (${b.ride.length}/${b.off.length})`);
  console.error(`RIDING scrape work ${scrapeAll.toFixed(0)} (m/s)^2 under green, ${scrapeRiding.toFixed(0)} of it riding: ${(scrapeRiding / Math.max(1e-9, timeRiding)).toFixed(1)} a second riding (${timeRiding.toFixed(0)} car-s)`);
  const diffs: number[] = [];
  let both = 0;
  for (const l of laps.values()) if (l.clean.length >= 2 && l.riding.length >= 2) { both++; diffs.push(median(l.riding) - median(l.clean)); }
  const all = [...laps.values()];
  console.error(`RIDING laps: clean ${all.reduce((a, l) => a + l.clean.length, 0)}, riding ${all.reduce((a, l) => a + l.riding.length, 0)}; `
    + `cars with both ${both}: riding lap minus clean lap, median ${diffs.length ? median(diffs).toFixed(3) : '-'} s, `
    + `mean ${diffs.length ? mean(diffs).toFixed(3) : '-'} s, faster riding ${diffs.filter((d) => d < 0).length} of ${diffs.length}`);
});
