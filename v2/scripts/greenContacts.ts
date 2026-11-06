// Preload: car-to-car contact under green, how it happened. Each contact that cost health: where the other car was
// (the contact's angle: beside it, or nose to tail), how fast the two closed across the track and along it, and which
// of them was moving across toward the other (the car moving over into another, or the other into it, or both). Tells
// a car swinging across into one alongside from one running into the back of another. Prints GREEN lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/greenContacts.ts scripts/incidents.ts \
//     lab/cup-retrain-c/v7.json --tracks short --seeds 2 --field 40 --rules 1
import { World } from '../src/sim/world';

type Hit = { side: boolean; across: number; along: number; mover: string };
const hits: Hit[] = [];
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const track = this.track, L = track.length;
  // Speeds across and along the track before the step (the contact changes them).
  const vel = this.cars.map((c) => {
    const i = c.trackIdx, tx = track.tx[i], ty = track.ty[i];
    return { lon: c.vx * tx + c.vy * ty, lat: c.vx * -ty + c.vy * tx, impact: c.lastImpact, health: c.health, retired: c.retired };
  });
  step.call(this);
  if (this.control?.flag !== 'green') return;
  const seen = new Set<string>();
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (vel[k].retired || !imp || imp === vel[k].impact || imp.kind !== 'car' || c.health >= vel[k].health - 1e-6) return;
    const j = this.cars.findIndex((o) => o.id === imp.other);
    if (j < 0) return;
    const key = k < j ? `${k}-${j}` : `${j}-${k}`;
    if (seen.has(key)) return;
    seen.add(key);
    const o = this.cars[j];
    let ds = o.s - c.s;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    const dd = o.d - c.d;
    // Closing across: each one's speed toward the other (+d is across toward o for c when dd > 0).
    const sgn = Math.sign(dd) || 1;
    const cToward = vel[k].lat * sgn, oToward = -vel[j].lat * sgn;
    const across = cToward + oToward;
    const along = Math.sign(ds) * (vel[k].lon - vel[j].lon);
    const MOVING = 0.5; // m/s toward the other
    const mover = cToward > MOVING && oToward > MOVING ? 'both' : cToward > MOVING || oToward > MOVING ? 'one' : 'neither';
    hits.push({ side: Math.abs(dd) > Math.abs(ds), across, along, mover });
  });
};
process.on('exit', () => {
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
  console.error(`GREEN contacts ${hits.length}: by angle and who was moving across (count; median closing across, along m/s)`);
  for (const side of [true, false]) {
    for (const mover of ['one', 'both', 'neither']) {
      const these = hits.filter((h) => h.side === side && h.mover === mover);
      console.error(`GREEN   ${(side ? 'beside' : 'nose to tail').padEnd(13)} ${mover.padEnd(8)} ${String(these.length).padStart(5)}  `
        + `${med(these.map((h) => h.across)).toFixed(2)}  ${med(these.map((h) => h.along)).toFixed(2)}`);
    }
  }
  const buckets = [0.5, 1, 2, 3, Infinity];
  console.error(`GREEN closing across: ${buckets.map((b, i) => `${i ? buckets[i - 1] : '<'}-${b === Infinity ? '' : b} ${hits.filter((h) => h.across < b && (i === 0 || h.across >= buckets[i - 1])).length}`).join(', ')}`);
});
