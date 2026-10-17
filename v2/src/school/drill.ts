import { FULL_DAMAGE_PENALTY } from '../ai/es';
import { Trial } from '../ai/evaluate';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';

/** One candidate's drill: its own small world, the candidate driving one car in it. */
export interface Drill<R> {
  readonly world: World;
  readonly student: Car;
  readonly done: boolean;
  step(): void;
  result(): R;
}

/**
 * Holding students to how they drove before a lesson. A drill measures one
 * thing (a pack, a caution, a stop), and a variation is free to change
 * everything else, so round after round racing drifted: drivers lost their
 * way round the track, or got slower, while the drill score looked fine
 * (after the caution lesson some couldn't finish a lap). So every candidate
 * also drives solo laps, ghosts as in practice, next to the student as it
 * drove when the class began, and is charged for pace and cleanliness lost
 * against that, each on its own (as one score, a slower variation that
 * avoided a scrape looked no worse; against the current self, small losses
 * slipped through every round). Going faster earns nothing here: the
 * lesson's own score decides.
 */
export interface SoloAnchor {
  track: Track;
  /** Each student as it drove when the class began. */
  references: Float32Array[];
}

/** Seconds of solo laps per round, and laps of score per solo lap lost (losing pace is never worth it). */
export const SOLO_SECONDS = 60;
const SOLO_PACE = 8;

/**
 * One round of a drill lesson: every candidate (each student and its
 * variations) drives its own drill; drills step together. The viewer is
 * shown one student's own drill.
 */
export class DrillTrial<R extends { fitness: number }> {
  private readonly shown: number;
  private readonly solo: Trial | null;
  private readonly candidates: number;
  private readonly lapLength: number;

  /**
   * drills: per student, [own, +e1, -e1, ...] (candidates, the genomes driving them);
   * show: which student's own drill is on screen; anchor: hold solo driving to the references.
   */
  constructor(
    readonly drills: Drill<R>[], private readonly perStudent: number, show: number,
    candidates: Float32Array[] = [], anchor?: SoloAnchor,
  ) {
    this.shown = show * perStudent;
    this.candidates = candidates.length;
    this.lapLength = anchor?.track.length ?? 1;
    this.solo = anchor && candidates.length
      ? new Trial(anchor.track, [...candidates, ...anchor.references], { seconds: SOLO_SECONDS, damagePenaltyLaps: FULL_DAMAGE_PENALTY })
      : null;
  }

  get world(): World {
    return this.drills[this.shown].world;
  }

  /** In the shown drill, which car is the student (the rest are the field). */
  get shownStudent(): Car {
    return this.drills[this.shown].student;
  }

  get done(): boolean {
    return this.drills.every((d) => d.done) && (this.solo?.done ?? true);
  }

  get remaining(): number {
    return this.drills[this.shown].done ? 0 : 1;
  }

  step(): void {
    for (const d of this.drills) d.step();
    this.solo?.step();
  }

  /** Each drill's result, less any solo pace and cleanliness lost against the student's reference. */
  results(): Array<R & { soloLaps?: number }> {
    const out = this.drills.map((d) => d.result());
    if (!this.solo) return out;
    const solo = this.solo.results();
    return out.map((r, i) => {
      const ref = solo[this.candidates + Math.floor(i / this.perStudent)], mine = solo[i];
      // Distance, not laps completed: in 60 s most drivers complete one lap, fast or slow, and a
      // check on whole laps let 10% of pace slip by unseen.
      const lostLaps = Math.max(0, ref.distance - mine.distance) / this.lapLength;
      const lost = SOLO_PACE * lostLaps + FULL_DAMAGE_PENALTY * Math.max(0, ref.health - mine.health);
      return { ...r, fitness: r.fitness - lost, soloLaps: mine.distance / this.lapLength };
    });
  }
}

/**
 * Does a student still race as it did before the class? Solo laps on a track
 * next to its reference: clean, and at least PACE_KEPT of its pace. Part of
 * every drill lesson's license.
 */
const PACE_KEPT = 0.97;
export function racingKept(track: Track, weights: Float32Array, reference: Float32Array): boolean {
  const trial = new Trial(track, [weights.slice(), reference.slice()], { seconds: SOLO_SECONDS });
  while (!trial.done) trial.step();
  const [mine, ref] = trial.results();
  return mine.health >= Math.min(0.95, ref.health) && mine.distance >= PACE_KEPT * ref.distance;
}
