import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { Car } from '../src/sim/car';
import { Race } from '../src/sim/race';
import { ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { OVAL_RULES } from '../src/rules/rulebook';
import type { World as WorldT } from '../src/sim/world';
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
    // (Circuits start with the field in its grid boxes: no formation lap's end.)
    expect(flags).toEqual(['grid', 'green', 'caution', 'restart', 'green']);
    expect(singleFile).toBe(true);
    expect(wrecked!.cleared).toBe(true); // lifted off by the marshals
    expect(race.state).toBe('finished');
    expect(race.standings().filter((s) => s.status === 'finished').length).toBe(5);
  });
});

describe('the grid', () => {
  it('a road layout has its grid painted where race control lines the field up, and only once', async () => {
    const { Track } = await import('../src/sim/track');
    const { generateLayout, presetTrack } = await import('../src/trackgen');
    const { gridBox } = await import('../src/sim/grid');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const grid = track.layout.markings.filter((m) => m.grid);
    // A box for every car a race here takes: a line across its front and its two sides.
    expect(grid.filter((m) => m.kind === 'ticks')).toHaveLength(track.maxField);
    expect(grid).toHaveLength(3 * track.maxField);
    // Each box's front line just ahead of where its car stands, across it.
    grid.filter((m) => m.kind === 'ticks').forEach((m, k) => {
      const box = gridBox(track, k);
      if (m.kind !== 'ticks') return;
      expect(m.s[0] - track.signedS(box.s)).toBeGreaterThan(0);
      expect(m.s[0] - track.signedS(box.s)).toBeLessThan(3);
      expect((m.d0 + m.d1) / 2).toBeCloseTo(box.d, 6);
    });
    // Handed on (a worker, a venue's other layout): painted afresh, not twice.
    expect(new Track(track.layout).layout.markings.filter((m) => m.grid)).toHaveLength(grid.length);
    expect(presetTrack('short').layout.markings.some((m) => m.grid)).toBe(false); // ovals start rolling
  });

  it('a circuit race starts with the field in its boxes, held still until the lights go out', async () => {
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Track } = await import('../src/sim/track');
    const { generateLayout } = await import('../src/trackgen');
    const { gridBox } = await import('../src/sim/grid');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 4 });
    // Drivers with their foot down from the start: nobody leaves the grid before the lights go out all the same.
    const floored = { decide: (car: Car) => { car.inputX = 1; car.inputY = 0; } };
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), floored);
    const race = new Race(world, 3, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: 1 });
    const ctl = race.control!;
    const flags: string[] = [];
    let worst = 0;
    while (ctl.flag !== 'green' && world.time < 30) {
      race.step();
      if (flags[flags.length - 1] !== ctl.flag) flags.push(ctl.flag);
      if (ctl.flag !== 'grid') continue;
      world.cars.forEach((c, k) => {
        const box = gridBox(track, k);
        const [x, y] = track.toWorld(box.s, box.d);
        worst = Math.max(worst, Math.hypot(c.x - x, c.y - y));
      });
    }
    expect(flags).toEqual(['grid', 'green']);
    expect(worst).toBeLessThan(0.05); // each in its own box all the while
    expect(race.started).toBe(true);
    for (let k = 0; k < 120; k++) race.step();
    expect(world.cars.every((c) => c.speed > 2)).toBe(true); // and away they go
  });
});

