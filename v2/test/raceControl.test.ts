import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { Car } from '../src/sim/car';
import { Race } from '../src/sim/race';
import { ovalTrack, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';

const drivers = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers
  .map((d: { weights: number[] }) => adaptWeights(Float32Array.from(d.weights)));

describe('race control', () => {
  it('runs the last pace lap, a caution with the wrecker, a restart, and a finish', () => {
    const track = ovalTrack(SPEEDWAY);
    const world = new World(track, { wearScale: 4 });
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), neuralTeam(drivers[k % drivers.length]));
    const race = new Race(world, 6, new PaceCarDriver());
    const ctl = race.control!;
    const flags: string[] = [];
    let wrecked: Car | null = null;
    let maxFormationGap = 0;
    let greenAt = NaN;
    while (race.state !== 'finished' && world.time < 900) {
      race.step();
      const wasCaution = flags[flags.length - 1] === 'caution';
      if (flags[flags.length - 1] !== ctl.flag) flags.push(ctl.flag);
      if (race.started && Number.isNaN(greenAt)) greenAt = world.time;
      const leader = race.leader();
      if (!wrecked && race.started && leader && leader.lapsCompleted === 2) {
        wrecked = world.cars.find((c) => c !== leader)!;
        wrecked.health = 0;
        wrecked.retired = true;
      }
      // By the end of a caution, as the pace car pulls off, the field should be bunched up behind it.
      if (wasCaution && ctl.flag === 'restart') {
        const running = world.cars.filter((c) => !c.retired && c.pit.phase === 'none').sort((a, b) => b.dist - a.dist);
        maxFormationGap = Math.max(maxFormationGap, running[0].dist - running[running.length - 1].dist);
      }
    }
    expect(flags).toEqual(['pace', 'restart', 'green', 'caution', 'restart', 'green']);
    // Joined on the last pace lap: the pace car comes in and the green flies the first time by the line.
    expect(greenAt).toBeLessThan(30);
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

describe('standing start', () => {
  it('the end of the formation lap, the field stopped in its grid boxes, five lights, and the race starts as they go out', async () => {
    const { OVAL_RULES } = await import('../src/rules/rulebook');
    const { presetTrack } = await import('../src/trackgen');
    const track = presetTrack('short');
    const world = new World(track, { wearScale: 4 });
    for (let k = 0; k < 8; k++) world.addCar(new Car(k), neuralTeam(drivers[k % drivers.length]));
    const rulebook = { ...OVAL_RULES, start: { kind: 'standing' as const, formationLap: true, gridPitch: 8, lights: 5, lightInterval: 1, hold: [0.2, 3] as [number, number] } };
    const race = new Race(world, 3, new PaceCarDriver(), { rulebook, seed: 1 });
    const ctl = race.control!;
    // Rolling up to the grid, staggered, behind the line, in grid order a box apart.
    const grid = world.cars.map((c) => ({ s: track.signedS(c.s), d: c.d }));
    expect(grid.every((g) => g.s < 0)).toBe(true);
    expect(Math.sign(grid[0].d)).toBe(-Math.sign(grid[1].d));
    expect(world.cars.every((c) => c.speed > 5)).toBe(true);
    const boxes = grid.map((_, k) => -12 - k * rulebook.start.gridPitch);
    const flags: string[] = [];
    let maxLights = 0;
    let gridStill = true;
    while (ctl.flag !== 'green' && world.time < 200) {
      race.step();
      if (flags[flags.length - 1] !== ctl.flag) flags.push(ctl.flag);
      maxLights = Math.max(maxLights, ctl.lights);
      if (ctl.lights > 0) gridStill &&= world.cars.every((c) => c.speed < 0.5);
      expect(race.started).toBe((ctl.flag as string) === 'green'); // the race starts as the lights go out, not before
    }
    expect(flags).toEqual(['formation', 'grid', 'green']);
    expect(maxLights).toBe(5);
    expect(gridStill).toBe(true); // nobody creeps while the lights are on
    expect(world.cars.every((c) => !c.retired)).toBe(true); // waiting on the grid isn't stalling
    // Every car in its own box (the formation lap kept grid order).
    world.cars.forEach((c, k) => expect(Math.abs(track.signedS(c.s) - boxes[k])).toBeLessThan(3));
    expect(world.time).toBeLessThan(20); // joined at the end of the formation lap, not the start
    // Then they get away, each on its own reaction.
    for (let k = 0; k < 3 / 0.008333; k++) race.step();
    expect(world.cars.filter((c) => c.speed > 5).length).toBeGreaterThanOrEqual(6);
  });
});

describe('safety car', () => {
  it('a circuit race: standing start, a wreck, the safety car (single file, marshals), a restart, the flag', async () => {
    const { ScriptedDriver, Team } = await import('../src/ai/drivers');
    const { TowerSpotter } = await import('../src/ai/spotter');
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Track } = await import('../src/sim/track');
    const { generateLayout } = await import('../src/trackgen');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 4 });
    // Scripted drivers (the trained ones haven't learned circuits yet), each a little different.
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), new Team(new ScriptedDriver(0, 0.8 + 0.01 * k), new TowerSpotter()));
    const race = new Race(world, 5, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: 2 });
    const ctl = race.control!;
    expect(ctl.safetyCar).toBe(true);
    const flags: string[] = [];
    let wrecked: Car | null = null;
    let singleFile = true;
    while (race.state !== 'finished' && world.time < 1500) {
      race.step();
      if (flags[flags.length - 1] !== ctl.flag) flags.push(ctl.flag);
      const leader = race.leader();
      if (!wrecked && race.started && leader && leader.lapsCompleted === 2) {
        wrecked = world.cars.find((c) => c !== leader)!;
        wrecked.health = 0;
        wrecked.retired = true;
      }
      if (ctl.flag === 'caution') for (const c of ctl.lineOrder()) singleFile &&= ctl.slotFor(c)?.d === 0;
    }
    expect(flags).toEqual(['formation', 'grid', 'green', 'caution', 'restart', 'green']);
    expect(singleFile).toBe(true);
    expect(wrecked!.cleared).toBe(true); // lifted off by the marshals
    expect(race.state).toBe('finished');
    expect(race.standings().filter((s) => s.status === 'finished').length).toBe(5);
  });
});

