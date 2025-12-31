-- DotGP Backend Storage
-- Migration: 004_storage
-- Description: Supabase Storage bucket and policies for replay frame data

-- ============================================================================
-- CREATE STORAGE BUCKET
-- Stores compressed replay frame data (.json.gz files)
-- ============================================================================

-- Note: This needs to be run in the Supabase dashboard or via the API
-- as storage bucket creation isn't supported in SQL migrations directly.
--
-- Bucket configuration:
--   Name: replays
--   Public: false (private bucket)
--   File size limit: 5MB (generous for compressed replay data)
--   Allowed MIME types: application/gzip, application/json

-- ============================================================================
-- STORAGE POLICIES
-- These can be created via SQL in Supabase
-- ============================================================================

-- Allow devices to upload to their own folder
-- Path format: {device_id}/{replay_id}.json.gz
CREATE POLICY "Device can upload own replays"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'replays'
  AND (storage.foldername(name))[1] = coalesce(
    current_setting('request.headers', true)::json->>'x-device-id',
    ''
  )
);

-- Allow devices to update/replace their own files
CREATE POLICY "Device can update own replays"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'replays'
  AND (storage.foldername(name))[1] = coalesce(
    current_setting('request.headers', true)::json->>'x-device-id',
    ''
  )
);

-- Allow devices to delete their own files
CREATE POLICY "Device can delete own replays"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'replays'
  AND (storage.foldername(name))[1] = coalesce(
    current_setting('request.headers', true)::json->>'x-device-id',
    ''
  )
);

-- Allow anyone to download replays (for ghost racing)
CREATE POLICY "Anyone can download replays"
ON storage.objects FOR SELECT
USING (bucket_id = 'replays');
