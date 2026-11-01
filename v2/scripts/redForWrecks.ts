// Preload for incidents.ts / bench.ts: the red flag for any wreck left on the racing surface (or an oval's apron), not
// only one leaving less than a car's width and a metre to get by (raceControl.ts RED_FREE). Under caution the field then
// stops in line short of it until it's towed off, instead of filing past it at pace. No retraining: the caution skill
// drives the stop as it drives any slowing of the line.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/redForWrecks.ts --import ./scripts/cautionWrecks.ts \
//     scripts/incidents.ts public/drivers/stable-candidate-v8ra-lines.json --tracks oval:774865359:superspeedway --seeds 2 --field 40 --rules 1
import { RaceControl } from '../src/sim/raceControl';

const ZONE = 30; // m: wrecks this near each other are one place (raceControl.ts ZONE_LENGTH)
RaceControl.prototype.blockedPlaces = function (this: RaceControl): number[] {
  const t = this.track;
  const places: number[] = [];
  for (const w of this.world.cars) {
    if (!w.retired || w.cleared || w.speed > 1 || w.d >= t.innerEdge(w.trackIdx) + t.apronWidth) continue;
    if (places.some((s) => { const ds = t.distanceFrom(s, w.s); return Math.min(ds, t.length - ds) <= ZONE; })) continue;
    places.push(w.s);
  }
  return places;
};
