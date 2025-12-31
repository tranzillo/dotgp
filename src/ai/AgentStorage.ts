import type { AgentProfile, AgentProfileSummary } from './AgentProfile';
import { toAgentSummary } from './AgentProfile';

const DB_NAME = 'dotgp-agents';
const DB_VERSION = 1;
const STORE_NAME = 'agents';

/**
 * IndexedDB storage for AI agent profiles.
 *
 * Features:
 * - Full CRUD operations for AgentProfile
 * - Query by compositeSeed for track-specific agents
 * - Automatic schema migrations
 */
class AgentStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize database connection.
   */
  private async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // Index for querying by track
          store.createIndex('compositeSeed', 'compositeSeed', { unique: false });

          // Index for querying by update time
          store.createIndex('updatedAt', 'updatedAt', { unique: false });

          // Index for querying by name (for search)
          store.createIndex('name', 'name', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get a transaction store.
   */
  private async getStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');
    const tx = this.db.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
  }

  /**
   * Save or update an agent profile.
   */
  async saveAgent(agent: AgentProfile): Promise<void> {
    const store = await this.getStore('readwrite');

    // Update timestamp
    agent.updatedAt = Date.now();

    return new Promise((resolve, reject) => {
      const request = store.put(agent);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get agent by ID.
   */
  async getAgent(id: string): Promise<AgentProfile | null> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all agents for a specific track.
   */
  async getAgentsForTrack(compositeSeed: number): Promise<AgentProfile[]> {
    const store = await this.getStore('readonly');
    const index = store.index('compositeSeed');

    return new Promise((resolve, reject) => {
      const request = index.getAll(compositeSeed);
      request.onsuccess = () => {
        // Sort by updatedAt (most recent first)
        const agents = request.result as AgentProfile[];
        agents.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(agents);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get summaries for all agents on a track (lightweight).
   */
  async getAgentSummariesForTrack(compositeSeed: number): Promise<AgentProfileSummary[]> {
    const agents = await this.getAgentsForTrack(compositeSeed);
    return agents.map(toAgentSummary);
  }

  /**
   * Delete an agent by ID.
   */
  async deleteAgent(id: string): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all agents across all tracks.
   */
  async getAllAgents(): Promise<AgentProfile[]> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const agents = request.result as AgentProfile[];
        agents.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(agents);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get summaries for all agents.
   */
  async getAllAgentSummaries(): Promise<AgentProfileSummary[]> {
    const agents = await this.getAllAgents();
    return agents.map(toAgentSummary);
  }

  /**
   * Get count of agents.
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
   * Get count of agents for a specific track.
   */
  async getCountForTrack(compositeSeed: number): Promise<number> {
    const store = await this.getStore('readonly');
    const index = store.index('compositeSeed');

    return new Promise((resolve, reject) => {
      const request = index.count(compositeSeed);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all unique track seeds that have agents.
   */
  async getTracksWithAgents(): Promise<number[]> {
    const agents = await this.getAllAgents();
    const seeds = new Set<number>();
    for (const agent of agents) {
      seeds.add(agent.compositeSeed);
    }
    return Array.from(seeds);
  }

  /**
   * Clear all agents (use with caution!).
   */
  async clearAll(): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Check if an agent exists.
   */
  async exists(id: string): Promise<boolean> {
    const agent = await this.getAgent(id);
    return agent !== null;
  }

  /**
   * Rename an agent.
   */
  async renameAgent(id: string, newName: string): Promise<void> {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);

    agent.name = newName;
    await this.saveAgent(agent);
  }

  /**
   * Update agent notes.
   */
  async updateNotes(id: string, notes: string): Promise<void> {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);

    agent.notes = notes;
    await this.saveAgent(agent);
  }

  /**
   * Duplicate an agent with a new name.
   */
  async duplicateAgent(id: string, newName: string): Promise<AgentProfile> {
    const original = await this.getAgent(id);
    if (!original) throw new Error(`Agent ${id} not found`);

    const duplicate: AgentProfile = {
      ...original,
      id: crypto.randomUUID(),
      name: newName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Deep copy arrays
      trainingSessions: [...original.trainingSessions],
      tags: [...original.tags],
    };

    await this.saveAgent(duplicate);
    return duplicate;
  }
}

// Export singleton instance
export const agentStorage = new AgentStorage();
