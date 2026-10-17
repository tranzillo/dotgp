import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec, type SessionSnapshot, type SessionSpec } from '../src/events/session';
import { CAR_BYTES, CHUNK_FRAMES, Tape, TAPE_HZ } from '../src/events/tape';
import { PHYSICS as P } from '../src/sim/constants';
import { presetLayout } from '../src/trackgen';

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

const spec = (kind: SessionSpec['kind'], laps = 10, field = 8): SessionSpec => ({
  kind, layout: presetLayout('short'), entrants: entrants(field), laps, pace: 4, seed: 5,
});

/** Run until just after a tape frame was recorded, so the live snapshot and the last frame are the same moment. */
function runToFrame(s: Session, seconds: number): void {
  s.advance(seconds);
  while (s.world.tick % Math.round(1 / (TAPE_HZ * P.DT)) !== 0) s.step();
}

function expectSame(tape: SessionSnapshot, live: SessionSnapshot): void {
  expect(tape.time).toBe(live.time);
  expect(tape.order).toEqual(live.order);
  expect(tape.race).toEqual(live.race);
  expect(tape.standings?.map((st) => [st.id, st.position, st.laps, st.status]))
    .toEqual(live.standings?.map((st) => [st.id, st.position, st.laps, st.status]));
  for (const car of live.cars) {
    const t = tape.cars.find((c) => c.id === car.id)!;
    // Positions, distance and times: float precision.
    for (const k of ['x', 'y', 's', 'd', 'dist', 'speed'] as const) expect(t[k]).toBeCloseTo(car[k], 2);
    expect(t.bestLap === null ? null : t.bestLap).toBeCloseTo(car.bestLap ?? NaN, 2);
    // The rest: scaled small integers, close enough not to see.
    expect(Math.atan2(t.frameY, t.frameX)).toBeCloseTo(Math.atan2(car.frameY, car.frameX), 3);
    expect(Math.abs(t.inputX - car.inputX)).toBeLessThan(0.01);
    expect(Math.abs(t.tireLon - car.tireLon)).toBeLessThan(0.01);
    expect(Math.abs(t.fuel - car.fuel)).toBeLessThan(0.001);
    expect(Math.abs(t.tireLife - car.tireLife)).toBeLessThan(0.005);
    expect(Math.abs(t.health - car.health)).toBeLessThan(0.005);
    expect([t.key, t.color, t.laps, t.surface, t.pitPhase, t.stops, t.penalty, t.timePenalty]).toEqual(
      [car.key, car.color, car.laps, car.surface, car.pitPhase, car.stops, car.penalty, car.timePenalty]);
    expect([t.retired, t.cleared, t.towed, t.parked, t.finished, t.disqualified]).toEqual(
      [car.retired, car.cleared, car.towed, car.parked, car.finished, car.disqualified]);
  }
}

describe('tape', () => {
  it('records a frame every tenth of a second that reads back as the live snapshot', () => {
    const s = new Session(spec('race', 10));
    runToFrame(s, 120);
    expect(s.tape.length).toBe(Math.round(s.time * TAPE_HZ));
    expectSame(s.tape.frame(s.tape.end - 1, s.track), s.snapshot(false));
    // Under way and later: pit stops, cautions, retirements all come back the same.
    runToFrame(s, 300);
    expectSame(s.tape.frame(s.tape.end - 1, s.track), s.snapshot(false));
    // Seeking by time.
    const i = s.tape.indexAt(42.05);
    expect(s.tape.timeAt(i)).toBeLessThanOrEqual(42.05);
    expect(s.tape.timeAt(i + 1)).toBeGreaterThan(42.05);
  });

  it('a copy built from what the worker sends, bit by bit, is the same tape', () => {
    const s = new Session(spec('race', 5));
    const copy = new Tape(s.tape.header);
    let sent = 0;
    for (let k = 0; k < 40; k++) {
      s.advance(1 + (k % 7));
      const seg = s.tape.segment(sent);
      copy.append(seg.first, seg.count, seg.bytes);
      sent = s.tape.end;
    }
    expect(copy.end).toBe(s.tape.end);
    for (const i of [0, 1, CHUNK_FRAMES - 1, CHUNK_FRAMES, s.tape.end - 1]) expect(copy.frame(i)).toEqual(s.tape.frame(i));
    // A page that attaches late gets the backlog in one go.
    const late = Tape.from(s.tape.segment());
    expect(late.frame(s.tape.end - 1)).toEqual(s.tape.frame(s.tape.end - 1));
  });

  it('open sessions keep only their latest frames, in whole chunks', () => {
    const s = new Session(spec('practice'));
    const tape = new Tape(s.tape.header, 2 * CHUNK_FRAMES);
    for (let k = 0; k < 7 * CHUNK_FRAMES; k++) {
      s.step();
      tape.record({ ...s.snapshot(false), time: k / TAPE_HZ });
    }
    expect(tape.end).toBe(7 * CHUNK_FRAMES);
    expect(tape.length).toBeLessThanOrEqual(3 * CHUNK_FRAMES);
    expect(tape.length).toBeGreaterThanOrEqual(2 * CHUNK_FRAMES);
    expect(tape.first % CHUNK_FRAMES).toBe(0);
    expect(tape.timeAt(tape.first)).toBeCloseTo(tape.first / TAPE_HZ, 6);
    expect(tape.timeAt(tape.end - 1)).toBeCloseTo((tape.end - 1) / TAPE_HZ, 6);
    expect(tape.indexAt(0)).toBe(tape.first);
  });

  it('is small: bytes per car per sim second, raw and gzipped', () => {
    const s = new Session(spec('race', 15, 12));
    for (let k = 0; k < 600 / P.DT && !s.finished; k++) s.step();
    const seg = s.tape.segment();
    const perCarSecond = seg.bytes.byteLength / 12 / s.time;
    const gz = gzipSync(new Uint8Array(seg.bytes)).byteLength / 12 / s.time;
    console.log(`tape: ${(seg.bytes.byteLength / 1e6).toFixed(2)} MB for ${s.time.toFixed(0)} s x 12 cars: `
      + `${perCarSecond.toFixed(0)} B/car/s raw, ${gz.toFixed(0)} gzipped (${CAR_BYTES} B/car/frame)`);
    expect(perCarSecond).toBeLessThan(CAR_BYTES * TAPE_HZ * 1.1);
  });
});

