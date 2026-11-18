/**
 * Step-by-step trace of one champion's second lap: line, speed, wall contact, input.
 *
 *   npx tsx scripts/trace.ts runs/<file>.json <lineage> <track>
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { FLAT_TRACK, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lineage = Number(process.argv[3] ?? 0);
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK } as const;
const track = ovalTrack(specs[(process.argv[4] ?? 'short') as keyof typeof specs]);
const world = new World(track, { collisions: false, drafting: false });
const car = new Car(0);
car.placeOnTrack(track, track.length - 20, 0);
world.addCar(car, neuralTeam(adaptWeights(Float32Array.from(run.champions[lineage].weights))));

let contacts = 0;
while (car.lapsCompleted < 2 && world.time < 90 && !car.retired) {
  const before = car.wallContact;
  world.step();
  if (car.wallContact && !before) contacts++;
  if (car.lapsCompleted === 1 && world.tick % 24 === 0) {
    const ang = (Math.atan2(car.inputY, car.inputX) * 180) / Math.PI;
    console.log(
      `t=${world.time.toFixed(1)} s=${car.s.toFixed(0).padStart(4)} turn=${track.turn[car.trackIdx].toFixed(2)} ` +
      `d=${car.d.toFixed(1).padStart(5)} v=${car.speed.toFixed(1)} wall=${car.wallContact ? 'X' : '.'} ` +
      `in=${Math.min(1, Math.hypot(car.inputX, car.inputY)).toFixed(2)}@${ang.toFixed(0)} ` +
      `cap=${car.capacity.toFixed(1)} slide=${car.sliding.toFixed(2)} health=${car.health.toFixed(2)}`,
    );
  }
}
console.log(`contacts=${contacts} laps=${car.lapTimes.map((t) => t.toFixed(2)).join(' ')}`);
