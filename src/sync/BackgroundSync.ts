/**
 * Background Sync Manager
 *
 * Coordinates background synchronization of replays to Supabase.
 * Handles online/offline events and periodic sync checks.
 */

import { syncQueue } from './SyncQueue';
import { deviceIdentity } from './DeviceIdentity';
import { isSupabaseConfigured } from './SupabaseClient';
import { lapReplayStorage } from '../replay/LapReplayStorage';

// Configuration
const SYNC_INTERVAL_MS = 30000; // 30 seconds
const INITIAL_SYNC_DELAY_MS = 2000; // 2 seconds after startup

type OnlineStatusCallback = (isOnline: boolean) => void;
type SyncStatusCallback = (pending: number, failed: number) => void;

class BackgroundSyncManager {
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private isStarted = false;
  private onlineListeners: Set<OnlineStatusCallback> = new Set();
  private syncStatusListeners: Set<SyncStatusCallback> = new Set();

  /**
   * Start the background sync manager.
   * Should be called once on app initialization.
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    if (!isSupabaseConfigured()) {
      console.log('Background sync disabled: Supabase not configured');
      return;
    }

    this.isStarted = true;

    // Initialize device identity
    await deviceIdentity.getDeviceId();

    // Listen for online/offline events
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);

    // Listen to sync queue events
    syncQueue.addEventListener(this.handleSyncEvent);

    // Start periodic sync check
    this.syncInterval = setInterval(() => {
      if (navigator.onLine) {
        this.syncPendingReplays();
      }
    }, SYNC_INTERVAL_MS);

    // Initial sync after short delay (let app initialize)
    if (navigator.onLine) {
      setTimeout(() => {
        this.syncPendingReplays();
      }, INITIAL_SYNC_DELAY_MS);
    }

    console.log('Background sync started');
  }

  /**
   * Stop the background sync manager.
   */
  stop(): void {
    if (!this.isStarted) return;

    this.isStarted = false;

    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    syncQueue.removeEventListener(this.handleSyncEvent);

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    console.log('Background sync stopped');
  }

  /**
   * Check if background sync is running.
   */
  isRunning(): boolean {
    return this.isStarted;
  }

  /**
   * Check if we're currently online.
   */
  isOnline(): boolean {
    return navigator.onLine;
  }

  /**
   * Get current sync status.
   */
  getSyncStatus(): { pending: number; failed: number } {
    return {
      pending: syncQueue.getPendingCount(),
      failed: syncQueue.getFailedCount(),
    };
  }

  /**
   * Trigger an immediate sync of pending replays.
   */
  async syncNow(): Promise<void> {
    if (!navigator.onLine) {
      console.log('Cannot sync: offline');
      return;
    }

    await this.syncPendingReplays();
  }

  /**
   * Retry all failed syncs.
   */
  retryFailed(): void {
    syncQueue.retryFailed();
  }

  /**
   * Add listener for online status changes.
   */
  addOnlineListener(callback: OnlineStatusCallback): void {
    this.onlineListeners.add(callback);
  }

  /**
   * Remove online status listener.
   */
  removeOnlineListener(callback: OnlineStatusCallback): void {
    this.onlineListeners.delete(callback);
  }

  /**
   * Add listener for sync status changes.
   */
  addSyncStatusListener(callback: SyncStatusCallback): void {
    this.syncStatusListeners.add(callback);
  }

  /**
   * Remove sync status listener.
   */
  removeSyncStatusListener(callback: SyncStatusCallback): void {
    this.syncStatusListeners.delete(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleOnline = (): void => {
    console.log('Back online - triggering sync');
    this.notifyOnlineStatus(true);
    this.syncPendingReplays();
  };

  private handleOffline = (): void => {
    console.log('Gone offline - pausing sync');
    this.notifyOnlineStatus(false);
  };

  private handleSyncEvent = (): void => {
    // Notify listeners of sync status changes
    const status = this.getSyncStatus();
    this.notifySyncStatus(status.pending, status.failed);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Sync Logic
  // ─────────────────────────────────────────────────────────────────────────

  private async syncPendingReplays(): Promise<void> {
    try {
      // Find all replays with syncStatus: 'pending'
      // Note: This requires the new method we'll add to LapReplayStorage
      const pendingReplays = await lapReplayStorage.getUnsyncedReplays();

      for (const replay of pendingReplays) {
        // Skip if already in queue
        if (!syncQueue.isInQueue(replay.id)) {
          await syncQueue.enqueue(replay.id, 'upload');
        }
      }

      // Trigger queue processing
      syncQueue.triggerProcessing();
    } catch (err) {
      console.error('Error during sync check:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Notifications
  // ─────────────────────────────────────────────────────────────────────────

  private notifyOnlineStatus(isOnline: boolean): void {
    for (const listener of this.onlineListeners) {
      try {
        listener(isOnline);
      } catch (err) {
        console.error('Online status listener error:', err);
      }
    }
  }

  private notifySyncStatus(pending: number, failed: number): void {
    for (const listener of this.syncStatusListeners) {
      try {
        listener(pending, failed);
      } catch (err) {
        console.error('Sync status listener error:', err);
      }
    }
  }
}

// Export singleton instance
export const backgroundSync = new BackgroundSyncManager();
