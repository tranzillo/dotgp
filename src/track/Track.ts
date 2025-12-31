import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';

export interface TrackPoint {
  position: Vector2;
  width: number;
  tangent: Vector2;
  normal: Vector2;
  banking: number; // Banking angle in radians (0 = flat, positive = banked)
}

export type TrackType = 'grandprix' | 'oval' | 'real';
export type OvalShape = 'elliptical' | 'trioval' | 'triangle' | 'square' | 'egg' | 'paperclip';
export type OvalSizeClass = 'short' | 'speedway' | 'superspeedway';
export type GPSizeClass = 'park' | 'circuit' | 'autodrome';
export type GPTrackShape = 'circular' | 'elongated';
export type SurfaceType = 'asphalt' | 'dirt';

export interface TrackMetadata {
  type: TrackType;
  ovalShape?: OvalShape;
  ovalSizeClass?: OvalSizeClass;
  gpSizeClass?: GPSizeClass;
  gpTrackShape?: GPTrackShape;
  surfaceType?: SurfaceType;
}

export interface PitZone {
  position: Vector2; // Center of pit zone
  width: number;
  length: number;
  angle: number; // Rotation in radians
}

export interface PitLane {
  // Polygon points defining the pit area (for rendering and collision)
  polygon: Vector2[];
  // Center position for label placement
  center: Vector2;
}

export interface WallSegment {
  startIndex: number;  // Index into outerBoundary
  endIndex: number;    // Index into outerBoundary (can wrap)
}

export interface CurbSegment {
  startIndex: number;     // Index into trackPoints
  endIndex: number;       // Index (can wrap around)
  curvatureSign: number;  // +1 left turn, -1 right turn (determines apex side)
}

// Polygon covering a track self-intersection zone
export interface OverlapZone {
  polygon: Vector2[];     // Convex hull covering the overlap area
}

// Spatial index cell for fast closest-point queries
interface SpatialCell {
  indices: number[];  // Track point indices that overlap this cell
}

export class Track {
  // Spatial index for O(1) closest track point lookups
  private spatialGrid: Map<string, SpatialCell> = new Map();
  private spatialCellSize: number = 50;  // Pixels per cell
  private spatialMinX: number = 0;
  private spatialMinY: number = 0;
  public readonly centerline: Vector2[];
  public readonly innerBoundary: Vector2[];
  public readonly outerBoundary: Vector2[];
  public readonly trackPoints: TrackPoint[];
  public readonly startFinishLine: { start: Vector2; end: Vector2 };
  public readonly pitZone: PitZone | null;
  public readonly pitLane: PitLane | null;
  public readonly seed: number;
  public readonly metadata: TrackMetadata;
  public readonly wallSegments: WallSegment[];
  public readonly curbSegments: CurbSegment[];
  public readonly overlapZones: OverlapZone[];

  constructor(
    centerline: Vector2[],
    trackPoints: TrackPoint[],
    innerBoundary: Vector2[],
    outerBoundary: Vector2[],
    seed: number,
    pitZone?: PitZone,
    metadata?: TrackMetadata,
    pitLane?: PitLane,
    wallSegments?: WallSegment[],
    curbSegments?: CurbSegment[],
    overlapZones?: OverlapZone[]
  ) {
    this.centerline = centerline;
    this.trackPoints = trackPoints;
    this.innerBoundary = innerBoundary;
    this.outerBoundary = outerBoundary;
    this.seed = seed;
    this.pitZone = pitZone ?? null;
    this.pitLane = pitLane ?? null;
    this.metadata = metadata ?? { type: 'grandprix' };
    this.wallSegments = wallSegments ?? [];
    this.curbSegments = curbSegments ?? [];
    this.overlapZones = overlapZones ?? [];

    // Start/finish line at first track point
    const startPoint = trackPoints[0];
    const halfWidth = startPoint.width / 2;
    this.startFinishLine = {
      start: startPoint.position.add(startPoint.normal.scale(halfWidth)),
      end: startPoint.position.add(startPoint.normal.scale(-halfWidth)),
    };

    // Build spatial index for fast closest-point queries
    this.buildSpatialIndex();
  }

  /**
   * Build spatial hash grid for O(1) closest track point lookups
   */
  private buildSpatialIndex(): void {
    if (this.trackPoints.length === 0) return;

    // Find bounds
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const tp of this.trackPoints) {
      const p = tp.position;
      const hw = tp.width / 2;
      minX = Math.min(minX, p.x - hw);
      minY = Math.min(minY, p.y - hw);
      maxX = Math.max(maxX, p.x + hw);
      maxY = Math.max(maxY, p.y + hw);
    }

