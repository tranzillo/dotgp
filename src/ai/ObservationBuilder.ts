import type { Car } from '../entities/Car';
import type { Track } from '../track/Track';
import type { Observation } from './types';

const MAX_SPEED = 15; // Approximate max speed for normalization
const LOOKAHEAD_POINTS = 5;
const LOOKAHEAD_DISTANCE = 30; // Track points to look ahead

export class ObservationBuilder {
  /**
   * Build a normalized observation from the current game state.
   * Returns a flat array of features suitable for neural network input.
   */
  build(car: Car, track: Track): Observation {
    const features: number[] = [];

    const pos = car.getPosition();
    const vel = car.getVelocity();
    const speed = car.getSpeed();

    // Get track info at current position
    const closestPoint = track.getClosestTrackPoint(pos);
    if (!closestPoint) {
      // Fallback if no track point found
      return { features: new Array(this.getObservationSize()).fill(0) };
    }

    const trackPoint = closestPoint.trackPoint;
    const trackIndex = closestPoint.index;

    // 1. Speed (normalized 0-1)
    features.push(Math.min(1, speed / MAX_SPEED));

    // 2. Heading angle relative to track direction (-1 to 1)
    const headingAngle = this.calculateHeadingAngle(vel, trackPoint.tangent);
    features.push(headingAngle);

    // 3. Track progress (0-1)
    const progress = track.getTrackProgress(pos);
    features.push(progress);

    // 4. Distance to centerline (normalized, -1 left to 1 right)
    const distanceToCenter = this.calculateCenterlineOffset(
      pos,
      trackPoint.position,
      trackPoint.normal,
      trackPoint.width
    );
    features.push(distanceToCenter);

    // 5. Velocity components (normalized -1 to 1)
    features.push(Math.max(-1, Math.min(1, vel.x / MAX_SPEED)));
    features.push(Math.max(-1, Math.min(1, vel.y / MAX_SPEED)));

    // 6. Track direction (tangent) - tells agent which way to go!
    // NEGATED: The spline tangent points toward decreasing progress (CCW in math coords).
    // We negate to point toward INCREASING progress (the direction we want to go).
    features.push(-trackPoint.tangent.x);
    features.push(-trackPoint.tangent.y);

    // 7. Target direction - weighted average of upcoming tangents
    // Also negated to point toward increasing progress
    const targetDir = this.calculateTargetDirection(track, trackIndex);
    features.push(-targetDir.x);
    features.push(-targetDir.y);

    // 8. Upcoming curvature (5 lookahead points)
    const curvatures = this.getLookaheadCurvature(track, trackIndex, LOOKAHEAD_POINTS);
    features.push(...curvatures);

    // 9. Resources
    features.push(car.state.grip); // 0-1
    features.push(car.state.fuel / 100); // Normalize to 0-1
    features.push(car.state.isOnTrack ? 1 : 0);

    // 10. Distance to track edges (normalized 0-1)
    const edgeDistances = this.calculateEdgeDistances(
      pos,
      trackPoint.position,
      trackPoint.normal,
      trackPoint.width
    );
    features.push(edgeDistances.left);
    features.push(edgeDistances.right);

    return { features };
  }

  getObservationSize(): number {
    // speed + heading + progress + centerOffset + velocity(2) + trackDir(2) + targetDir(2) + curvature(5) + resources(3) + edges(2)
    return 1 + 1 + 1 + 1 + 2 + 2 + 2 + LOOKAHEAD_POINTS + 3 + 2; // 20 features
  }

  /**
   * Calculate heading angle relative to track direction.
   * Returns -1 (facing backward) to 1 (facing forward).
   */
  private calculateHeadingAngle(velocity: { x: number; y: number }, trackTangent: { x: number; y: number }): number {
    const velMag = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
    if (velMag < 0.1) return 0; // Stationary, no heading

    // Dot product with NEGATED tangent (raw tangent points toward decreasing progress)
    // Negating makes positive alignment = going the right way
    const dot = -(velocity.x * trackTangent.x + velocity.y * trackTangent.y) / velMag;
    return Math.max(-1, Math.min(1, dot));
  }

