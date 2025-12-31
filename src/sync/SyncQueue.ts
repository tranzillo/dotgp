/**
 * Sync Queue
 *
 * Manages a queue of replay sync operations with retry logic.
 * Persists queue state to localStorage for crash recovery.
 */

import type { SyncQueueItem, SyncQueueState, SyncEvent, SyncStatus } from './types';
import { lapReplayStorage } from '../replay/LapReplayStorage';
import { replayService } from './services/ReplayService';

const QUEUE_STORAGE_KEY = 'dotgp_sync_queue';
const QUEUE_VERSION = 1;

// Configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_CONCURRENT_UPLOADS = 2;

type SyncEventListener = (event: SyncEvent) => void;

class SyncQueueManager {
  private queue: SyncQueueItem[] = [];
  private isProcessing = false;
  private activeUploads = 0;
  private listeners: Set<SyncEventListener> = new Set();

  constructor() {
    this.loadQueue();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a replay to the sync queue.
   */
  async enqueue(replayId: string, operation: 'upload' | 'delete'): Promise<void> {
    // Check if already in queue
    const existing = this.queue.find((item) => item.replayId === replayId);
    if (existing) {
      // Update operation if different
      if (existing.operation !== operation) {
        existing.operation = operation;
        existing.retryCount = 0;
        existing.error = undefined;
        this.persistQueue();
      }
      return;
    }

    // Add to queue
    const item: SyncQueueItem = {
      id: crypto.randomUUID(),
      replayId,
      operation,
      retryCount: 0,
      lastAttempt: 0,
    };

    this.queue.push(item);
    this.persistQueue();

    // Update local sync status
    await this.updateLocalSyncStatus(replayId, 'pending');

    // Emit progress event
    this.emitProgress();

    // Start processing if not already
    this.processQueue();
  }

  /**
   * Remove a replay from the sync queue.
   */
  dequeue(replayId: string): void {
    const index = this.queue.findIndex((item) => item.replayId === replayId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.persistQueue();
      this.emitProgress();
    }
  }

  /**
   * Get the current queue length.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get pending sync count.
   */
  getPendingCount(): number {
    return this.queue.filter((item) => item.retryCount < MAX_RETRIES).length;
  }

  /**
   * Get failed sync count (max retries exceeded).
   */
  getFailedCount(): number {
    return this.queue.filter((item) => item.retryCount >= MAX_RETRIES).length;
  }

  /**
   * Check if a replay is in the queue.
   */
  isInQueue(replayId: string): boolean {
    return this.queue.some((item) => item.replayId === replayId);
  }

  /**
   * Retry failed items.
   */
  retryFailed(): void {
    for (const item of this.queue) {
      if (item.retryCount >= MAX_RETRIES) {
        item.retryCount = 0;
        item.error = undefined;
      }
    }
    this.persistQueue();
    this.processQueue();
  }

  /**
   * Clear all failed items from the queue.
   */
  clearFailed(): void {
    this.queue = this.queue.filter((item) => item.retryCount < MAX_RETRIES);
    this.persistQueue();
    this.emitProgress();
  }

  /**
   * Add an event listener.
   */
  addEventListener(listener: SyncEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove an event listener.
   */
  removeEventListener(listener: SyncEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Trigger queue processing (called when coming online).
   */
  triggerProcessing(): void {
    if (!this.isProcessing && this.queue.length > 0) {
      this.processQueue();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue Processing
  // ─────────────────────────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    if (!navigator.onLine) return;
    if (this.queue.length === 0) return;

    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && navigator.onLine) {
        // Find items ready to process (not at max retries, not too recent)
        const readyItems = this.queue.filter(
          (item) =>
            item.retryCount < MAX_RETRIES &&
            Date.now() - item.lastAttempt > RETRY_DELAY_MS * item.retryCount
        );

        if (readyItems.length === 0) {
          // All items are either failed or waiting for retry delay
          break;
        }

        // Process up to MAX_CONCURRENT_UPLOADS items in parallel
        const batch = readyItems.slice(0, MAX_CONCURRENT_UPLOADS - this.activeUploads);
        if (batch.length === 0) {
          // Max concurrent uploads reached, wait a bit
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        await Promise.all(batch.map((item) => this.processItem(item)));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processItem(item: SyncQueueItem): Promise<void> {
    this.activeUploads++;

    try {
      if (item.operation === 'upload') {
        await replayService.uploadReplay(item.replayId);
      } else {
        await replayService.deleteRemoteReplay(item.replayId);
      }

      // Success - remove from queue
      this.removeItem(item.id);

      // Update local sync status
      await this.updateLocalSyncStatus(item.replayId, 'synced');

      // Emit status change event
      this.emit({
        type: 'status_change',
        replayId: item.replayId,
        oldStatus: 'pending',
        newStatus: 'synced',
      });
    } catch (error) {
      // Failure - increment retry count
      item.retryCount++;
      item.lastAttempt = Date.now();
      item.error = error instanceof Error ? error.message : String(error);

      this.persistQueue();

      // Emit error event
      this.emit({
        type: 'error',
        replayId: item.replayId,
        error: item.error,
        retryCount: item.retryCount,
      });

      if (item.retryCount >= MAX_RETRIES) {
        console.error(`Sync failed for ${item.replayId} after ${MAX_RETRIES} retries:`, item.error);

        // Revert local status to 'local' (not synced)
        await this.updateLocalSyncStatus(item.replayId, 'local');

        this.emit({
          type: 'status_change',
          replayId: item.replayId,
          oldStatus: 'pending',
          newStatus: 'local',
        });
      }
    } finally {
      this.activeUploads--;
      this.emitProgress();
    }
  }

  private removeItem(itemId: string): void {
    const index = this.queue.findIndex((item) => item.id === itemId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.persistQueue();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Local Storage Operations
  // ─────────────────────────────────────────────────────────────────────────

  private async updateLocalSyncStatus(replayId: string, status: SyncStatus): Promise<void> {
    try {
      await lapReplayStorage.updateSyncStatus(replayId, status);
    } catch (err) {
      console.warn('Failed to update local sync status:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue Persistence
  // ─────────────────────────────────────────────────────────────────────────

  private loadQueue(): void {
    try {
      const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
      if (!raw) return;

      const state = JSON.parse(raw) as SyncQueueState;

      // Version check
      if (state.version !== QUEUE_VERSION) {
        console.warn('Sync queue version mismatch, clearing queue');
        localStorage.removeItem(QUEUE_STORAGE_KEY);
        return;
      }

      this.queue = state.items;
    } catch (err) {
      console.warn('Failed to load sync queue:', err);
      this.queue = [];
    }
  }

  private persistQueue(): void {
    try {
      const state: SyncQueueState = {
        version: QUEUE_VERSION,
        items: this.queue,
      };
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('Failed to persist sync queue:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Emission
  // ─────────────────────────────────────────────────────────────────────────

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Sync event listener error:', err);
      }
    }
  }

  private emitProgress(): void {
    this.emit({
      type: 'progress',
      pending: this.getPendingCount(),
      synced: 0, // Would need to track this separately
      failed: this.getFailedCount(),
    });
  }
}

// Export singleton instance
export const syncQueue = new SyncQueueManager();
