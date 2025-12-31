import { Vector2 } from './Vector2';

export class Spline {
  /**
   * Compute a point on a Catmull-Rom spline
   * Uses centripetal parameterization for better curve quality
   */
  static catmullRomPoint(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, t: number): Vector2 {
    const t2 = t * t;
    const t3 = t2 * t;

    const x =
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

    const y =
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

    return new Vector2(x, y);
  }

  /**
   * Generate a smooth closed-loop spline from control points
   * @param points Control points (will be treated as a closed loop)
   * @param segmentsPerPoint Number of interpolated points per segment
   */
  static generateClosedSpline(points: Vector2[], segmentsPerPoint: number = 20): Vector2[] {
    if (points.length < 3) return points;

    const result: Vector2[] = [];
    const n = points.length;

    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];

      for (let j = 0; j < segmentsPerPoint; j++) {
        const t = j / segmentsPerPoint;
        result.push(this.catmullRomPoint(p0, p1, p2, p3, t));
      }
    }

    return result;
  }

  /**
   * Calculate the tangent (derivative) at a point on the spline
   */
  static catmullRomTangent(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, t: number): Vector2 {
    const t2 = t * t;

    const x =
      0.5 *
      ((-p0.x + p2.x) +
        2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t +
        3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t2);

    const y =
      0.5 *
      ((-p0.y + p2.y) +
        2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t +
        3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t2);

    return new Vector2(x, y).normalize();
  }

  /**
   * Generate tangents for a closed spline
   */
  static generateClosedSplineTangents(points: Vector2[], segmentsPerPoint: number = 20): Vector2[] {
    if (points.length < 3) return [];

    const result: Vector2[] = [];
    const n = points.length;

    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];

      for (let j = 0; j < segmentsPerPoint; j++) {
        const t = j / segmentsPerPoint;
        result.push(this.catmullRomTangent(p0, p1, p2, p3, t));
      }
    }

    return result;
  }
}