    this.spatialMinX = minX;
    this.spatialMinY = minY;

    // Insert each track point into cells it could be closest to
    // We expand by track width to ensure we don't miss any queries
    for (let i = 0; i < this.trackPoints.length; i++) {
      const tp = this.trackPoints[i];
      const p = tp.position;
      // Expand radius to ensure coverage - use max possible track width
      // Cap radius to prevent excessive cell iteration
      const radius = Math.min(tp.width, 500);

      const cellX1 = Math.floor((p.x - radius - minX) / this.spatialCellSize);
      const cellY1 = Math.floor((p.y - radius - minY) / this.spatialCellSize);
      const cellX2 = Math.floor((p.x + radius - minX) / this.spatialCellSize);
      const cellY2 = Math.floor((p.y + radius - minY) / this.spatialCellSize);

      // Safety check: limit cell range to prevent runaway loops
      const cellCountX = cellX2 - cellX1 + 1;
      const cellCountY = cellY2 - cellY1 + 1;
      if (cellCountX > 100 || cellCountY > 100) {
        continue;
      }

      for (let cx = cellX1; cx <= cellX2; cx++) {
        for (let cy = cellY1; cy <= cellY2; cy++) {
          const key = `${cx},${cy}`;
          let cell = this.spatialGrid.get(key);
          if (!cell) {
            cell = { indices: [] };
            this.spatialGrid.set(key, cell);
          }
          cell.indices.push(i);
        }
      }
    }
  }

  /**
   * Get cell key for a world position
   */
  private getSpatialCellKey(x: number, y: number): string {
    const cx = Math.floor((x - this.spatialMinX) / this.spatialCellSize);
    const cy = Math.floor((y - this.spatialMinY) / this.spatialCellSize);
    return `${cx},${cy}`;
  }

  /**
   * Check if a point is on the track surface
   */
  isPointOnTrack(point: Vector2): boolean {
    // Find closest point on centerline and check distance vs track width
    const closest = this.getClosestTrackPoint(point);
    if (!closest) return false;

    const distanceFromCenter = point.distanceTo(closest.trackPoint.position);
    return distanceFromCenter <= closest.trackPoint.width / 2;
  }

  /**
   * Get the closest track point to a world position.
   * Uses spatial index for O(1) average case lookup.
   * @param point World position to query
   * @param lastKnownIndex Optional hint from previous query for sequential optimization
   */
  getClosestTrackPoint(
    point: Vector2,
    lastKnownIndex?: number
  ): { trackPoint: TrackPoint; index: number; distance: number } | null {
    if (this.trackPoints.length === 0) return null;

    // Fast path: if we have a hint, check nearby indices first
    // Cars move smoothly, so the closest point is usually within a few indices
    if (lastKnownIndex !== undefined && lastKnownIndex >= 0 && lastKnownIndex < this.trackPoints.length) {
      const searchRadius = 10;
      let closestIndex = lastKnownIndex;
      let closestDistSq = this.distanceSquaredInline(point, this.trackPoints[lastKnownIndex].position);

      const start = Math.max(0, lastKnownIndex - searchRadius);
      const end = Math.min(this.trackPoints.length - 1, lastKnownIndex + searchRadius);

      for (let i = start; i <= end; i++) {
        const distSq = this.distanceSquaredInline(point, this.trackPoints[i].position);
        if (distSq < closestDistSq) {
          closestDistSq = distSq;
          closestIndex = i;
        }
      }

      // Also check wrap-around for closed track
      if (lastKnownIndex < searchRadius) {
        for (let i = this.trackPoints.length - searchRadius + lastKnownIndex; i < this.trackPoints.length; i++) {
          const distSq = this.distanceSquaredInline(point, this.trackPoints[i].position);
          if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closestIndex = i;
          }
        }
      } else if (lastKnownIndex >= this.trackPoints.length - searchRadius) {
        for (let i = 0; i < searchRadius - (this.trackPoints.length - 1 - lastKnownIndex); i++) {
          const distSq = this.distanceSquaredInline(point, this.trackPoints[i].position);
          if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closestIndex = i;
          }
        }
      }

      return {
        trackPoint: this.trackPoints[closestIndex],
        index: closestIndex,
        distance: Math.sqrt(closestDistSq),
      };
    }

    // Use spatial index for O(1) lookup
    const key = this.getSpatialCellKey(point.x, point.y);
    const cell = this.spatialGrid.get(key);

    if (cell && cell.indices.length > 0) {
      // Search only within this cell
      let closestIndex = cell.indices[0];
      let closestDistSq = this.distanceSquaredInline(point, this.trackPoints[closestIndex].position);

      for (let i = 1; i < cell.indices.length; i++) {
        const idx = cell.indices[i];
        const distSq = this.distanceSquaredInline(point, this.trackPoints[idx].position);
        if (distSq < closestDistSq) {
          closestDistSq = distSq;
          closestIndex = idx;
        }
      }

      return {
        trackPoint: this.trackPoints[closestIndex],
        index: closestIndex,
        distance: Math.sqrt(closestDistSq),
      };
    }

    // Fallback: linear search (shouldn't happen if spatial index is built correctly)
    let closestIndex = 0;
    let closestDistSq = Infinity;

    for (let i = 0; i < this.trackPoints.length; i++) {
      const distSq = this.distanceSquaredInline(point, this.trackPoints[i].position);
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closestIndex = i;
      }
    }

    return {
      trackPoint: this.trackPoints[closestIndex],
      index: closestIndex,
      distance: Math.sqrt(closestDistSq),
    };
  }

  /**
   * Inline distance squared calculation to avoid Vector2 allocation
   */
  private distanceSquaredInline(a: Vector2, b: Vector2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  /**
   * Get track progress (0-1) based on position
   */
  getTrackProgress(point: Vector2): number {
    const closest = this.getClosestTrackPoint(point);
    if (!closest) return 0;
    return closest.index / this.trackPoints.length;
  }

  /**
   * Get surface friction at a point (higher off-track)
   */
  getSurfaceFriction(point: Vector2): number {
    return this.isPointOnTrack(point) ? 1.0 : 0.4;
  }

  /**
   * Get surface grip multiplier at a point.
   * Dirt surfaces have lower grip than asphalt.
   * Returns 1.0 for asphalt, DIRT_GRIP_MULTIPLIER for dirt.
   */
  getSurfaceGripMultiplier(point: Vector2): number {
    if (!this.isPointOnTrack(point)) {
      return 1.0; // Off-track uses separate friction system
    }
    if (this.metadata.surfaceType === 'dirt') {
      return CONFIG.DIRT_GRIP_MULTIPLIER;
    }
    return 1.0;
  }

  /**
   * Get the center of the track (for camera/spawn)
   */
  getCenter(): Vector2 {
    if (this.centerline.length === 0) return Vector2.zero();

    let sumX = 0;
    let sumY = 0;
    for (const p of this.centerline) {
      sumX += p.x;
      sumY += p.y;
    }
    return new Vector2(sumX / this.centerline.length, sumY / this.centerline.length);
  }

  /**
   * Get the bounding box of the track
   * Checks both inner and outer boundaries to get true bounds
   */
  getBounds(): { min: Vector2; max: Vector2 } {
    if (this.outerBoundary.length === 0 && this.innerBoundary.length === 0) {
      return { min: Vector2.zero(), max: Vector2.zero() };
    }

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    // Check both boundaries to get true bounds
    for (const p of this.outerBoundary) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    for (const p of this.innerBoundary) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return { min: new Vector2(minX, minY), max: new Vector2(maxX, maxY) };
  }

  /**
   * Get spawn index - 15% backwards from start/finish for rolling starts.
   * This allows the car to build speed before crossing the start/finish line.
   */
  getSpawnIndex(): number {
    const totalPoints = this.trackPoints.length;
    if (totalPoints === 0) return 0;

    const spawnOffsetPercent = 0.15;
    const offsetPoints = Math.floor(totalPoints * spawnOffsetPercent);
    // Wrap backwards: totalPoints - offset
    return (totalPoints - offsetPoints) % totalPoints;
  }

  /**
   * Get a spawn position on the track (before start/finish for rolling start)
   */
  getSpawnPosition(): Vector2 {
    if (this.trackPoints.length === 0) return Vector2.zero();
    return this.trackPoints[this.getSpawnIndex()].position.clone();
  }

  /**
   * Get the spawn direction (tangent at spawn point).
   * Returns the angle in radians that the car should face.
   * NOTE: The raw spline tangent points toward DECREASING progress,
   * so we negate it to point toward INCREASING progress (the racing direction).
   */
  getSpawnAngle(): number {
    if (this.trackPoints.length === 0) return 0;
    const tangent = this.trackPoints[this.getSpawnIndex()].tangent;
    // Negate tangent to point toward increasing progress (same fix as ObservationBuilder)
    return Math.atan2(-tangent.y, -tangent.x);
  }

  /**
   * Check if a point is inside the pit zone (legacy rectangle-based)
   */
  isPointInPitZone(point: Vector2): boolean {
    // Try new pit lane first
    if (this.pitLane) {
      return this.isPointInPitLane(point);
    }

    // Fall back to legacy pit zone
    if (!this.pitZone) return false;

    // Transform point to pit zone local coordinates
    const dx = point.x - this.pitZone.position.x;
    const dy = point.y - this.pitZone.position.y;

    // Rotate by negative angle to align with pit zone axes
    const cos = Math.cos(-this.pitZone.angle);
    const sin = Math.sin(-this.pitZone.angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    // Check if within rectangle bounds
    const halfWidth = this.pitZone.width / 2;
    const halfLength = this.pitZone.length / 2;

    return (
      Math.abs(localX) <= halfLength && Math.abs(localY) <= halfWidth
    );
  }

  /**
   * Check if a point is inside the pit lane (polygon-based)
   */
  isPointInPitLane(point: Vector2): boolean {
    if (!this.pitLane || this.pitLane.polygon.length < 3) return false;

    return this.isPointInPolygon(point, this.pitLane.polygon);
  }

  /**
   * Check if a point is inside a polygon using ray casting algorithm
   */
  private isPointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;

      if (((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  }

  /**
   * Get banking angle at a specific position on the track.
   * Banking varies linearly across track width: 0 at inside edge, max at outside edge.
   * @param point World position to query
   * @returns Banking angle in radians (0 = flat, positive = banked)
   */
  getBankingAtPosition(point: Vector2): number {
    const closest = this.getClosestTrackPoint(point);
    if (!closest) return 0;

    const trackPoint = closest.trackPoint;
    const maxBanking = trackPoint.banking;

    if (maxBanking === 0) return 0;

    // Calculate lateral offset from centerline
    const toPoint = point.subtract(trackPoint.position);
    const lateralOffset = toPoint.dot(trackPoint.normal);

    // Normalize to track width (-1 = inside edge, +1 = outside edge)
    const halfWidth = trackPoint.width / 2;
    const normalizedOffset = Math.max(-1, Math.min(1, lateralOffset / halfWidth));

    // Banking gradient: 0 at inside edge (negative normal), max at outside edge (positive normal)
    // For counterclockwise ovals, positive normal points outward (higher banking)
    const bankingFactor = (normalizedOffset + 1) / 2; // 0 to 1

    return maxBanking * bankingFactor;
  }

  /**
   * Create a new track with all points translated to minimize empty space.
   * Shifts the track so bounds.min is close to origin (with small padding).
   */
  static translateToOrigin(track: Track, padding: number = 20): Track {
    const bounds = track.getBounds();
    const offsetX = bounds.min.x - padding;
    const offsetY = bounds.min.y - padding;

    // If already close to origin, return unchanged
    if (offsetX < padding && offsetY < padding) {
      return track;
    }

    const offset = new Vector2(offsetX, offsetY);

    // Translate all vector arrays
    const translatePoints = (points: Vector2[]): Vector2[] =>
      points.map(p => p.subtract(offset));

    const translateTrackPoints = (points: TrackPoint[]): TrackPoint[] =>
      points.map(p => ({
        ...p,
        position: p.position.subtract(offset),
      }));

    const newCenterline = translatePoints(track.centerline);
    const newTrackPoints = translateTrackPoints(track.trackPoints);
    const newInnerBoundary = translatePoints(track.innerBoundary);
    const newOuterBoundary = translatePoints(track.outerBoundary);

    // Translate pit zone if present
    let newPitZone: PitZone | undefined;
    if (track.pitZone) {
      newPitZone = {
        ...track.pitZone,
        position: track.pitZone.position.subtract(offset),
      };
    }

    // Translate pit lane if present
    let newPitLane: PitLane | undefined;
    if (track.pitLane) {
      newPitLane = {
        polygon: translatePoints(track.pitLane.polygon),
        center: track.pitLane.center.subtract(offset),
      };
    }

    // Translate overlap zones if present
    let newOverlapZones: OverlapZone[] | undefined;
    if (track.overlapZones.length > 0) {
      newOverlapZones = track.overlapZones.map(zone => ({
        polygon: translatePoints(zone.polygon),
      }));
    }

    return new Track(
      newCenterline,
      newTrackPoints,
      newInnerBoundary,
      newOuterBoundary,
      track.seed,
      newPitZone,
      track.metadata,
      newPitLane,
      track.wallSegments,
      track.curbSegments,
      newOverlapZones
    );
  }
}
