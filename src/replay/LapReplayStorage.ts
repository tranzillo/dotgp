/**
 * LapReplayStorage - IndexedDB storage for lap replays.
 *
 * Features:
 * - Unlimited storage (IndexedDB allows hundreds of MB)
 * - Indexed queries by compositeSeed for fast track-specific lookups
 * - Global limit with cleanup of oldest non-training replays
 * - Async API (returns Promises)
 */

import type { LapReplay, LapReplaySummary } from './types';
import { toReplaySummary } from './types';

const DB_NAME = 'dotgp-replays';
const DB_VERSION = 2; // Bumped for syncStatus index
const STORE_NAME = 'replays';

// Global limit - keep this many replays total
const MAX_REPLAYS = 500;
// When cleaning up, remove this many at once
const CLEANUP_BATCH_SIZE = 50;

class LapReplayStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database connection.
   */
  private async init(): Promise<void> {
    if (this.db) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open replay database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const transaction = (event.target as IDBOpenDBRequest).transaction!;
        const oldVersion = event.oldVersion;

        // Create object store with id as key (version 1)
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // Index for querying by track
          store.createIndex('compositeSeed', 'compositeSeed', { unique: false });

          // Index for querying by timestamp (for cleanup)
          store.createIndex('timestamp', 'timestamp', { unique: false });

          // Index for finding training data
          store.createIndex('isTrainingData', 'isTrainingData', { unique: false });

          // Index for sync status (added in version 2)
          store.createIndex('syncStatus', 'syncStatus', { unique: false });
        } else if (oldVersion < 2) {
          // Migration from version 1 to 2: add syncStatus index
          const store = transaction.objectStore(STORE_NAME);
          if (!store.indexNames.contains('syncStatus')) {
            store.createIndex('syncStatus', 'syncStatus', { unique: false });
          }
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get the object store for transactions.
   */
  private async getStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(STORE_NAME, mode);
    return transaction.objectStore(STORE_NAME);
  }

  /**
   * Save a lap replay to storage.
   * Triggers cleanup if over the global limit.
   */
  async saveReplay(replay: LapReplay): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.add(replay);

      request.onsuccess = async () => {
        // Check if cleanup is needed
        const count = await this.getCount();
        if (count > MAX_REPLAYS) {
          await this.cleanup();
        }
        resolve();
      };

      request.onerror = () => {
        console.error('Failed to save replay:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get a replay by ID.
   */
  async getReplay(id: string): Promise<LapReplay | null> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get all replays for a specific track (by composite seed).
   * Returns full replay objects.
   */
  async getReplaysForTrack(compositeSeed: number): Promise<LapReplay[]> {
    const store = await this.getStore('readonly');
    const index = store.index('compositeSeed');

    return new Promise((resolve, reject) => {
      const request = index.getAll(compositeSeed);

      request.onsuccess = () => {
        // Sort by lap time (fastest first)
        const replays = request.result as LapReplay[];
        replays.sort((a, b) => a.lapTime - b.lapTime);
        resolve(replays);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get replay summaries for a specific track (without frame data).
   * More efficient for UI display.
   */
  async getReplaySummariesForTrack(compositeSeed: number): Promise<LapReplaySummary[]> {
    const replays = await this.getReplaysForTrack(compositeSeed);
    return replays.map(toReplaySummary);
  }

  /**
   * Get the personal best (fastest valid lap) for a specific driver on a track.
   * For AI: matches by agentName. For human: matches by playerInitials.
   * Returns null if no valid laps exist for this driver.
   */
  async getPersonalBest(
    compositeSeed: number,
    playerInitials: string,
    agentName?: string
  ): Promise<LapReplaySummary | null> {
    const replays = await this.getReplaysForTrack(compositeSeed);

    // Filter to valid (leaderboard-eligible) laps for this driver
    const validLaps = replays.filter(r => {
      // Must be leaderboard eligible (no off-track)
      if (!r.cleanliness?.isLeaderboardEligible) return false;

      if (agentName) {
        // AI lap - match by agent name
        return r.isAI && r.agentName === agentName;
      }
      // Human lap - match by initials
      return !r.isAI && r.playerInitials === playerInitials;
    });

    if (validLaps.length === 0) return null;

    // Already sorted by lapTime ascending - first is fastest
    return toReplaySummary(validLaps[0]);
  }

  /**
   * Get all lap times for a track (for percentile calculations).
   */
  async getAllLapTimes(compositeSeed: number): Promise<number[]> {
    const replays = await this.getReplaysForTrack(compositeSeed);
    return replays.map(r => r.lapTime);
  }

  /**
   * Get all replays marked as training data for a track.
   */
  async getTrainingReplays(compositeSeed: number): Promise<LapReplay[]> {
    const replays = await this.getReplaysForTrack(compositeSeed);
    return replays.filter((r) => r.isTrainingData);
  }

  /**
   * Toggle the training data flag for a replay.
   */
  async setTrainingData(id: string, isTrainingData: boolean): Promise<void> {
    const replay = await this.getReplay(id);
    if (!replay) return;

    replay.isTrainingData = isTrainingData;

    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.put(replay);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a replay by ID.
   */
  async deleteReplay(id: string): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get total count of replays.
   */
  async getCount(): Promise<number> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clean up old replays to stay under the global limit.
   * Removes oldest non-training replays first.
   */
  private async cleanup(): Promise<void> {
    const store = await this.getStore('readwrite');
    const index = store.index('timestamp');

    return new Promise((resolve, reject) => {
      // Get all replays sorted by timestamp (oldest first)
      const request = index.openCursor();
      let deleted = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor && deleted < CLEANUP_BATCH_SIZE) {
          const replay = cursor.value as LapReplay;

          // Don't delete training data
          if (!replay.isTrainingData) {
            cursor.delete();
            deleted++;
          }

          cursor.continue();
        } else {
          console.log(`Cleanup: deleted ${deleted} old replays`);
          resolve();
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get recent replays across all tracks (for global view).
   */
  async getRecentReplays(limit: number = 20): Promise<LapReplaySummary[]> {
    const store = await this.getStore('readonly');
    const index = store.index('timestamp');

    return new Promise((resolve, reject) => {
      const replays: LapReplay[] = [];
      const request = index.openCursor(null, 'prev'); // Newest first

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor && replays.length < limit) {
          replays.push(cursor.value);
          cursor.continue();
        } else {
          resolve(replays.map(toReplaySummary));
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Clear all replays (for debugging/testing).
   */
  async clearAll(): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sync Status Methods (for cloud sync support)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update the sync status of a replay.
   */
  async updateSyncStatus(
    id: string,
    syncStatus: 'local' | 'pending' | 'synced'
  ): Promise<void> {
    const replay = await this.getReplay(id);
    if (!replay) return;

    replay.syncStatus = syncStatus;

    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.put(replay);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all replays that need to be synced (status: 'pending').
   * Used by BackgroundSync to find unsynced replays.
   */
  async getUnsyncedReplays(): Promise<LapReplay[]> {
    const store = await this.getStore('readonly');

    // Check if syncStatus index exists (may not exist for old DBs)
    if (!store.indexNames.contains('syncStatus')) {
      // Fallback: scan all replays
      return this.getAllReplaysWithStatus('pending');
    }

    const index = store.index('syncStatus');

    return new Promise((resolve, reject) => {
      const request = index.getAll('pending');

      request.onsuccess = () => {
        resolve(request.result as LapReplay[]);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Fallback method to get replays by status when index is unavailable.
   */
  private async getAllReplaysWithStatus(
    status: 'local' | 'pending' | 'synced'
  ): Promise<LapReplay[]> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.getAll();

      request.onsuccess = () => {
        const replays = (request.result as LapReplay[]).filter(
          (r) => r.syncStatus === status
        );
        resolve(replays);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get sync status counts.
   * Returns counts of replays in each sync state.
   */
  async getSyncStatusCounts(): Promise<{
    local: number;
    pending: number;
    synced: number;
  }> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.getAll();

      request.onsuccess = () => {
        const replays = request.result as LapReplay[];
        const counts = { local: 0, pending: 0, synced: 0 };

        for (const replay of replays) {
          const status = replay.syncStatus || 'local';
          counts[status]++;
        }

        resolve(counts);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Mark all local replays as pending sync.
   * Used to trigger sync of existing replays.
   */
  async markAllForSync(): Promise<number> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.openCursor();
      let count = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const replay = cursor.value as LapReplay;

          // Only mark 'local' replays as 'pending'
          if (replay.syncStatus === 'local' || !replay.syncStatus) {
            replay.syncStatus = 'pending';
            cursor.update(replay);
            count++;
          }

          cursor.continue();
        } else {
          resolve(count);
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}

// Export singleton instance
export const lapReplayStorage = new LapReplayStorage();