describe('driving school tapes', () => {
  it('tapes each round (students only) and keeps the ones watched', async () => {
    const { Classroom } = await import('../src/school/classroom');
    const { initialWeights } = await import('../src/ai/es');
    const { Rng } = await import('../src/ai/rng');
    const { PRESETS } = await import('../src/trackgen');
    const student = (k: number) => ({ key: 10000 + k, id: `D${k}`, name: `S${k}`, weights: initialWeights(new Rng(k + 1)), rounds: 0, licensed: true });
    const c = new Classroom({ lesson: 'variety', students: [student(0), student(1)], presets: Object.keys(PRESETS).map(presetLayout), seed: 4 });
    c.startTaping();
    expect(c.tape!.header.cars.map((car) => car.key)).toEqual([10000, 10001]); // not the variations
    c.collectStrokes = true; // round 0 on screen
    const first = c.tape!;
    while (c.round < 1) c.step();
    const roundLength = c.time; // round 0 ran from 0
    expect(c.tape).not.toBe(first);
    expect(c.tape!.header.id).toBe(2);
    c.collectStrokes = false; // round 1 in the background, and no license to earn in this lesson
    while (c.round < 2) c.step();
    const kept = c.takeTapes();
    expect(kept.map((t) => [t.round, t.watched])).toEqual([[0, true]]);
    const tape = Tape.from(kept[0].tape);
    expect(Math.abs(tape.length - roundLength * TAPE_HZ)).toBeLessThanOrEqual(1);
    expect(tape.frame(tape.end - 1).cars.map((car) => car.key)).toEqual([10000, 10001]);
  });
});

describe('stored tapes', () => {
  it('pack small and read back within a centimetre and a millisecond', async () => {
    const { packTape, unpackTape } = await import('../src/events/tapeCodec');
    const s = new Session(spec('race', 15, 12));
    for (let k = 0; k < 600 / P.DT && !s.finished; k++) s.step();
    const seg = s.tape.segment();
    const packed = await packTape(seg);
    const perCarSecond = packed.byteLength / 12 / s.time;
    console.log(`stored tape: ${(packed.byteLength / 1e6).toFixed(2)} MB for ${s.time.toFixed(0)} s x 12 cars: ${perCarSecond.toFixed(0)} B/car/s `
      + `(${(seg.bytes.byteLength / packed.byteLength).toFixed(1)}x smaller than in memory)`);
    const back = Tape.from(await unpackTape(packed));
    expect(back.first).toBe(s.tape.first);
    expect(back.end).toBe(s.tape.end);
    expect(back.header).toEqual(s.tape.header);
    for (const i of [0, 777, s.tape.end - 1]) {
      const a = s.tape.frame(i, s.track), b = back.frame(i, s.track);
      expect(b.time).toBeCloseTo(a.time, 3);
      expect(b.order).toEqual(a.order);
      expect(b.race).toEqual({ ...a.race!, paceCar: b.race!.paceCar, wreckers: b.race!.wreckers });
      for (const car of a.cars) {
        const c = b.cars.find((x) => x.id === car.id)!;
        for (const k of ['x', 'y', 's', 'd', 'dist'] as const) expect(Math.abs(c[k] - car[k])).toBeLessThan(0.006);
        expect(Math.abs(c.speed - car.speed)).toBeLessThan(0.051);
        expect(Math.atan2(c.frameY, c.frameX)).toBeCloseTo(Math.atan2(car.frameY, car.frameX), 2);
        expect(c.bestLap === null).toBe(car.bestLap === null);
        if (car.bestLap !== null) expect(Math.abs(c.bestLap! - car.bestLap)).toBeLessThan(0.001);
        expect(Math.abs(c.fuel - car.fuel)).toBeLessThan(0.006);
        expect([c.laps, c.pitPhase, c.stops, c.health, c.tireLife, c.retired, c.penalty])
          .toEqual([car.laps, car.pitPhase, car.stops, car.health, car.tireLife, car.retired, car.penalty]);
      }
    }
    expect(perCarSecond).toBeLessThan(200);
  });
});

describe('saved replays', () => {
  it('past the cap the oldest go first, pinned ones stay', async () => {
    const { MemoryReplayStore, enforceCap } = await import('../src/records/replayStore');
    const store = new MemoryReplayStore();
    const meta = (k: number, pinned = false) => ({
      id: `r${k}`, saved: 1000 + k, label: `Race ${k}`, event: { id: `r${k}`, type: 'race' as const, label: `Race ${k}` }, kind: 'race' as const,
      track: 'Speedway', layout: presetLayout('speedway'), teams: [], timeline: [], duration: 600, bytes: 100, pinned,
    });
    for (let k = 0; k < 6; k++) await store.save(meta(k, k === 0), new Uint8Array(100));
    const gone = await enforceCap(store, 350);
    expect(gone.map((m) => m.id)).toEqual(['r1', 'r2', 'r3']); // r0 is pinned
    expect((await store.list()).map((m) => m.id)).toEqual(['r5', 'r4', 'r0']);
    expect(await store.tape('r1')).toBeNull();
  });
});
