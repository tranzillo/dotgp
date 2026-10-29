import { describe, expect, it } from 'vitest';
import { computeDraft } from '../src/sim/collisions';
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';
import type { Track } from '../src/sim/track';
import { draftHeads, draftLinks, draftWorth, DraftWall, STREAK_FIELDS, type DraftCar } from '../src/render/draft';

const L = 1000;
const track = { wrapS: (s: number) => ((s % L) + L) % L };
const car = (id: number, s: number, d = 0, speed = 80): DraftCar & { draftFactor: number } =>
  ({ id, x: 0, y: 0, s, d, speed, retired: false, cleared: false, draftFactor: 1 });

/** All the streaks for these links, as objects. */
function streaksOf(wall: DraftWall, links: ReturnType<typeof draftLinks>) {
  const buf: number[] = [];
  const n = wall.streaks(links, track, 0.5, buf);
  return Array.from({ length: n }, (_, i) => {
    const [front, back, d, offset, alpha] = buf.slice(i * STREAK_FIELDS, (i + 1) * STREAK_FIELDS);
    return { front, back, d, offset, alpha };
  });
}

describe('the draft, drawn', () => {
  it('links each car to the car whose draft the sim gives it', () => {
    // A train of three, a car off to the side, and one too far back.
    const cars = [car(0, 100), car(1, 92, 0.4), car(2, 80, 0.2), car(3, 95, 3.5), car(4, 20)];
    computeDraft(cars as unknown as Car[], track as unknown as Track);
    const links = draftLinks(cars, track);
    expect(links.map((l) => [l.follower.id, l.leader.id])).toEqual([[1, 0], [2, 1]]);
    for (const l of links) {
      // The follower's drag is down by exactly the link's strength (it pushes no one, or less than that).
      expect(l.follower.draftFactor).toBeCloseTo(Math.min(1 - P.DRAFT_MAX * l.strength,
        ...links.filter((m) => m.leader === l.follower).map((m) => 1 - P.DRAFT_PUSH * m.strength)), 12);
    }
    expect(cars[3].draftFactor).toBe(1);
    expect(cars[4].draftFactor).toBe(1);
  });

  it('is worth nothing at pacing speed and everything flat out', () => {
    expect(draftWorth(44)).toBe(0);
    expect(draftWorth(80)).toBe(1);
    expect(draftWorth(66)).toBeGreaterThan(0.3);
    const slow = draftLinks([car(0, 100, 0, 44), car(1, 95, 0, 44)], track);
    expect(slow[0].strength).toBeGreaterThan(0.8);
    expect(slow[0].effect).toBe(0);
    expect(streaksOf(new DraftWall(), slow)).toHaveLength(0);
  });

  it('shows more air, brighter, the tighter the draft', () => {
    const wall = new DraftWall();
    const close = draftLinks([car(0, 100), car(1, 94)], track);
    const far = draftLinks([car(0, 100), car(1, 70)], track);
    const sum = (links: typeof close) => streaksOf(wall, links).reduce((a, s) => a + s.alpha, 0);
    // Per metre of wall, so the longer far link doesn't win on length.
    expect(sum(close) / (6 + 16)).toBeGreaterThan(2 * (sum(far) / (30 + 16)));
  });

  it('runs down both flanks, from the leader back past the last car, and flows back', () => {
    const wall = new DraftWall();
    const links = draftLinks([car(0, 100), car(1, 94), car(2, 88)], track);
    const before = streaksOf(wall, links);
    expect(before.some((s) => s.offset > 0) && before.some((s) => s.offset < 0)).toBe(true);
    for (const s of before) {
      expect(Math.abs(s.offset)).toBeGreaterThan(1);
      expect(s.front).toBeLessThanOrEqual(100);
      expect(s.back).toBeLessThan(s.front);
    }
    // The tail: behind the last car, not behind the middle one.
    expect(Math.min(...before.map((s) => s.front))).toBeLessThan(88 - 8);
    expect(draftHeads(links).map((h) => h.car.id)).toEqual([0]);
    // A moment later the same streaks have moved back.
    wall.advance(links, 0.01);
    const after = streaksOf(wall, links);
    const lead = (xs: typeof before) => Math.max(...xs.filter((s) => s.offset > 0 && s.offset < 2).map((s) => s.front));
    expect(lead(after)).not.toBe(lead(before));
  });

  it('leaves the air where it was when the leader moves up the track', () => {
    const wall = new DraftWall();
    const leader = car(0, 100, 0), follower = car(1, 92, 0);
    const links = draftLinks([leader, follower], track);
    // Running in line long enough for the wake to cover the whole wall.
    for (let k = 0; k < 120; k++) wall.advance(links, 1 / 60);
    // The leader moves 1.5 m up the track (the link holds: same objects).
    leader.d = 1.5;
    // Five frames: its new line has flowed ~3 m back.
    for (let k = 0; k < 5; k++) wall.advance(links, 1 / 60);
    const streaks = streaksOf(wall, links);
    const near = streaks.filter((s) => s.front > 98.5), far = streaks.filter((s) => s.front < 95);
    expect(near.length && far.length).toBeTruthy();
    // Air just off the leader's nose is on its new line; air further back stays on the old one.
    for (const s of near) expect(s.d).toBe(1.5);
    for (const s of far) expect(s.d).toBe(0);
  });
});
