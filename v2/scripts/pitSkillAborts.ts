// Preload for incidents.ts / bench.ts: a stop the pit skill drives is given up where the pit maneuver gives up its own
// (pitting.ts notLinedUp: still on the track side of the pit wall's line in the last stretch before its nose), and the
// maneuver backs the car out onto the racing surface past the nose, as it does after its own aborts. The crew chief
// calls the stop again next lap. Nothing else changes: the pit skill drives the rest of every stop.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/pitSkillAborts.ts --import ./scripts/pitEntryHits.ts \
//     scripts/incidents.ts public/drivers/stable-candidate-v8s-lines.json --tracks speedway --seeds 2 --field 40 --rules 1
import { Team } from '../src/ai/drivers';
import { notLinedUp } from '../src/ai/pitting';
import type { Car } from '../src/sim/car';
import type { World } from '../src/sim/world';

let aborts = 0;
const decide = Team.prototype.decide;
Team.prototype.decide = function (this: Team, car: Car, world: World) {
  if (this.driverPits && car.pit.phase === 'in' && notLinedUp(world.track, car)) {
    aborts++;
    // The maneuver's own abort (the stop off, the car backed out).
    this.autopilot.decide(car, world, this.spotter);
  }
  if (this.driverPits && this.autopilot.aborting && car.pit.phase === 'none') {
    // (The team's own bookkeeping first: the lap's pit call, the radio. Then the maneuver has the wheel.)
    decide.call(this, car, world);
    this.mode = 'pit';
    this.autopilot.decide(car, world, this.spotter);
    return;
  }
  decide.call(this, car, world);
};

process.on('exit', () => console.log(`PITABORT ${aborts} stops the pit skill drove given up, not lined up`));
