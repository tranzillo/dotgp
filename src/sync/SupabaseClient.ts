/**
 * Supabase Client
 *
 * Initializes and provides access to the Supabase client.
 * Handles configuration and device ID header injection.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Environment variables (set via .env file, loaded by Vite)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Device ID key in localStorage (shared with DeviceIdentity)
const DEVICE_ID_KEY = 'dotgp_device_id';

let supabaseInstance: SupabaseClient | null = null;

/**
 * Check if Supabase is configured.
 * Returns false if environment variables are missing.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Get the Supabase client instance.
 * Creates the client on first call (singleton pattern).
 *
 * @throws Error if Supabase is not configured
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseInstance) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error(
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.'
      );
    }

    // Get device ID from localStorage (may not exist yet)
    const deviceId = localStorage.getItem(DEVICE_ID_KEY) || '';

    supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // We use device ID, not Supabase auth sessions
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          // Custom header for RLS policies
          'x-device-id': deviceId,
        },
      },
    });
  }

  return supabaseInstance;
}

/**
 * Update the device ID header on the Supabase client.
 * Called after device ID is generated/retrieved.
 */
export function updateDeviceIdHeader(deviceId: string): void {
  if (!supabaseInstance) return;

  // Supabase client doesn't have a direct way to update headers after creation,
  // so we need to recreate the client. This should only happen once on startup.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-device-id': deviceId,
      },
    },
  });
}

/**
 * Get the Supabase URL for display purposes (e.g., status UI).
 */
export function getSupabaseUrl(): string | undefined {
  return SUPABASE_URL;
}
