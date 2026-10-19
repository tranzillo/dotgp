// Pit survey: generated ovals of every size, a scripted car called in once on each (the full pit cycle, as the pit
// tests run it): clean stops, and how many pit roads came out set back. npx tsx scripts/pitsurvey.ts [seeds per size]
import { ScriptedDriver, Team } from '../src/ai/drivers';
import type { CrewChief } from '../src/ai/pitting';
import { TowerSpotter } from '../src/ai/spotter';
import { Car, type PitCall } from '../src/sim/car';
import { PIT_SERVICE } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, type ShapedOvalParams } from '../src/trackgen';
class CallOnce implements CrewChief {
  lastMessage = 'Box this lap'; private called = false;
  decide(): PitCall | null { if (this.called) return null; this.called = true; return { tires: true, fuel: 30, repair: false }; }
}
let ok = 0, fails = 0, genErr = 0;
const seeds = Number(process.argv[2] ?? 10);
for (const variant of ['short', 'intermediate', 'speedway', 'superspeedway']) {
  for (let seed = 1; seed <= seeds; seed++) {
    let layout;
    try { layout = generateLayout({ type: 'oval', seed, variant }); } catch (e) { genErr++; console.log(`${variant} ${seed} GEN ERROR ${(e as Error).message.split('\n').slice(1, 3).join(' | ')}`); continue; }
    const t = new Track(layout);
    const plan = (layout.params as unknown as ShapedOvalParams).pits!;
    const world = new World(t, { collisions: false });
    const car = new Car(0);
    placeOnGrid(car, t, 0, true);
    car.fuel = 20; car.tireLife = 0.5;
    world.addCar(car, new Team(new ScriptedDriver(0), new TowerSpotter(), new CallOnce()));
    let maxPitSpeed = 0, rejoined = false;
    while (world.time < 400) {
      world.step();
      if (car.surface === 'pit' && car.pit.phase === 'in' && t.signedS(car.s) > t.pit.wallStart + 30) maxPitSpeed = Math.max(maxPitSpeed, car.speed);
      if (car.pit.stops === 1 && car.pit.phase === 'none') { for (let k = 0; k < 360; k++) world.step(); rejoined = car.d < t.halfWidth; break; }
    }
    const missed = world.events.filter((e) => e.kind === 'missed-pit').map((e) => e.text);
    const good = car.pit.stops === 1 && car.health === 1 && rejoined && maxPitSpeed < PIT_SERVICE.SPEED_LIMIT + 1;
    good ? ok++ : fails++;
    console.log(`${variant} ${seed} ${(layout.params as never as ShapedOvalParams).shape}${t.pit.offset ? " CHORD" : ""} gap=${plan.gap}->${(t.pit.wallD - t.innerEdgeAt(t.pit.wallStart) - 0.4).toFixed(0)} entry=${plan.entryLength} garage+${plan.garageSetBack}x${plan.garageLanes} stalls=${t.pit.stalls.length} ${good ? 'OK' : `FAIL stops=${car.pit.stops} health=${car.health.toFixed(2)} rejoined=${rejoined} vmax=${maxPitSpeed.toFixed(1)} ${missed.join(';')}`}`);
  }
}
console.log({ ok, fails, genErr });
