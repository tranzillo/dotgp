import type { EntrantResult, TimelineEvent } from '../events/session';
import type { Livery } from '../render/livery';
import type { TrackLayout } from '../sim/layout';
import type { EventRef } from './activity';

/**
 * Saved replays: finished races, and driving-school rounds that were watched
 * or earned a license. Each is a description (what it was, who raced, what
 * happened, how it ended) and its tape, packed small (events/tapeCodec.ts).
 * Descriptions are listed together; a tape is loaded only to be watched.
 *
 * Replays are kept up to a size cap; past it the oldest go first, except
 * ones pinned to keep.
 */

/** A team as the replay shows it: car number and colours, and its three agents. */
export interface ReplayTeam {
  id: number;
  livery: Livery;
  driver: string;
  spotter: string;
  chief: string;
  /** The driver's name at the time (they may have left the roster since). */
  driverName?: string;
}

export interface ReplayMeta {
  /** The event's id, plus the round for a class's rounds. */
  id: string;
  /** Saved (wall-clock ms). */
  saved: number;
  label: string;
  event: EventRef;
  kind: 'race' | 'class';
  track: string;
  layout: TrackLayout;
  /** Races: the teams, by team id (the tape's car keys). */
  teams: ReplayTeam[];
  /** Classes: each student's colours, by student key. */
  liveries?: Array<[number, Livery]>;
  timeline: TimelineEvent[];
  results?: EntrantResult[];
  /** Classes: the round, and who earned the lesson's license in it. */
  round?: number;
  graduated?: number[];
  /** Sim seconds on tape, and the packed tape's size. */
  duration: number;
  bytes: number;
  pinned: boolean;
}

export interface ReplayStore {
  /** Every saved replay's description, newest first. */
  list(): Promise<ReplayMeta[]>;
  save(meta: ReplayMeta, tape: Uint8Array): Promise<void>;
  tape(id: string): Promise<Uint8Array | null>;
  remove(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
}

/** Remove the oldest unpinned replays until the rest fit in `cap` bytes. Returns what went. */
export async function enforceCap(store: ReplayStore, cap: number): Promise<ReplayMeta[]> {
  const all = await store.list();
  let total = all.reduce((a, m) => a + m.bytes, 0);
  const removed: ReplayMeta[] = [];
  for (const m of [...all].reverse()) {
    if (total <= cap) break;
    if (m.pinned) continue;
    await store.remove(m.id);
    total -= m.bytes;
    removed.push(m);
  }
  return removed;
}

const newestFirst = (a: ReplayMeta, b: ReplayMeta) => b.saved - a.saved;

export class MemoryReplayStore implements ReplayStore {
  private readonly metas = new Map<string, ReplayMeta>();
  private readonly tapes = new Map<string, Uint8Array>();

  async list(): Promise<ReplayMeta[]> {
    return [...this.metas.values()].sort(newestFirst);
  }

  async save(meta: ReplayMeta, tape: Uint8Array): Promise<void> {
    this.metas.set(meta.id, meta);
    this.tapes.set(meta.id, tape);
  }

  async tape(id: string): Promise<Uint8Array | null> {
    return this.tapes.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.metas.delete(id);
    this.tapes.delete(id);
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const m = this.metas.get(id);
    if (m) m.pinned = pinned;
  }
}

const DB_NAME = 'dotgp-replays';
const DB_VERSION = 1;
const METAS = 'replays';
const TAPES = 'tapes';

/** Replays in the browser's IndexedDB (their own database, apart from the activity log). */
export class IndexedDbReplayStore implements ReplayStore {
  private readonly db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(METAS, { keyPath: 'id' });
        req.result.createObjectStore(TAPES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = body(tx);
      tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async list(): Promise<ReplayMeta[]> {
    const all = await this.run<ReplayMeta[]>([METAS], 'readonly', (tx) => tx.objectStore(METAS).getAll());
    return all.sort(newestFirst);
  }

  async save(meta: ReplayMeta, tape: Uint8Array): Promise<void> {
    await this.run([METAS, TAPES], 'readwrite', (tx) => {
      tx.objectStore(METAS).put(meta);
      tx.objectStore(TAPES).put(tape, meta.id);
    });
  }

  async tape(id: string): Promise<Uint8Array | null> {
    return (await this.run<Uint8Array | undefined>([TAPES], 'readonly', (tx) => tx.objectStore(TAPES).get(id))) ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.run([METAS, TAPES], 'readwrite', (tx) => {
      tx.objectStore(METAS).delete(id);
      tx.objectStore(TAPES).delete(id);
    });
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.run([METAS], 'readwrite', (tx) => {
      const store = tx.objectStore(METAS);
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, pinned });
      };
    });
  }
}
