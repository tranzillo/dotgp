import Matter from 'matter-js';
import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';
import type { WallSegment } from '../track/Track';

export type CollisionCallback = (
  carBody: Matter.Body,
  wallBody: Matter.Body,
  normal: Vector2,
  speed: number
) => void;

export class PhysicsEngine {
  private engine: Matter.Engine;
  private world: Matter.World;
  private collisionCallback: CollisionCallback | null = null;

  constructor() {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0 }, // Top-down, no gravity
    });
    this.world = this.engine.world;

    // Lower the resting threshold so restitution actually works
    // Default is 4, which causes collisions to be treated as "resting" and ignore restitution
    // See: https://github.com/liabru/matter-js/issues/394
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Matter.Resolver as any)._restingThresh = 0.001;

    // Collision detection with deterministic ordering
    // Sort collision pairs by body IDs to ensure consistent processing order
    Matter.Events.on(this.engine, 'collisionStart', (event) => {
      if (!this.collisionCallback) return;

      // Filter to car-wall collisions and extract relevant data
      const carWallCollisions: Array<{
        carBody: Matter.Body;
        wallBody: Matter.Body;
        normal: Vector2;
        speed: number;
        sortKey: number;
      }> = [];

      for (const pair of event.pairs) {
        const { bodyA, bodyB, collision } = pair;

        let carBody: Matter.Body | null = null;
        let wallBody: Matter.Body | null = null;
        let normal: Vector2;

        if (bodyA.label === 'car' && bodyB.label === 'wall') {
          carBody = bodyA;
          wallBody = bodyB;
          normal = new Vector2(collision.normal.x, collision.normal.y);
        } else if (bodyB.label === 'car' && bodyA.label === 'wall') {
          carBody = bodyB;
          wallBody = bodyA;
          normal = new Vector2(-collision.normal.x, -collision.normal.y);
        } else {
          continue;
        }

        // Get speed at collision for damage calculation
        const speed = Math.sqrt(
          carBody.velocity.x * carBody.velocity.x +
          carBody.velocity.y * carBody.velocity.y
        );

        // Create deterministic sort key from body IDs
        // This ensures collisions are processed in the same order every run
        const sortKey = carBody.id * 1000000 + wallBody.id;

        carWallCollisions.push({ carBody, wallBody, normal, speed, sortKey });
      }

      // Sort by deterministic key to ensure consistent ordering
      carWallCollisions.sort((a, b) => a.sortKey - b.sortKey);

      // Process collisions in deterministic order
      for (const collision of carWallCollisions) {
        this.collisionCallback(collision.carBody, collision.wallBody, collision.normal, collision.speed);
      }
    });
  }

  /**
   * Set callback for car-wall collisions.
   */
  setCollisionCallback(callback: CollisionCallback): void {
    this.collisionCallback = callback;
  }

  update(deltaTime: number): void {
    Matter.Engine.update(this.engine, deltaTime * 1000);
  }

  createCircleBody(x: number, y: number, radius: number, options?: Matter.IBodyDefinition): Matter.Body {
    const body = Matter.Bodies.circle(x, y, radius, {
      frictionAir: CONFIG.FRICTION_AIR,
      friction: 0.1, // High friction to slow down on wall contact
      restitution: 0, // No bounce - wall absorbs normal velocity
      ...options,
    });
    Matter.Composite.add(this.world, body);
    return body;
  }

  removeBody(body: Matter.Body): void {
    Matter.Composite.remove(this.world, body);
  }

  applyForce(body: Matter.Body, force: Vector2): void {
    Matter.Body.applyForce(body, body.position, { x: force.x, y: force.y });
  }

  // applyDrag removed - using Matter.js frictionAir instead

  getPosition(body: Matter.Body): Vector2 {
    return new Vector2(body.position.x, body.position.y);
  }

  getVelocity(body: Matter.Body): Vector2 {
    return new Vector2(body.velocity.x, body.velocity.y);
  }

  setPosition(body: Matter.Body, position: Vector2): void {
    Matter.Body.setPosition(body, { x: position.x, y: position.y });
  }

  setVelocity(body: Matter.Body, velocity: Vector2): void {
    Matter.Body.setVelocity(body, { x: velocity.x, y: velocity.y });
  }

  getSpeed(body: Matter.Body): number {
    return this.getVelocity(body).magnitude();
  }

  getWorld(): Matter.World {
    return this.world;
  }

  getEngine(): Matter.Engine {
    return this.engine;
  }

  /**
   * Create a wall segment between two points.
   * Used for building track boundaries from consecutive points.
   */
  createWallSegment(start: Vector2, end: Vector2, thickness: number = 4): Matter.Body {
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const length = start.distanceTo(end);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);

    const wall = Matter.Bodies.rectangle(midX, midY, length, thickness, {
      isStatic: true,
      label: 'wall',
      restitution: 0, // No bounce - wall absorbs impact
      friction: 0.4, // High friction for wall scraping
    });
    Matter.Body.setAngle(wall, angle);
    Matter.Composite.add(this.world, wall);
    return wall;
  }

  /**
   * Create wall collision bodies from a closed boundary polygon.
   * Each consecutive pair of points becomes a wall segment.
   */
  createWallsFromBoundary(boundary: Vector2[], thickness: number = 4): Matter.Body[] {
    const walls: Matter.Body[] = [];
    for (let i = 0; i < boundary.length; i++) {
      const start = boundary[i];
      const end = boundary[(i + 1) % boundary.length];
      walls.push(this.createWallSegment(start, end, thickness));
    }
    return walls;
  }

  /**
   * Create wall collision bodies from specified segments of a boundary.
   * Only creates walls for the index ranges specified in segments.
   */
  createWallsFromSegments(
    boundary: Vector2[],
    segments: WallSegment[],
    thickness: number = 4
  ): Matter.Body[] {
    const walls: Matter.Body[] = [];

    for (const segment of segments) {
      // Create walls for each point in this segment
      for (let i = segment.startIndex; i <= segment.endIndex; i++) {
        const start = boundary[i];
        const end = boundary[(i + 1) % boundary.length];
        walls.push(this.createWallSegment(start, end, thickness));
      }
    }

    return walls;
  }

  /**
   * Remove wall bodies from the physics world.
   */
  removeWalls(walls: Matter.Body[]): void {
    for (const wall of walls) {
      Matter.Composite.remove(this.world, wall);
    }
  }
}
