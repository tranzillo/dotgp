import { Vector2 } from '../../utils/Vector2';
import { Spline } from '../../utils/Spline';
import { Track, TrackPoint, PitLane, TrackMetadata } from '../Track';
import { RealTrackDefinition } from './types';

export interface RealTrackGeneratorConfig {
  /** Target canvas width for scaling (default: 1000) */
  targetWidth?: number;
  /** Target canvas height for scaling (default: 800) */
  targetHeight?: number;
  /** Padding around track edges (default: 100) */
  padding?: number;
  /** Multiplier for track width in meters to game units (default: 3.5) */
  widthScale?: number;
  /** Override center X position */
  centerX?: number;
  /** Override center Y position */
  centerY?: number;
}

const DEFAULT_CONFIG: Required<Omit<RealTrackGeneratorConfig, 'centerX' | 'centerY'>> = {
  targetWidth: 2400,
  targetHeight: 2000,
  padding: 200,
  widthScale: 5.0,
};

/**
 * Generator for real-world track profiles.
 * Converts normalized control points into a full Track object
 * using Catmull-Rom spline smoothing.
 */
export class RealTrackGenerator {
  private config: Required<Omit<RealTrackGeneratorConfig, 'centerX' | 'centerY'>> & {
    centerX?: number;
    centerY?: number;
  };
  private definition: RealTrackDefinition;

  constructor(
    definition: RealTrackDefinition,
    config: RealTrackGeneratorConfig = {}
  ) {
    this.definition = definition;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Generate a Track from the real track definition.
   */
  generate(): Track {
    // Step 1: Scale control points to game coordinates
    const scaledControlPoints = this.scaleControlPoints();

    // Step 2: Generate smooth centerline with Catmull-Rom spline
    const segmentsPerPoint = this.definition.segmentsPerPoint ?? 20;
    const positions = scaledControlPoints.map(p => p.position);
    const splineCenterline = Spline.generateClosedSpline(positions, segmentsPerPoint);

    // Step 3: Generate tangents
    const tangents = Spline.generateClosedSplineTangents(positions, segmentsPerPoint);

    // Step 4: Interpolate widths along spline
    const widths = this.interpolateWidths(scaledControlPoints, splineCenterline.length, segmentsPerPoint);

    // Step 5: Create track points
    let trackPoints = this.createTrackPoints(splineCenterline, tangents, widths);

    // Step 6: Smooth width transitions
    trackPoints = this.smoothTransitions(trackPoints);

    // Step 7: Generate boundaries
    const { inner, outer } = this.generateBoundaries(trackPoints);

    // Step 8: Generate pit lane
    const pitLane = this.generatePitLane(trackPoints, segmentsPerPoint);

    // Step 9: Extract centerline
    const centerline = trackPoints.map(p => p.position);

    // Step 10: Create track metadata
    const metadata: TrackMetadata = {
      type: 'grandprix',
      gpSizeClass: 'circuit',
      surfaceType: 'asphalt',
    };

    // Generate a deterministic seed from track ID
    const seed = this.hashString(this.definition.id);

    return new Track(
      centerline,
      trackPoints,
      inner,
      outer,
      seed,
      undefined,  // pitZone (legacy)
      metadata,
      pitLane,
      undefined,  // wallSegments
      undefined,  // curbSegments
      []          // overlapZones
    );
  }

  /**
   * Scale control points from normalized 0-1 to game coordinates.
   */
  private scaleControlPoints(): { position: Vector2; width: number }[] {
    const { targetWidth, targetHeight, padding, widthScale } = this.config;

    return this.definition.controlPoints.map(cp => ({
      position: new Vector2(
        padding + cp.x * targetWidth,
        padding + cp.y * targetHeight
      ),
      width: (cp.width ?? this.definition.defaultWidth) * widthScale,
    }));
  }

  /**
   * Interpolate widths smoothly between control points.
   */
  private interpolateWidths(
    controlPoints: { position: Vector2; width: number }[],
    _totalPoints: number,
    segmentsPerPoint: number
  ): number[] {
    const widths: number[] = [];
    const n = controlPoints.length;

    for (let i = 0; i < n; i++) {
      const currentWidth = controlPoints[i].width;
      const nextWidth = controlPoints[(i + 1) % n].width;

      for (let j = 0; j < segmentsPerPoint; j++) {
        const t = j / segmentsPerPoint;
        // Smooth cubic interpolation (smoothstep)
        const smoothT = t * t * (3 - 2 * t);
        widths.push(currentWidth * (1 - smoothT) + nextWidth * smoothT);
      }
    }

    return widths;
  }

  /**
   * Create TrackPoint array from centerline, tangents, and widths.
   */
  private createTrackPoints(
    centerline: Vector2[],
    tangents: Vector2[],
    widths: number[]
  ): TrackPoint[] {
    const defaultWidth = this.definition.defaultWidth * this.config.widthScale;

    return centerline.map((position, i) => {
      const tangent = tangents[i] ?? new Vector2(1, 0);
      const normal = tangent.perpendicular();
      return {
        position,
        width: widths[i] ?? defaultWidth,
        tangent,
        normal,
        banking: 0,  // Real GP tracks typically don't have banking
      };
    });
  }

  /**
   * Smooth width transitions using a moving average.
   */
  private smoothTransitions(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 5) return points;

    const windowSize = Math.min(8, Math.floor(points.length / 10));
    if (windowSize < 2) return points;

    const smoothed: TrackPoint[] = [];

    for (let i = 0; i < points.length; i++) {
      let widthSum = 0;
      let count = 0;

      for (let j = -windowSize; j <= windowSize; j++) {
        const idx = (i + j + points.length) % points.length;
        widthSum += points[idx].width;
        count++;
      }

      smoothed.push({
        ...points[i],
        width: widthSum / count,
      });
    }

    return smoothed;
  }

