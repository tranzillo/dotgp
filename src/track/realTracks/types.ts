/**
 * Type definitions for real-world track profiles.
 */

/**
 * A control point for defining real track shapes.
 * Uses normalized coordinates (0-1 range) for easy scaling.
 */
export interface RealTrackControlPoint {
  x: number;        // Normalized X (0-1)
  y: number;        // Normalized Y (0-1)
  width: number;    // Track width in meters (will be scaled)
}

/**
 * Corner/section metadata for named areas of the track.
 */
export interface CornerMarker {
  name: string;           // e.g., "Sainte Devote", "Casino Square"
  pointIndex: number;     // Index into control points (approximate)
}

/**
 * Complete real track definition.
 */
export interface RealTrackDefinition {
  /** Unique identifier: "monaco", "spa", etc. */
  id: string;

  /** Display name: "Monaco GP" */
  name: string;

  /** Country name */
  country: string;

  /** Real track length in meters (for reference only) */
  length: number;

  /** Default track width in meters (used if point doesn't specify) */
  defaultWidth: number;

  /**
   * Control points define the track shape.
   * These are passed through Catmull-Rom smoothing.
   * Points should form a closed loop in counterclockwise order.
   */
  controlPoints: RealTrackControlPoint[];

  /** Named corners for potential future UI/annotation */
  corners: CornerMarker[];

  /** Which control point is the start/finish line (0 = first) */
  startFinishIndex: number;

  /** Pit lane configuration */
  pitLane: {
    startIndex: number;   // Control point index where pit entry is
    endIndex: number;     // Control point index where pit exit is
    side: 'inside' | 'outside';
  };

  /** Spline interpolation granularity (default: 20) */
  segmentsPerPoint?: number;
}
