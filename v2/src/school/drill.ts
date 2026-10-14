import type { Car } from '../sim/car';
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
 * One round of a drill lesson: every candidate (each student and its
 * variations) drives its own drill; drills step together. The viewer is
 * shown one student's own drill.
 */
export class DrillTrial<R> {
  private readonly shown: number;

  /** drills: per student, [own, +e1, -e1, ...]; show: which student's own drill is on screen. */
  constructor(readonly drills: Drill<R>[], perStudent: number, show: number) {
    this.shown = show * perStudent;
  }

  get world(): World {
    return this.drills[this.shown].world;
  }

  /** In the shown drill, which car is the student (the rest are the field). */
  get shownStudent(): Car {
    return this.drills[this.shown].student;
  }

  get done(): boolean {
    return this.drills.every((d) => d.done);
  }

  get remaining(): number {
    return this.drills[this.shown].done ? 0 : 1;
  }

  step(): void {
    for (const d of this.drills) d.step();
  }

  results(): R[] {
    return this.drills.map((d) => d.result());
  }
}
