import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { PERFECT_SPOTTER } from '../src/ai/spotter';
import { Session, type EntrantSpec, type SessionSpec } from '../src/events/session';
import { PHYSICS as P } from '../src/sim/constants';
import { presetLayout } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;

function entrants(n: number): EntrantSpec[] {
  return Array.from({ length: n }, (_, k) => ({
    key: 100 + k,
    fill: '#ffffff',
    number: 200 + k,
    driver: { id: `D${k}`, weights: adaptWeights(Float32Array.from(bundled[k % bundled.length].weights)) },
    spotter: { id: `S${k}`, skill: PERFECT_SPOTTER },
    chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
  }));
}

const spec = (laps: number, field: number, seed = 3): SessionSpec => ({
  kind: 'race', layout: presetLayout('short'), entrants: entrants(field), laps, pace: 4, seed,
});

describe('race timeline', () => {
  it('logs the start, flags in order, lead changes and the finish, placed along the race distance', () => {
    const s = new Session(spec(12, 12));
    for (let k = 0; k < 1500 / P.DT && !s.finished; k++) s.step();
    expect(s.finished).toBe(true);
    const tl = s.timeline;
    const kinds = tl.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'start')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'checkered')).toHaveLength(1);
    // Nothing from race control before the start; the checkered flag after it.
    const flags = tl.filter((e) => ['start', 'caution', 'restart', 'green', 'checkered'].includes(e.kind));
    expect(flags[0].kind).toBe('start');
    expect(flags[flags.length - 1].kind).toBe('checkered');
    // Every caution ends: a green flag (or the checkered) follows it before the next caution.
    let out = false;
    for (const f of flags) {
      if (f.kind === 'caution') { expect(out).toBe(false); out = true; }
      if (f.kind === 'green' || f.kind === 'checkered') out = false;
    }
    // In time order, on the race distance, never going backwards once green.
    for (let i = 1; i < tl.length; i++) expect(tl[i].time).toBeGreaterThanOrEqual(tl[i - 1].time);
    const placed = tl.filter((e) => e.time >= flags[0].time);
    for (const e of placed) {
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThanOrEqual(1);
      expect(e.lap).toBeGreaterThanOrEqual(1);
      expect(e.lap).toBeLessThanOrEqual(12);
    }
    for (let i = 1; i < placed.length; i++) expect(placed[i].at!).toBeGreaterThanOrEqual(placed[i - 1].at! - 1e-9);
    expect(tl.find((e) => e.kind === 'checkered')!.at).toBe(1);
    // Race control and the stewards call cars by the numbers on them, not the sim's ids.
    const called = tl.flatMap((e) => [...e.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
    expect(called.length).toBeGreaterThan(0);
    for (const n of called) expect(n).toBeGreaterThanOrEqual(200);
    // The hardest hits: when they came (history links to the moment), seen on tape as the health it cost.
    const hit = s.results().filter((r) => r.worstHit > 0.05).sort((a, b) => b.worstHit - a.worstHit)[0];
    expect(hit).toBeDefined();
    const car = s.world.cars.find((c) => c.number === 200 + (hit.key - 100))!; // entrant k: key 100 + k, number 200 + k
    const healthAt = (t: number) => s.tape.frame(s.tape.indexAt(t)).cars.find((c) => c.id === car.id)!.health;
    // (Health stops at zero: a hit bigger than what the car had left costs only that.)
    const before = healthAt(hit.worstHitTime! - 0.2);
    expect(before - healthAt(hit.worstHitTime! + 0.2)).toBeGreaterThan(Math.min(hit.worstHit, before) * 0.9);
    // Pit stops are logged against their team.
    const pit = tl.find((e) => e.kind === 'pit-in');
    if (pit) expect(pit.key).toBeGreaterThanOrEqual(100);
    // A decision on an incident points back at it: the review of that car, logged at that moment.
    for (const d of tl.filter((e) => e.incidentTime !== undefined)) {
      expect(tl.some((e) => e.kind === 'review' && e.key === d.key && e.time === d.incidentTime)).toBe(true);
    }
    // The other car in an incident is another team, never the car itself.
    for (const e of tl) for (const k of e.others ?? []) { expect(k).toBeGreaterThanOrEqual(100); expect(k).not.toBe(e.key); }
  });

  it("names the other cars in an incident, and a decision's incident time", () => {
    const s = new Session(spec(5, 4));
    s.advance(1);
    const [a, b] = s.world.cars;
    const keyOf = (number: number) => 100 + (number - 200); // entrant k: key 100 + k, number 200 + k
    s.world.announce(a, 'review', 'test review', { others: [b, null, a] });
    const at = s.world.time;
    s.step();
    s.world.announce(a, 'steward', 'test decision', { others: [b], incidentTime: at });
    s.step();
    const review = s.timeline.find((e) => e.text === 'test review')!;
    const decision = s.timeline.find((e) => e.text === 'test decision')!;
    expect(review.key).toBe(keyOf(a.number));
    expect(review.others).toEqual([keyOf(b.number)]);
    expect(review.incidentTime).toBeUndefined();
    expect(decision.others).toEqual([keyOf(b.number)]);
    expect(decision.incidentTime).toBe(review.time);
  });

  it('keeps reading announcements after the world has dropped old ones', () => {
    const s = new Session(spec(5, 4));
    s.advance(1);
    const car = s.world.cars[0];
    const before = s.timeline.length;
    for (let k = 0; k < 700; k++) {
      s.world.announce(car, 'crew', `call ${k}`);
      if (k % 50 === 0) s.step();
    }
    s.step();
    expect(s.world.eventsDropped).toBeGreaterThan(0);
    const calls = s.timeline.slice(before).filter((e) => e.text.startsWith('call '));
    expect(calls).toHaveLength(700);
    expect(calls[699].text).toBe('call 699');
    expect(s.takeRadio().some((l) => l.text === 'Crew: call 699')).toBe(true);
  });
});
