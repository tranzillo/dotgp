/**
 * Compression Utilities
 *
 * Gzip compression/decompression for replay frame data.
 * Uses the browser's native CompressionStream API.
 */

import type { StoredFrameData } from './types';

/**
 * Compress frame data to a gzipped blob.
 * Typically achieves ~80% size reduction.
 *
 * @param frameData - The frame data to compress
 * @returns Compressed blob ready for upload
 */
export async function compressFrameData(frameData: StoredFrameData): Promise<Blob> {
  const json = JSON.stringify(frameData);
  const inputBlob = new Blob([json], { type: 'application/json' });

  // Check if CompressionStream is available (modern browsers)
  if (typeof CompressionStream === 'undefined') {
    // Fallback: return uncompressed JSON
    console.warn('CompressionStream not available, using uncompressed data');
    return inputBlob;
  }

  const stream = inputBlob.stream();
  const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
  return new Response(compressedStream).blob();
}

/**
 * Decompress a gzipped blob to frame data.
 *
 * @param blob - The compressed blob to decompress
 * @returns Decompressed frame data
 */
export async function decompressFrameData(blob: Blob): Promise<StoredFrameData> {
  // Check if DecompressionStream is available
  if (typeof DecompressionStream === 'undefined') {
    // Fallback: assume uncompressed JSON
    console.warn('DecompressionStream not available, assuming uncompressed data');
    const text = await blob.text();
    return JSON.parse(text) as StoredFrameData;
  }

  // Check if blob is gzip compressed (magic bytes: 1f 8b)
  const header = await blob.slice(0, 2).arrayBuffer();
  const headerBytes = new Uint8Array(header);
  const isGzip = headerBytes[0] === 0x1f && headerBytes[1] === 0x8b;

  if (!isGzip) {
    // Not compressed, parse as JSON directly
    const text = await blob.text();
    return JSON.parse(text) as StoredFrameData;
  }

  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text) as StoredFrameData;
}

/**
 * Estimate the size of frame data before compression.
 * Useful for progress indication.
 *
 * @param frameData - The frame data to estimate
 * @returns Estimated size in bytes
 */
export function estimateFrameDataSize(frameData: StoredFrameData): number {
  // Rough estimate: 24 bytes per frame (action only) or 184 bytes (with observation)
  const hasObservations = frameData.frames.length > 0 && frameData.frames[0].observation;
  const perFrame = hasObservations ? 184 : 24;
  const frameSize = frameData.frames.length * perFrame;

  // Add overhead for initial state, rng state, and JSON structure
  const overhead = 2000;

  return frameSize + overhead;
}

/**
 * Check if compression is available in this browser.
 */
export function isCompressionAvailable(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}