  /**
   * Calculate offset from centerline.
   * Returns -1 (full left) to 1 (full right).
   */
  private calculateCenterlineOffset(
    carPos: { x: number; y: number },
    centerPos: { x: number; y: number },
    normal: { x: number; y: number },
    trackWidth: number
  ): number {
    // Vector from center to car
    const dx = carPos.x - centerPos.x;
    const dy = carPos.y - centerPos.y;

    // Project onto normal to get signed offset
    const offset = dx * normal.x + dy * normal.y;

    // Normalize by half width
    const halfWidth = trackWidth / 2;
    return Math.max(-1, Math.min(1, offset / halfWidth));
  }

  /**
   * Calculate target direction - weighted average of upcoming track tangents.
   * This tells the agent where it SHOULD be heading, accounting for upcoming curves.
   * Closer points have more weight than farther points.
   */
  private calculateTargetDirection(track: Track, currentIndex: number): { x: number; y: number } {
    const trackLength = track.trackPoints.length;
    let totalX = 0;
    let totalY = 0;
    let totalWeight = 0;

    // Sample upcoming track points with decreasing weights
    const sampleDistances = [10, 30, 60, 100, 150]; // Track point indices ahead
    const weights = [1.0, 0.7, 0.4, 0.2, 0.1]; // Decreasing weights for further points

    for (let i = 0; i < sampleDistances.length; i++) {
      const lookaheadIndex = (currentIndex + sampleDistances[i]) % trackLength;
      const tangent = track.trackPoints[lookaheadIndex].tangent;
      const weight = weights[i];

      totalX += tangent.x * weight;
      totalY += tangent.y * weight;
      totalWeight += weight;
    }

    // Normalize to unit vector
    const avgX = totalX / totalWeight;
    const avgY = totalY / totalWeight;
    const magnitude = Math.sqrt(avgX * avgX + avgY * avgY);

    if (magnitude < 0.001) {
      // Fallback to current tangent if calculation fails
      return track.trackPoints[currentIndex].tangent;
    }

    return { x: avgX / magnitude, y: avgY / magnitude };
  }

  /**
   * Get curvature values at lookahead points along the track.
   * Returns array of values from -1 (sharp left) to 1 (sharp right).
   */
  private getLookaheadCurvature(track: Track, currentIndex: number, count: number): number[] {
    const curvatures: number[] = [];
    const trackLength = track.trackPoints.length;

    for (let i = 0; i < count; i++) {
      const lookaheadIndex = (currentIndex + (i + 1) * LOOKAHEAD_DISTANCE) % trackLength;
      const curvature = this.calculateCurvatureAtIndex(track, lookaheadIndex);
      curvatures.push(curvature);
    }

    return curvatures;
  }

  /**
   * Calculate curvature at a track index.
   * Uses the change in tangent direction.
   */
  private calculateCurvatureAtIndex(track: Track, index: number): number {
    const trackLength = track.trackPoints.length;
    const prevIndex = (index - 5 + trackLength) % trackLength;
    const nextIndex = (index + 5) % trackLength;

    const prevTangent = track.trackPoints[prevIndex].tangent;
    const nextTangent = track.trackPoints[nextIndex].tangent;

    // Cross product gives signed curvature
    const cross = prevTangent.x * nextTangent.y - prevTangent.y * nextTangent.x;

    // Scale and clamp
    return Math.max(-1, Math.min(1, cross * 10));
  }

  /**
   * Calculate distances to left and right track edges.
   */
  private calculateEdgeDistances(
    carPos: { x: number; y: number },
    centerPos: { x: number; y: number },
    normal: { x: number; y: number },
    trackWidth: number
  ): { left: number; right: number } {
    const dx = carPos.x - centerPos.x;
    const dy = carPos.y - centerPos.y;
    const offset = dx * normal.x + dy * normal.y;
    const halfWidth = trackWidth / 2;

    // Positive offset = towards positive normal (right side)
    const distRight = (halfWidth - offset) / trackWidth;
    const distLeft = (halfWidth + offset) / trackWidth;

    return {
      left: Math.max(0, Math.min(1, distLeft)),
      right: Math.max(0, Math.min(1, distRight)),
    };
  }
}
