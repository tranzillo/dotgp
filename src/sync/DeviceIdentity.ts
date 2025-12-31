/**
 * Device Identity Manager
 *
 * Manages anonymous device identification for the sync system.
 * Each browser/device gets a unique UUID that persists across sessions.
 */

import { getSupabase, isSupabaseConfigured, updateDeviceIdHeader } from './SupabaseClient';

const DEVICE_ID_KEY = 'dotgp_device_id';

class DeviceIdentityManager {
  private deviceId: string | null = null;
  private initPromise: Promise<string> | null = null;

  /**
   * Get the device ID, creating one if it doesn't exist.
   * Registers the device with Supabase on first use.
   */
  async getDeviceId(): Promise<string> {
    // Return cached ID if available
    if (this.deviceId) {
      return this.deviceId;
    }

    // Deduplicate concurrent calls
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initializeDeviceId();
    return this.initPromise;
  }

  /**
   * Get the device ID synchronously (may return null if not initialized).
   * Use getDeviceId() for guaranteed result.
   */
  getDeviceIdSync(): string | null {
    if (this.deviceId) return this.deviceId;

    // Check localStorage directly
    const storedId = localStorage.getItem(DEVICE_ID_KEY);
    if (storedId) {
      this.deviceId = storedId;
    }
    return this.deviceId;
  }

  /**
   * Initialize device ID: load from storage or generate new.
   */
  private async initializeDeviceId(): Promise<string> {
    // Check localStorage first
    let id = localStorage.getItem(DEVICE_ID_KEY);

    if (id) {
      // Existing device - update last seen
      this.deviceId = id;
      updateDeviceIdHeader(id);

      if (isSupabaseConfigured()) {
        this.updateLastSeen(id).catch(console.warn);
      }

      return id;
    }

    // Generate new device ID
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    this.deviceId = id;

    // Update Supabase client header
    updateDeviceIdHeader(id);

    // Register with Supabase
    if (isSupabaseConfigured()) {
      await this.registerDevice(id);
    }

    return id;
  }

  /**
   * Register a new device with Supabase.
   */
  private async registerDevice(id: string): Promise<void> {
    try {
      const supabase = getSupabase();

      const { error } = await supabase.from('devices').insert({
        id,
        platform: this.getPlatform(),
        user_agent: navigator.userAgent.slice(0, 200),
      });

      if (error) {
        // Ignore duplicate key error (device already exists)
        if (!error.message.includes('duplicate key')) {
          console.warn('Failed to register device:', error.message);
        }
      }
    } catch (err) {
      console.warn('Failed to register device:', err);
    }
  }

  /**
   * Update the last_seen_at timestamp for an existing device.
   */
  private async updateLastSeen(id: string): Promise<void> {
    try {
      const supabase = getSupabase();

      // Use RPC function to update last seen
      await supabase.rpc('update_device_last_seen', {
        p_device_id: id,
      });
    } catch (err) {
      // Silently ignore - this is not critical
      console.debug('Failed to update device last seen:', err);
    }
  }

  /**
   * Get platform string from navigator.
   */
  private getPlatform(): string {
    // @ts-expect-error - userAgentData is not in all browsers
    const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
    return platform.toLowerCase();
  }

  /**
   * Check if the device has been initialized.
   */
  isInitialized(): boolean {
    return this.deviceId !== null || localStorage.getItem(DEVICE_ID_KEY) !== null;
  }

  /**
   * Reset device identity (for testing/debugging).
   * Creates a new device ID.
   */
  async reset(): Promise<string> {
    localStorage.removeItem(DEVICE_ID_KEY);
    this.deviceId = null;
    this.initPromise = null;
    return this.getDeviceId();
  }
}

// Export singleton instance
export const deviceIdentity = new DeviceIdentityManager();
