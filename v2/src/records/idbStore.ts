import type { ActivityRecord, ActivityStore } from './activity';

const DB_NAME = 'dotgp';
const DB_VERSION = 1;
const STORE = 'activity';

/**
 * Activity records in the browser's IndexedDB: an auto-numbered store with an
 * index by agent. Plenty of room (localStorage's few MB would not last), and
 * records come back in the order they were written.
 */
export class IndexedDbActivityStore implements ActivityStore {
  private readonly db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('agent', 'agent');
        store.createIndex('time', 'time');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async append(records: ActivityRecord[]): Promise<void> {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const r of records) {
        const { id: _id, ...rest } = r;
        store.add(rest);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async forAgent(agent: string): Promise<ActivityRecord[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).index('agent').getAll(agent);
      req.onsuccess = () => resolve((req.result as ActivityRecord[]).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)));
      req.onerror = () => reject(req.error);
    });
  }

  async count(): Promise<number> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
