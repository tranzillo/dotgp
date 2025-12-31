# Supabase Backend Setup

This directory contains the database migrations for the DotGP cloud backend.

## Quick Start

1. **Create a Supabase project** at [supabase.com](https://supabase.com)

2. **Run migrations** in the Supabase SQL Editor in order:
   - `001_initial_schema.sql` - Creates tables and indexes
   - `002_rls_policies.sql` - Sets up Row Level Security
   - `003_functions.sql` - Creates database functions and triggers
   - `004_storage.sql` - Storage bucket policies (also create bucket manually)

3. **Create storage bucket**:
   - Go to Storage in Supabase dashboard
   - Create a new bucket called `replays`
   - Set it to private (not public)
   - File size limit: 5MB

4. **Configure environment variables**:
   ```bash
   # Copy the example file
   cp .env.example .env

   # Edit .env with your Supabase credentials
   # Found in: Supabase Dashboard > Project Settings > API
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

5. **Start the app**:
   ```bash
   npm run dev
   ```

## Database Schema

### Tables

- **`devices`** - Anonymous device identities (UUID per browser)
- **`replays`** - Replay metadata (frames stored in Storage)
- **`leaderboard_entries`** - Pre-computed rankings (auto-populated)

### Storage

- **Bucket**: `replays`
- **Path format**: `{device_id}/{replay_id}.json.gz`
- **Content**: Gzip-compressed JSON containing frame data

## Architecture

```
[Client IndexedDB]  <---->  [SyncQueue]  ---->  [Supabase]
   (local truth)           (pending)           (cloud)
```

- **Offline-first**: Local IndexedDB is the source of truth
- **Background sync**: Automatically uploads when online
- **Retry logic**: Failed uploads retry up to 3 times

## RLS Policies

All tables use Row Level Security based on the `x-device-id` header:
- Devices can only modify their own data
- Everyone can read all data (for leaderboards/ghost racing)

## Useful Queries

```sql
-- Get leaderboard for a track
SELECT * FROM get_track_leaderboard(12345, 'all', 100, 0);

-- Get player rank
SELECT * FROM get_device_rank(12345, 'device-uuid', 'all');

-- Get track statistics
SELECT * FROM get_track_stats(12345);
```
