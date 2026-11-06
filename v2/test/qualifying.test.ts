import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec, type SessionSpec } from '../src/events/session';
import { PHYSICS as P } from '../src/sim/constants';
import type { QualifyingView } from '../src/sim/qualifying';
import { TAPE_STEPS } from '../src/events/tape';
import { generateTrack, presetLayout } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;

function entrants(n: number): EntrantSpec[] {
  return Array.from({ length: n }, (_, k) => ({
    key: 100 + k,
    fill: '#ffffff',
    driver: { id: `D${k}`, weights: adaptWeights(Float32Array.from(bundled[k % bundled.length].weights)) },
    spotter: { id: `S${k}`, skill: PERFECT_SPOTTER },
    chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
  }));
}

const spec = (kind: SessionSpec['kind'], extra: Partial<SessionSpec> = {}): SessionSpec => ({
  kind, layout: presetLayout('short'), entrants: entrants(4), laps: 3, pace: 4, seed: 7, ...extra,
});

describe('solo qualifying', () => {
  it('sends cars out one at a time from their boxes, the next as the last starts its in-lap, and classifies them by best lap', () => {
    const s = new Session(spec('qualifying', { qualifying: { format: 'solo', laps: 2 } }));
    // Everyone starts in their box (behind the pit wall), stopped.
    const inPits = (car: (typeof s.world.cars)[number]) => car.d > s.track.pit.wallD;
    for (const car of s.world.cars) {
      expect(car.waiting).toBe(true);
      expect(inPits(car)).toBe(true);
    }
    const order: number[] = [];
    let maxOut = 0, maxTiming = 0;
    for (let k = 0; k < 900 / P.DT && !s.finished; k++) {
      s.step();
      maxOut = Math.max(maxOut, s.world.cars.filter((c) => !c.waiting).length);
      const timing = s.snapshot().standings!.filter((st) => st.status === 'running');
      maxTiming = Math.max(maxTiming, timing.length);
      if (timing.length && order[order.length - 1] !== timing[0].id) order.push(timing[0].id);
    }
    expect(s.finished).toBe(true);
    expect(maxTiming).toBe(1); // one car on its timed laps at a time
    expect(maxOut).toBe(2); // ... and the one before on its in-lap
    // In the draw (grid) order, each car once.
    expect(order).toEqual(s.world.cars.map((c) => c.id));

    const results = s.results();
    expect(results.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    const timed = results.filter((r) => r.bestLap !== null);
    expect(timed.length).toBeGreaterThanOrEqual(3);
    for (const r of timed) {
      expect(r.laps).toBe(2); // the two timed laps, not the out-lap or the in-lap
      expect(r.time).toBe(r.bestLap);
    }
    const times = timed.map((r) => r.bestLap!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Everyone ends up back in their box.
    for (const car of s.world.cars) if (!car.retired) expect(inPits(car)).toBe(true);
    expect(s.snapshot().qualifying).toMatchObject({ format: 'solo', phase: 'finished', progress: 1 });
  });

  it('goes on tape with its standings and where it is', () => {
    const s = new Session(spec('qualifying', { qualifying: { format: 'solo', laps: 1 } }));
    let mid: QualifyingView | undefined;
    for (let k = 0; k < 600 / P.DT && !s.finished; k++) {
      s.step();
      // A frame goes on tape on this step: it's the session as it is now.
      if (s.time > 100 && !mid && s.world.tick % TAPE_STEPS === 0) {
        mid = s.snapshot().qualifying;
        const taped = s.tape.frame(s.tape.end - 1).qualifying!;
        expect({ ...taped, progress: 0, clock: 0 }).toEqual({ ...mid, progress: 0, clock: 0 });
        expect(taped.progress).toBeCloseTo(mid!.progress, 4);
        expect(mid!.progress).toBeGreaterThan(0);
      }
    }
    expect(mid).toBeDefined();
    const live = s.snapshot().standings!;
    const taped = s.tape.frame(s.tape.end - 1).standings!;
    expect(taped.map((st) => [st.id, st.status])).toEqual(live.map((st) => [st.id, st.status]));
    taped.forEach((st, i) => {
      if (Number.isNaN(live[i].time)) expect(st.time).toBeNaN();
      else expect(st.time).toBeCloseTo(live[i].time, 3);
    });
  });

  it("doesn't time the out-lap: a one-lap run is a flying lap", () => {
    for (let k = 0; k < 2; k++) {
      const solo = spec('qualifying', { entrants: [entrants(4)[k]], qualifying: { format: 'solo', laps: 1 } });
      const s = new Session(solo);
      for (let t = 0; t < 300 / P.DT && !s.finished; t++) s.step();
      // The same driver's flying laps, released at speed with nobody else around.
      const ghost = new Session({ ...solo, kind: 'ghost' });
      ghost.advance(120);
      const flying = Math.min(...ghost.world.cars[0].lapTimes.slice(1));
      expect(s.results()[0].bestLap).toBeLessThan(flying * 1.02);
    }
  });

  it('runs to the track\'s rulebook by default: a lap each on ovals', () => {
    const s = new Session(spec('qualifying'));
    expect(s.qualifying!.format).toEqual({ format: 'solo', laps: 1 });
  });
});

describe('group qualifying', () => {
  it('knocks out the field over the number of rounds each round, and classifies by the round each went out in', () => {
    const s = new Session(spec('qualifying', { entrants: entrants(6), qualifying: { format: 'group', rounds: 3, roundSeconds: 80 } }));
    const rounds: Array<Set<number>> = [];
    const cuts: number[] = [];
    let together = 0;
    for (let k = 0; k < 1200 / P.DT && !s.finished; k++) {
      s.step();
      const q = s.snapshot().qualifying!;
      const out = s.world.cars.filter((c) => !c.waiting);
      together = Math.max(together, out.length);
      for (const c of out) (rounds[q.round] ??= new Set()).add(c.id);
      cuts[q.round] = q.cut;
    }
    expect(s.finished).toBe(true);
    expect(together).toBeGreaterThan(2); // on track together
    // 6 cars, 3 rounds: two go out after each round; the last round decides the front two.
    expect(cuts).toEqual([4, 2, 0]);
    expect(rounds.map((r) => r.size)).toEqual([6, 4, 2]);

    const results = s.results();
    expect(results.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6]);
    const keyOf = (id: number) => s.snapshot().cars.find((c) => c.id === id)!.key;
    const ranThird = [...rounds[2]].map(keyOf), ranSecond = [...rounds[1]].map(keyOf);
    // Front two: the last round's; then the second round's knockouts; then the first's.
    expect(new Set(results.slice(0, 2).map((r) => r.key))).toEqual(new Set(ranThird));
    expect(new Set(results.slice(0, 4).map((r) => r.key))).toEqual(new Set(ranSecond));
    // Within each group, by the time set in that round.
    for (const [a, b] of [[0, 2], [2, 4], [4, 6]]) {
      const times = results.slice(a, b).map((r) => r.time).filter((t) => !Number.isNaN(t));
      expect(times).toEqual([...times].sort((x, y) => x - y));
    }
    // Every car back in its box at the end.
    for (const car of s.world.cars) expect(car.waiting).toBe(true);
  });

  it('is how circuits qualify by default', () => {
    const s = new Session(spec('qualifying', { layout: generateTrack({ type: 'circuit', seed: 11 }).layout }));
    expect(s.qualifying!.format.format).toBe('group');
  });
});