describe('getting by the safety car', () => {
  /** A circuit race with scripted drivers, green, then a debris caution until the safety car has the field. */
  async function underTheSafetyCar() {
    const { ScriptedDriver, Team } = await import('../src/ai/drivers');
    const { TowerSpotter } = await import('../src/ai/spotter');
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Track } = await import('../src/sim/track');
    const { generateLayout } = await import('../src/trackgen');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 1 });
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), new Team(new ScriptedDriver(0, 0.8 + 0.01 * k), new TowerSpotter()));
    const race = new Race(world, 30, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: 2 });
    const ctl = race.control!;
    while ((!race.started || world.time < 60) && world.time < 200) race.step();
    ctl.debrisCaution(3);
    // The safety car has the field once it has picked up the leader and the line has closed up behind it.
    const closed = () => ctl.lineOrder().every((c) => Math.abs(ctl.slotGap(c) ?? Infinity) < 30);
    while (!(ctl.pickedUp && ctl.paceCarOut && closed()) && world.time < 600) race.step();
    expect(ctl.pickedUp).toBe(true);
    const said: string[] = [];
    const announce = world.announce.bind(world);
    world.announce = (car, kind, text, about) => { said.push(`#${car.number} ${text}`); announce(car, kind, text, about); };
    return { track, world, race, ctl, said };
  }

  /** Puts a car this far ahead of another, going its speed: moved along the track, race distance and all. */
  function holdAhead(track: import('../src/sim/track').Track, car: Car, of: Car, gap: number) {
    const s = track.wrapS(of.s + gap);
    const ds = track.distanceFrom(car.s, s);
    const advance = ds > track.length / 2 ? ds - track.length : ds;
    const [x, y] = track.toWorld(s, 0);
    const p = track.project(x, y);
    car.x = x; car.y = y; car.s = p.s; car.d = p.d; car.trackIdx = p.idx; car.dist += advance;
    car.vx = of.vx; car.vy = of.vy;
  }

  it('a car that gets by it is told to drop back, and does: no case', async () => {
    const { track, race, ctl, said } = await underTheSafetyCar();
    const passer = ctl.lineOrder()[0];
    holdAhead(track, passer, ctl.paceCar, -2);
    race.step();
    holdAhead(track, passer, ctl.paceCar, 20);
    race.step();
    expect(ctl.gotBy(passer)).toBe(true);
    expect(said.some((t) => t.startsWith(`#${passer.number} Race control`) && t.includes('drop back behind the safety car'))).toBe(true);
    // Its place is behind the safety car, not a lap ahead: it drops back to it.
    expect(ctl.slotGap(passer)!).toBeLessThan(0);
    for (let k = 0; k < 30 / 0.008333 && ctl.gotBy(passer); k++) race.step();
    expect(ctl.gotBy(passer)).toBe(false);
    for (let k = 0; k < 10 / 0.008333; k++) race.step();
    expect(race.stewards!.record.filter((r) => r.car === passer && r.offence === 'passing-under-caution')).toHaveLength(0);
  });

  it("still ahead of it a lap later: the stewards' case", async () => {
    const { track, world, race, ctl } = await underTheSafetyCar();
    const passer = ctl.lineOrder()[1];
    holdAhead(track, passer, ctl.paceCar, -2);
    race.step();
    const from = passer.dist;
    while (passer.dist < from + track.length + 50 && ctl.flag === 'caution' && world.time < 900) {
      holdAhead(track, passer, ctl.paceCar, 20);
      race.step();
    }
    for (let k = 0; k < 20 / 0.008333; k++) race.step(); // the stewards' review
    const ruled = race.stewards!.record.filter((r) => r.car === passer && r.offence === 'passing-under-caution');
    expect(ruled).toHaveLength(1);
    expect(ruled[0].detail).toContain('the safety car');
  });

  it("still ahead at the restart: the green is the leader's, and it jumped the restart", async () => {
    const { track, world, race, ctl, said } = await underTheSafetyCar();
    while (!ctl.oneToGo && world.time < 900) race.step();
    const head = ctl.lineOrder()[0];
    const passer = ctl.lineOrder()[1];
    holdAhead(track, passer, ctl.paceCar, -2);
    race.step();
    // Ahead of the safety car to the end of the caution, then ahead of the leader to the line.
    let passerCrossed = NaN;
    while (ctl.flag !== 'green' && world.time < 900) {
      holdAhead(track, passer, ctl.flag === 'restart' ? head : ctl.paceCar, 40);
      race.step();
      if (Number.isNaN(passerCrossed) && ctl.crossedLine(passer)) passerCrossed = world.time;
    }
    expect(ctl.flag).toBe('green');
    expect(passerCrossed).toBeLessThan(world.time); // it got to the line first
    expect(said.filter((t) => t.endsWith('Green flag!'))).toEqual([`#${head.number} Green flag!`]);
    for (let k = 0; k < 20 / 0.008333; k++) race.step();
    expect(race.stewards!.record.filter((r) => r.car === passer && r.offence === 'jumped-restart')).toHaveLength(1);
  });
});

