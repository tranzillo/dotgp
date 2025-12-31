import { Vector2 } from '../utils/Vector2';
import type { Car } from '../entities/Car';
import { CONFIG } from '../utils/Constants';

export interface SkidPoint {
  position: Vector2;
  heat: number; // 0-1, intensity of tire stress at this moment
  radius: number; // width of the mark
}

// Bucket for batching segments with similar opacity/width
interface RenderBucket {
  alpha: number;
  width: number;
  segments: Array<{ prevX: number; prevY: number; currX: number; currY: number }>;
}

// Number of opacity buckets for batching (more = finer gradients, fewer = better perf)
const NUM_OPACITY_BUCKETS = 10;
// Number of width buckets for batching
const NUM_WIDTH_BUCKETS = 5;

export class SkidMarkRenderer {
  private trails: Map<Car, SkidPoint[]> = new Map();
  private maxTrailLength = 5000; // Reduced from 10000 - still plenty of history

  // Pre-allocated buckets to avoid per-frame allocations
  // Indexed by [opacityBucket * NUM_WIDTH_BUCKETS + widthBucket]
  private buckets: RenderBucket[] = [];

  constructor() {
    // Pre-allocate render buckets
    for (let o = 0; o < NUM_OPACITY_BUCKETS; o++) {
      for (let w = 0; w < NUM_WIDTH_BUCKETS; w++) {
        this.buckets.push({
          alpha: 0,
          width: 0,
          segments: [],
        });
      }
    }
  }

  /**
   * Record a new point in the car's trail
   */
  addPoint(car: Car, heat: number): void {
    if (!this.trails.has(car)) {
      this.trails.set(car, []);
    }

    const trail = this.trails.get(car)!;
    const position = car.getPosition().clone();

    // Only add point if we've moved enough from last point
    if (trail.length > 0) {
      const lastPoint = trail[trail.length - 1];
      if (position.distanceSquaredTo(lastPoint.position) < 4) {
        return; // Too close, skip
      }
    }

    trail.push({
      position,
      heat: Math.min(1, Math.max(0, heat)),
      radius: CONFIG.CAR_RADIUS,
    });

    // Trim old points if too long
    if (trail.length > this.maxTrailLength) {
      trail.shift();
    }
  }

  /**
   * Render all skid marks for a car using batched draw calls
   */
  render(ctx: CanvasRenderingContext2D, car: Car): void {
    const trail = this.trails.get(car);
    if (!trail || trail.length < 2) return;

    // Clear all buckets
    for (const bucket of this.buckets) {
      bucket.segments.length = 0;
    }

    // Min/max width for bucketing
    const minWidth = CONFIG.CAR_RADIUS * 0.3;
    const maxWidth = CONFIG.CAR_RADIUS;
    const widthRange = maxWidth - minWidth;

    // First pass: bucket all segments by opacity and width
    for (let i = 1; i < trail.length; i++) {
      const prev = trail[i - 1];
      const curr = trail[i];

      // Skip very low heat segments (nearly invisible anyway)
      if (curr.heat < 0.02) continue;

      // Heat determines opacity: low heat = nearly invisible, high heat = visible
      // Using exponential curve for more dramatic difference
      const alpha = Math.pow(curr.heat, 0.7) * 0.6; // Max 60% opacity

      // Width scales slightly with heat too
      const width = curr.radius * (0.3 + curr.heat * 0.7);

      // Determine bucket indices
      const opacityBucket = Math.min(
        NUM_OPACITY_BUCKETS - 1,
        Math.floor(alpha / 0.6 * NUM_OPACITY_BUCKETS)
      );
      const widthBucket = Math.min(
        NUM_WIDTH_BUCKETS - 1,
        Math.floor((width - minWidth) / widthRange * NUM_WIDTH_BUCKETS)
      );

      const bucketIndex = opacityBucket * NUM_WIDTH_BUCKETS + widthBucket;
      const bucket = this.buckets[bucketIndex];

      // Store bucket properties (will be same for all segments in bucket)
      bucket.alpha = (opacityBucket + 0.5) / NUM_OPACITY_BUCKETS * 0.6;
      bucket.width = minWidth + (widthBucket + 0.5) / NUM_WIDTH_BUCKETS * widthRange;

      // Add segment to bucket
      bucket.segments.push({
        prevX: prev.position.x,
        prevY: prev.position.y,
        currX: curr.position.x,
        currY: curr.position.y,
      });
    }

    // Second pass: render each non-empty bucket with a single stroke
    ctx.lineCap = 'round';

    for (const bucket of this.buckets) {
      if (bucket.segments.length === 0) continue;

      // Set style once for entire bucket
      ctx.strokeStyle = `rgba(40, 40, 40, ${bucket.alpha})`;
      ctx.lineWidth = bucket.width;

      // Draw all segments in this bucket with a single path
      ctx.beginPath();
      for (const seg of bucket.segments) {
        ctx.moveTo(seg.prevX, seg.prevY);
        ctx.lineTo(seg.currX, seg.currY);
      }
      ctx.stroke();
    }
  }

  /**
   * Clear all trails
   */
  clear(): void {
    this.trails.clear();
  }

  /**
   * Clear trail for specific car
   */
  clearCar(car: Car): void {
    this.trails.delete(car);
  }

  /**
   * Get trail for a car (for debugging)
   */
  getTrail(car: Car): SkidPoint[] | undefined {
    return this.trails.get(car);
  }
}
