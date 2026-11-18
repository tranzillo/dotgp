import { beforeAll, describe, expect, it } from 'vitest';
import { applyExperiment, EXPERIMENT } from '../src/sim/experiment';
import { lineAt, ovalLines } from '../src/ai/racingLine';
import { racerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';

/** How close a line comes to the outside wall's face (m, from the car's side). */
function closestToWall(track: ReturnType<typeof ovalTrack>, line: ReturnType<typeof ovalLines>['high']): number {
  const outer = track.walls.find((w) => w.faces === 'in' && w.range === null)!;
  let min = Infinity;
  for (let s = 0; s < track.length; s += 2) {
    min = Math.min(min, lineAt(line, s).d - 1 - (track.edgeAt(outer.d as never, s) + outer.thickness / 2));
  }
  return min;
}

describe('ovals banked for two lines (?lines=2)', () => {
  // Balanced for the Cup car, the ovals' car (the classic car, no downforce, laps them 4% apart on the speedway).
  beforeAll(() => applyExperiment('?spec=cup'));
  it('lap the low and high lines alike, the high one off the wall; banked as given otherwise', () => {
    for (const p of [SPEEDWAY, SHORT_TRACK]) {
      const track = ovalTrack({ ...p, balanceLines: true });
      const { low, high } = ovalLines(track);
      expect(Math.abs(high.lapTime / low.lapTime - 1), p.name).toBeLessThan(0.005);
      expect(closestToWall(track, high), p.name).toBeGreaterThan(1.4);
      // Each corner's mean banking as designed.
      const progression = (track.layout.params.bankProgression as number[])[0];
      expect(progression).not.toBe(Math.round(((p.bankOuter - p.bankInner) * 1800) / Math.PI) / 10);
    }
    const plain = ovalTrack(SPEEDWAY);
    expect(plain.layout.params.bankProgression).toBeUndefined();
  });

  it('a teacher taking over a car on its other line, not passing, holds the line the car is on', () => {
    EXPERIMENT.lines = 2;
    try {
      const track = ovalTrack({ ...SHORT_TRACK, balanceLines: true });
      const style = racerStyle(0.5, 0.5, () => 0.5).style;
      const { low, high } = ovalLines(track, style.margin);
      const world = new World(track, { collisions: false, drafting: false });
      const car = new Car(0);
      car.placeOnTrack(track, 0, lineAt(low, 0).d);
      const teacher = new TrafficRacer(style);
      world.addCar(car, teacher);
      for (let k = 0; k < 2 / P.DT; k++) world.step();
      const home = () => (teacher as unknown as { home: string }).home;
      expect(home()).toBe('low');
      // A student at the wheel has put it on the high line.
      car.placeOnTrack(track, car.s, lineAt(high, car.s).d);
      teacher.takeOver(car, world);
      expect(teacher.intent).toBe(0);
      expect(home()).toBe('high');
    } finally {
      EXPERIMENT.lines = 0;
    }
  });
});