describe('the caution order: lead-lap cars ahead of lapped cars', () => {
  it('a lead-lap car that pits under caution rejoins ahead of the lapped cars', async () => {
    const { presetTrack } = await import('../src/trackgen');
    const track = presetTrack('short');
    const L = track.length;
    // No collisions: the house drivers bump each other all race, and since bumps over 2 m/s cost health they wrecked
    // each other before anyone was lapped. The order is what's tested.
    const world = new World(track, { wearScale: 1, collisions: false });
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

describe('the end of a race', () => {
  /** A short circuit race with scripted drivers, run to just before the leader's last lap ends. */
  async function nearTheFlag(laps: number) {
    const { ScriptedDriver, Team } = await import('../src/ai/drivers');
    const { TowerSpotter } = await import('../src/ai/spotter');
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Track } = await import('../src/sim/track');
    const { generateLayout } = await import('../src/trackgen');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 1 });
    for (let k = 0; k < 6; k++) world.addCar(new Car(k), new Team(new ScriptedDriver(0, 0.8 + 0.01 * k), new TowerSpotter()));
    const race = new Race(world, laps, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: 1 });
    const lead = () => world.cars.reduce((a, b) => (b.dist > a.dist ? b : a));
    while ((!race.started || lead().lapsCompleted < laps - 1) && world.time < 900) race.step();
    return { track, world, race, ctl: race.control! };
  }

  it('a car that has taken the flag is out of the line under the safety car, and the race ends', async () => {
    const { world, race, ctl } = await nearTheFlag(3);
    ctl.debrisCaution(5); // out to the end
    let sawFinishedInLine = false;
    while (race.state !== 'finished' && world.time < 1500) {
      // (A car takes the flag after race control has lined the field up for the step: out of the line from the next.)
      const done = world.cars.filter((c) => c.finished);
      race.step();
      if (ctl.lineOrder().some((c) => done.includes(c))) sawFinishedInLine = true;
    }
    expect(world.cars.some((c) => c.finished)).toBe(true);
    expect(sawFinishedInLine).toBe(false);
    expect(race.state).toBe('finished');
  });

  it('a car stuck on pit road doesn\'t keep the race open: it is classified where it is', async () => {
    const { track, world, race } = await nearTheFlag(3);
    // One car stopped on its way into the pits for good (as pit drivers stuck in the lane were, for 2000 s), out of
    // everyone's way.
    const stuck = world.cars.reduce((a, b) => (b.dist < a.dist ? b : a));
    const d = track.innerEdge(stuck.trackIdx) + 40;
    const [x, y] = track.toWorld(stuck.s, d);
    const at = { x, y, s: stuck.s, d, idx: stuck.trackIdx };
    let flagAt = NaN;
    while (race.state !== 'finished' && world.time < 1500) {
      stuck.pit.phase = 'in';
      stuck.x = at.x; stuck.y = at.y; stuck.s = at.s; stuck.d = at.d; stuck.trackIdx = at.idx; stuck.vx = 0; stuck.vy = 0;
      race.step();
      if (race.state === 'checkered' && Number.isNaN(flagAt)) flagAt = world.time;
    }
    expect(race.state).toBe('finished');
    const lap = flagAt / 3;
    expect(world.time - flagAt).toBeLessThan(3 * lap + 1);
    const st = race.standings();
    expect(st.find((s) => s.car === stuck)!.status).toBe('pit');
    expect(st.filter((s) => s.status === 'finished')).toHaveLength(5);
  });
});

describe('a car stopped on pit road', () => {
  it('on its way to its box with nothing in front of it: pushed into the garage after a minute', async () => {
    const { ScriptedDriver, Team } = await import('../src/ai/drivers');
    const { TowerSpotter } = await import('../src/ai/spotter');
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Track } = await import('../src/sim/track');
    const { generateLayout } = await import('../src/trackgen');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 1 });
    for (let k = 0; k < 4; k++) world.addCar(new Car(k), new Team(new ScriptedDriver(0, 0.8), new TowerSpotter()));
    const race = new Race(world, 30, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: 1 });
    while (!race.started && world.time < 60) race.step();
    const car = world.cars[3];
    const s = track.pit.wallStart + 30;
    const d = track.pit.wallD + track.pitOffset(s) + 4;
    let stoppedFor = 0;
    while (!car.retired && world.time < 400) {
      car.pit.phase = 'in';
      car.placeOnTrack(track, s, d, car.dist);
      car.vx = 0; car.vy = 0;
      race.step();
      if (car.surface === 'pit') stoppedFor += 1 / 120;
    }
    expect(car.surface).toBe('pit');
    expect(car.retired && car.parked && car.cleared).toBe(true);
    expect(stoppedFor).toBeGreaterThan(59);
    expect(stoppedFor).toBeLessThan(62);
    expect(race.control!.flag).toBe('green'); // off the track: no safety car for it
  });
});

