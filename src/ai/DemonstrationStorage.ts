/**
 * Demonstration Storage
 *
 * Persists player demonstrations to IndexedDB for unlimited storage.
 * Provides async methods for saving, retrieving, and managing demos.
 */

import type { PlayerDemonstration, DemonstrationSummary } from './DemonstrationTypes';

const DB_NAME = 'dotgp-demonstrations';
const DB_VERSION = 1;
const STORE_NAME = 'demonstrations';

/**
 * IndexedDB-backed storage for player demonstrations.
 * Uses composite seed as an index for fast track-specific queries.
 */
export class DemonstrationStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database connection.
   * Called automatically on first operation, but can be called early.
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open DemonstrationStorage:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // Index on compositeSeed for fast track-specific queries
          store.createIndex('compositeSeed', 'compositeSeed', { unique: false });

          // Index on timestamp for sorting
          store.createIndex('timestamp', 'timestamp', { unique: false });

          // Compound index for getting demos by track sorted by lap time
          store.createIndex('compositeSeed_lapTime', ['compositeSeed', 'lapTime'], {
            unique: false,
          });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Ensure database is ready before operations.
   */
  private async ensureDb(): Promise<IDBDatabase> {
    await this.init();
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  /**
   * Save a player demonstration.
   */
  async saveDemonstration(demo: PlayerDemonstration): Promise<void> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.put(demo);

      request.onerror = () => {
        console.error('Failed to save demonstration:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Get all demonstrations for a specific track (by composite seed).
   * Returns demos sorted by lap time (fastest first).
   */
  async getDemonstrations(compositeSeed: number): Promise<PlayerDemonstration[]> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('compositeSeed');

      const request = index.getAll(compositeSeed);

      request.onerror = () => {
        console.error('Failed to get demonstrations:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const demos = request.result as PlayerDemonstration[];
        // Sort by lap time (fastest first)
        demos.sort((a, b) => a.lapTime - b.lapTime);
        resolve(demos);
      };
    });
  }

  /**
   * Get summaries for all demonstrations for a track (without full frame data).
   * Useful for UI display without loading large amounts of data.
   */
  async getDemonstrationSummaries(compositeSeed: number): Promise<DemonstrationSummary[]> {
    const demos = await this.getDemonstrations(compositeSeed);

    return demos.map((demo) => ({
      id: demo.id,
      playerInitials: demo.playerInitials,
      compositeSeed: demo.compositeSeed,
      lapTime: demo.lapTime,
      sectorTimes: demo.sectorTimes,
      timestamp: demo.timestamp,
      frameCount: demo.frames.length,
    }));
  }

  /**
   * Get a single demonstration by ID.
   */
  async getDemonstration(id: string): Promise<PlayerDemonstration | null> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.get(id);

      request.onerror = () => {
        console.error('Failed to get demonstration:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  }

  /**
   * Delete a demonstration by ID.
   */
  async deleteDemonstration(id: string): Promise<void> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.delete(id);

      request.onerror = () => {
        console.error('Failed to delete demonstration:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Get all demonstrations across all tracks.
   */
  async getAllDemonstrations(): Promise<PlayerDemonstration[]> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.getAll();

      request.onerror = () => {
        console.error('Failed to get all demonstrations:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result as PlayerDemonstration[]);
      };
    });
  }

  /**
   * Get count of demonstrations for a specific track.
   */
  async getDemonstrationCount(compositeSeed: number): Promise<number> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('compositeSeed');

      const request = index.count(compositeSeed);

      request.onerror = () => {
        console.error('Failed to count demonstrations:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Get total count of all demonstrations.
   */
  async getTotalCount(): Promise<number> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.count();

      request.onerror = () => {
        console.error('Failed to count demonstrations:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Get unique track seeds that have demonstrations.
   */
  async getTracksWithDemonstrations(): Promise<number[]> {
    const demos = await this.getAllDemonstrations();
    const seeds = new Set(demos.map((d) => d.compositeSeed));
    return Array.from(seeds);
  }

  /**
   * Clear all demonstrations.
   */
  async clearAll(): Promise<void> {
    const db = await this.ensureDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.clear();

      request.onerror = () => {
        console.error('Failed to clear demonstrations:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

// Singleton instance for easy access
export const demonstrationStorage = new DemonstrationStorage();