describe('the caution order: lead-lap cars ahead of lapped cars', () => {
  it('a lead-lap car that pits under caution rejoins ahead of the lapped cars', async () => {
    const { presetTrack } = await import('../src/trackgen');
    const track = presetTrack('short');
    const L = track.length;
    const world = new World(track, { wearScale: 1 });
    // Five quick cars and the slowest house driver, who gets lapped.
    const teams = [0, 1, 2, 0, 1, 3].map((d) => neuralTeam(drivers[d]));
    teams.forEach((team, k) => world.addCar(new Car(k), team));
    const race = new Race(world, 60, new PaceCarDriver());
    const ctl = race.control!;
    const slow = world.cars[5];
    const byDist = () => world.cars.filter((c) => !c.retired).sort((a, b) => b.dist - a.dist);
    const down = (c: Car) => (byDist()[0].dist - c.dist) / L;
    while ((!race.started || down(slow) < 1.15) && world.time < 900) race.step();
    expect(down(slow)).toBeGreaterThan(1);
    ctl.debrisCaution();
    // A lead-lap car's crew calls it in at the first chance under caution.
    const pitter = byDist().find((c) => c !== slow && down(c) < 0.5 && c !== byDist()[0])!;
    let called = false;
    (teams[pitter.id] as unknown as { crewChief: unknown }).crewChief = {
      lastMessage: 'Box this lap',
      decide: () => (called || ctl.flag !== 'caution' ? null : ((called = true), { tires: true, fuel: 10, repair: false })),
    };
    let stopped = false;
    let rejoinedAhead: boolean | null = null;
    while (ctl.flag !== 'green' && world.time < 1500) {
      race.step();
      if (pitter.pit.phase === 'service') stopped = true;
      if (stopped && rejoinedAhead === null && pitter.pit.phase === 'none') {
        race.step();
        const line = ctl.lineOrder();
        rejoinedAhead = line.indexOf(pitter) >= 0 && line.indexOf(pitter) < line.indexOf(slow);
      }
    }
    expect(ctl.flag).toBe('green');
    expect(stopped).toBe(true);
    expect(rejoinedAhead).toBe(true);
    expect(ctl.lineOrder().indexOf(pitter)).toBeLessThan(ctl.lineOrder().indexOf(slow));
  });
});
