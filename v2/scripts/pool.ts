/**
 * Worker threads for headless training: driving school work spread over the
 * CPU's cores with the same results as one thread (ghosts don't interact, and
 * each student's apprenticeship is its own).
 *
 *   const pool = new SchoolPool(6);
 *   await pool.apprenticeRoad(weights, seed)        one student's road apprenticeship, on a free worker
 *   await pool.ghostRound(layout, genomes, opts)    a round's ghost laps, split across every worker
 *   await pool.roadcraftRound(round)                a circuit racecraft round's drills, split across every worker
 *   pool.close()
 *
 * This file is also the workers' entry (with workerData.schoolPool set).
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Trial, type TrialOptions, type TrialResult } from '../src/ai/evaluate';
import type { TrackLayout } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { apprenticeRoadCourses, type ApprenticeOptions } from '../src/school/roadLesson';
import type { RoadcraftRound } from '../src/school/classroom';
import type { RacecraftResult } from '../src/school/racecraftLesson';
import { roadcraftDrill } from '../src/school/roadcraftLesson';

/** A worker thread running a TypeScript module (workers don't inherit tsx's loader: each registers it first). */
export function tsWorker(moduleUrl: string, data: unknown): Worker {
  const boot = `import('tsx/esm/api').then((m) => { m.register(); return import(${JSON.stringify(moduleUrl)}); })`;
  return new Worker(boot, { eval: true, workerData: data });
}

type Task =
  | { kind: 'apprenticeRoad'; weights: Float32Array; seed: number; opts?: ApprenticeOptions }
  | { kind: 'drive'; layout: TrackLayout; genomes: Float32Array[]; opts: TrialOptions }
  | { kind: 'finish'; steps: number }
  | { kind: 'roadcraft'; round: RoadcraftRound; from: number; to: number };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export class SchoolPool {
  private readonly workers: Worker[];
  private readonly idle: number[];
  private readonly waiting: Array<(worker: number) => void> = [];
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private nextId = 0;

  constructor(readonly size: number) {
    this.workers = Array.from({ length: size }, () => {
      const w = tsWorker(import.meta.url, { schoolPool: true });
      w.on('message', (r: Reply) => {
        const p = this.pending.get(r.id)!;
        this.pending.delete(r.id);
        if (r.ok) p.ok(r.value);
        else p.fail(new Error(r.error));
      });
      w.on('error', (e) => { for (const p of this.pending.values()) p.fail(e as Error); this.pending.clear(); });
      return w;
    });
    this.idle = this.workers.map((_, i) => i);
  }

  private call<T>(worker: number, task: Task): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.workers[worker].postMessage({ id, task });
    });
  }

  /** Run a task on the next free worker. */
  private async any<T>(task: Task): Promise<T> {
    const worker = this.idle.length ? this.idle.shift()! : await new Promise<number>((r) => this.waiting.push(r));
    try {
      return await this.call<T>(worker, task);
    } finally {
      const next = this.waiting.shift();
      if (next) next(worker);
      else this.idle.push(worker);
    }
  }

  /** A road-course skill's apprenticeship (apprenticeRoadCourses); resolves to the trained weights. */
  apprenticeRoad(weights: Float32Array, seed: number, opts?: ApprenticeOptions): Promise<{ weights: Float32Array; examples: number; loss: number }> {
    return this.any({ kind: 'apprenticeRoad', weights, seed, opts });
  }

  /**
   * A round of ghost laps split across every worker. One world would end the
   * round when every car has stalled, and until then stalled cars roll on; so
   * each part drives until its own cars have all stalled, and then the parts
   * that ended sooner carry on to where the longest did.
   */
  async ghostRound(layout: TrackLayout, genomes: Float32Array[], opts: TrialOptions): Promise<{ results: TrialResult[]; time: number }> {
    if (this.idle.length !== this.size) throw new Error('ghostRound needs the whole pool');
    const parts = Math.min(this.size, genomes.length);
    const per = Math.ceil(genomes.length / parts);
    const chunks = Array.from({ length: parts }, (_, i) => genomes.slice(i * per, (i + 1) * per)).filter((c) => c.length);
    const steps = await Promise.all(chunks.map((c, i) => this.call<number>(i, { kind: 'drive', layout, genomes: c, opts })));
    const until = Math.max(...steps);
    const done = await Promise.all(chunks.map((_, i) => this.call<{ results: TrialResult[]; time: number }>(i, { kind: 'finish', steps: until })));
    return { results: done.flatMap((d) => d.results), time: done[0].time };
  }

  /** A circuit racecraft round's drills (each candidate's own small world), split across every worker. */
  async roadcraftRound(round: RoadcraftRound): Promise<{ results: RacecraftResult[]; time: number }> {
    if (this.idle.length !== this.size) throw new Error('roadcraftRound needs the whole pool');
    const n = round.candidates.length, per = Math.ceil(n / this.size);
    const parts = Array.from({ length: this.size }, (_, i) => [i * per, Math.min(n, (i + 1) * per)]).filter(([a, b]) => b > a);
    const done = await Promise.all(parts.map(([from, to], i) =>
      this.call<{ results: RacecraftResult[]; time: number }>(i, { kind: 'roadcraft', round, from, to })));
    return { results: done.flatMap((d) => d.results), time: done[0].time };
  }

  close(): Promise<number[]> {
    return Promise.all(this.workers.map((w) => w.terminate()));
  }
}

if (!isMainThread && workerData?.schoolPool) {
  // The round this worker is driving its part of, between 'drive' and 'finish'.
  let trial: Trial | null = null;
  parentPort!.on('message', ({ id, task }: { id: number; task: Task }) => {
    try {
      let value: unknown;
      if (task.kind === 'apprenticeRoad') {
        const { examples, loss } = apprenticeRoadCourses(task.weights, task.seed, task.opts);
        value = { weights: task.weights, examples, loss };
      } else if (task.kind === 'drive') {
        trial = new Trial(new Track(task.layout), task.genomes, task.opts);
        while (!trial.done) trial.step();
        value = trial.stepsRun;
      } else if (task.kind === 'roadcraft') {
        const r = task.round;
        const track = new Track(r.layout);
        const drills = [];
        for (let i = task.from; i < task.to; i++) {
          const own = Math.floor(i / r.perStudent);
          drills.push(roadcraftDrill(track, r.slot, r.candidates[i], own, r.classmates, r.pack, r.nerves[own], r.pace));
        }
        for (const d of drills) while (!d.done) d.step();
        value = { results: drills.map((d) => d.result()), time: drills[0].world.time };
      } else {
        trial!.continueTo(task.steps);
        value = { results: trial!.results(), time: trial!.world.time };
        trial = null;
      }
      parentPort!.postMessage({ id, ok: true, value } satisfies Reply);
    } catch (e) {
      parentPort!.postMessage({ id, ok: false, error: (e as Error).stack ?? String(e) } satisfies Reply);
    }
  });
}
