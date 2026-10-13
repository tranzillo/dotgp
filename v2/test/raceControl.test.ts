import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { Car } from '../src/sim/car';
import { Race } from '../src/sim/race';
import { SPEEDWAY, Track } from '../src/sim/track';
import { World } from '../src/sim/world';

const drivers = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers
  .map((d: { weights: number[] }) => adaptWeights(Float32Array.from(d.weights)));

describe('race control', () => {
  it('runs pace laps, a caution with the wrecker, a restart, and a finish', () => {
    const track = new Track(SPEEDWAY);
    const world = new World(track, { wearScale: 4 });
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), neuralTeam(drivers[k % drivers.length]));
    const race = new Race(world, 6, new PaceCarDriver());
    const ctl = race.control!;
    const flags: string[] = [];
    let wrecked: Car | null = null;
    let maxFormationGap = 0;
    while (race.state !== 'finished' && world.time < 900) {
      race.step();
      if (flags[flags.length - 1] !== ctl.flag) flags.push(ctl.flag);
      const leader = race.leader();
      if (!wrecked && race.started && leader && leader.lapsCompleted === 2) {
        wrecked = world.cars.find((c) => c !== leader)!;
        wrecked.health = 0;
        wrecked.retired = true;
      }
      // Late in a caution the field should be bunched up behind the pace car.
      if (ctl.flag === 'caution' && ctl.oneToGo) {
        const running = world.cars.filter((c) => !c.retired && c.pit.phase === 'none').sort((a, b) => b.dist - a.dist);
        maxFormationGap = Math.max(maxFormationGap, running[0].dist - running[running.length - 1].dist);
      }
    }
    expect(flags).toEqual(['pace', 'restart', 'green', 'caution', 'restart', 'green']);
    expect(race.state).toBe('finished');
    expect(ctl.cautions).toBe(1);
    // The wreck was towed to the garage and parked there.
    expect(ctl.wreckers.length).toBe(1);
    expect(ctl.wreckers[0].phase).toBe('done');
    expect(wrecked!.parked).toBe(true);
    expect(track.surfaceAt(wrecked!.s, wrecked!.d, wrecked!.x, wrecked!.y)).toBe('garage');
    // Only the forced wreck retired: formation driving didn't cause any more.
    expect(world.cars.filter((c) => c.retired)).toHaveLength(1);
    // Double file, tight: 5 running cars = 3 rows.
    expect(maxFormationGap).toBeLessThan(60);
  });
});