describe('rolling starts: the starter\'s green', () => {
  /** A short track race with the house drivers (the formation script drives their pacing: it holds pace speed). */
  function rolling(seed: number, early?: (car: Car) => boolean) {
    const track = ovalTrack(SHORT_TRACK);
    const world = new World(track, { wearScale: 4 });
    for (let k = 0; k < 8; k++) {
      const team = neuralTeam(drivers[k % drivers.length]);
      world.addCar(new Car(k), {
        decide(car: Car, w: WorldT) {
          team.decide(car, w);
          // Going early: on the gas the moment the pace car is off, to a quarter over pace speed (floored, it ran into
          // the pace car and out of the race before the stewards had ruled).
          if (early?.(car) && w.control!.flag === 'restart' && car.speed < 1.25 * w.control!.paceSpeed) car.inputX = 1;
        },
      });
    }
    const race = new Race(world, 30, new PaceCarDriver(), { rulebook: OVAL_RULES, seed });
    return { track, world, race, ctl: race.control! };
  }

  it('comes at a random moment after the pace car pulls off, before the leader reaches the line', () => {
    const shares: number[] = [];
    for (const seed of [1, 2, 3]) {
      const { track, world, race, ctl } = rolling(seed);
      let offAt = NaN, toLine = NaN;
      while (!race.started && world.time < 120) {
        race.step();
        if (ctl.flag === 'restart' && Number.isNaN(offAt)) { offAt = world.time; toLine = track.distanceFrom(ctl.lineOrder()[0].s, 0) / ctl.paceSpeed; }
      }
      expect(race.started).toBe(true);
      const leader = ctl.lineOrder()[0];
      // Before the line: lap 1 hasn't started for anyone yet.
      expect(world.cars.every((c) => c.lapStartTime < 0)).toBe(true);
      shares.push((world.time - offAt) / toLine);
      // Lap 1 starts at the line, for everyone.
      while (leader.lapStartTime < 0 && world.time < 200) race.step();
      expect(leader.lapsCompleted).toBe(0);
    }
    for (const s of shares) { expect(s).toBeGreaterThan(0.25); expect(s).toBeLessThan(0.95); }
    expect(new Set(shares.map((s) => s.toFixed(2))).size).toBe(3);
  });

  it('a field that holds pace speed to the green: no case; a leader going as the pace car pulls off: a drive-through', () => {
    for (const goes of [false, true]) {
      const { world, race } = rolling(1, goes ? (car) => car.id === 0 : undefined);
      while (world.time < 120) race.step();
      const early = race.stewards!.record.filter((r) => r.offence === 'jumped-restart');
      if (!goes) expect(early).toHaveLength(0);
      else {
        expect(early.map((r) => r.car.id)).toEqual([0]);
        expect(early[0].penalty).toBe('drive-through');
        expect(early[0].detail).toContain('over pace speed');
      }
    }
  });

  it('a car behind the front row going early is held up by the car ahead: no call for its speed', () => {
    const { world, race, ctl } = rolling(1, (car) => car.id === 5);
    while (world.time < 120) race.step();
    expect(ctl.flag).toBe('green');
    expect(race.stewards!.record.filter((r) => r.offence === 'jumped-restart')).toHaveLength(0);
  });

  it('front rows not lined up as the pace car is due off: one more lap, once', () => {
    const { track, world, race, ctl } = rolling(1);
    const said: string[] = [];
    const announce = world.announce.bind(world);
    world.announce = (car, kind, text, about) => { if (kind === 'flag') said.push(text); announce(car, kind, text, about); };
    // The second row's inside car a row and a half back, and kept there: never lined up.
    const third = world.cars[2];
    const back = (by: number) => {
      const v = third.speed;
      third.placeOnTrack(track, track.wrapS(third.s - by), third.d, third.dist - by);
      third.vx = track.tx[third.trackIdx] * v; third.vy = track.ty[third.trackIdx] * v;
    };
    back(15);
    while (!race.started && world.time < 300) {
      race.step();
      const gap = ctl.slotGap(third);
      if (ctl.flag === 'pace' && gap !== null && gap < 15) back(15 - gap);
    }
    expect(said.filter((t) => t === 'Not lined up: one more lap')).toHaveLength(1);
    expect(race.started).toBe(true);
    expect(world.time).toBeGreaterThan(track.length / ctl.paceSpeed); // a lap later than the line-up would have taken
  });
});
