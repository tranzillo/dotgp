export class Vector2 {
  constructor(
    public x: number = 0,
    public y: number = 0
  ) {}

  static zero(): Vector2 {
    return new Vector2(0, 0);
  }

  static fromAngle(angle: number, magnitude: number = 1): Vector2 {
    return new Vector2(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
  }

  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  subtract(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(scalar: number): Vector2 {
    return new Vector2(this.x * scalar, this.y * scalar);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  cross(v: Vector2): number {
    return this.x * v.y - this.y * v.x;
  }

  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  magnitudeSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): Vector2 {
    const mag = this.magnitude();
    if (mag === 0) return Vector2.zero();
    return this.scale(1 / mag);
  }

  perpendicular(): Vector2 {
    return new Vector2(-this.y, this.x);
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  angleTo(v: Vector2): number {
    return Math.atan2(v.y - this.y, v.x - this.x);
  }

  distanceTo(v: Vector2): number {
    return this.subtract(v).magnitude();
  }

  distanceSquaredTo(v: Vector2): number {
    // Optimized: avoid creating intermediate Vector2 object
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  lerp(v: Vector2, t: number): Vector2 {
    return new Vector2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
  }

  rotate(angle: number): Vector2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  equals(v: Vector2, epsilon: number = 0.0001): boolean {
    return Math.abs(this.x - v.x) < epsilon && Math.abs(this.y - v.y) < epsilon;
  }

  toString(): string {
    return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }

  // ============================================
  // In-place operations (mutate this, return this)
  // Use these in hot paths to avoid allocations
  // ============================================

  /**
   * Set this vector's values from another vector (in-place)
   */
  setFrom(v: Vector2): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  /**
   * Set this vector's x and y values (in-place)
   */
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  /**
   * Add another vector to this one (in-place)
   */
  addInPlace(v: Vector2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /**
   * Subtract another vector from this one (in-place)
   */
  subtractInPlace(v: Vector2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  /**
   * Scale this vector by a scalar (in-place)
   */
  scaleInPlace(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  /**
   * Normalize this vector (in-place)
   */
  normalizeInPlace(): this {
    const mag = this.magnitude();
    if (mag > 0) {
      this.x /= mag;
      this.y /= mag;
    }
    return this;
  }
}