  /**
   * Generate inner and outer boundary points from track points.
   */
  private generateBoundaries(trackPoints: TrackPoint[]): { inner: Vector2[]; outer: Vector2[] } {
    const inner: Vector2[] = [];
    const outer: Vector2[] = [];

    for (const point of trackPoints) {
      const halfWidth = point.width / 2;
      inner.push(point.position.add(point.normal.scale(halfWidth)));
      outer.push(point.position.add(point.normal.scale(-halfWidth)));
    }

    return { inner, outer };
  }

  /**
   * Generate pit lane polygon.
   */
  private generatePitLane(trackPoints: TrackPoint[], segmentsPerPoint: number): PitLane {
    const pitWidth = 50;
    const pitGap = 5;

    // Calculate pit lane indices from control point indices
    const pitStartIdx = (this.definition.pitLane.startIndex * segmentsPerPoint) % trackPoints.length;
    const pitEndIdx = (this.definition.pitLane.endIndex * segmentsPerPoint) % trackPoints.length;

    // Determine which side is "inside" based on track center
    const trackCenter = this.getTrackCenter(trackPoints);
    const samplePoint = trackPoints[pitStartIdx];
    const toCenter = trackCenter.subtract(samplePoint.position);
    const insideSign = this.definition.pitLane.side === 'inside'
      ? Math.sign(toCenter.dot(samplePoint.normal))
      : -Math.sign(toCenter.dot(samplePoint.normal));

    const innerEdgePoints: Vector2[] = [];
    const outerEdgePoints: Vector2[] = [];

    // Walk from pit start to pit end (handling wrap-around)
    let idx = pitStartIdx;
    const maxIterations = trackPoints.length;
    let iterations = 0;

    while (iterations < maxIterations) {
      const point = trackPoints[idx];
      const halfWidth = point.width / 2;

      innerEdgePoints.push(
        point.position.add(point.normal.scale(insideSign * (halfWidth + pitGap)))
      );
      outerEdgePoints.push(
        point.position.add(point.normal.scale(insideSign * (halfWidth + pitGap + pitWidth)))
      );

      if (idx === pitEndIdx) break;
      idx = (idx + 1) % trackPoints.length;
      iterations++;
    }

    // Create closed polygon
    const polygon = [...innerEdgePoints, ...outerEdgePoints.reverse()];
    const center = this.calculatePolygonCenter(polygon);

    return { polygon, center };
  }

  /**
   * Get the geometric center of the track.
   */
  private getTrackCenter(trackPoints: TrackPoint[]): Vector2 {
    let sumX = 0, sumY = 0;
    for (const p of trackPoints) {
      sumX += p.position.x;
      sumY += p.position.y;
    }
    return new Vector2(sumX / trackPoints.length, sumY / trackPoints.length);
  }

  /**
   * Calculate the center of a polygon.
   */
  private calculatePolygonCenter(polygon: Vector2[]): Vector2 {
    let sumX = 0, sumY = 0;
    for (const p of polygon) {
      sumX += p.x;
      sumY += p.y;
    }
    return new Vector2(sumX / polygon.length, sumY / polygon.length);
  }

  /**
   * Generate a deterministic hash from a string.
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  /**
   * Static helper to generate a real track by definition.
   */
  static generate(definition: RealTrackDefinition, config?: RealTrackGeneratorConfig): Track {
    const generator = new RealTrackGenerator(definition, config);
    return generator.generate();
  }
}
