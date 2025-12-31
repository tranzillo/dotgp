# DotGP - Claude Code Context

> 2D top-down physics-based motorsport simulation with F1 broadcast aesthetic

## Project Vision

A minimalistic F1 track map visualization for a 2D top-down racing simulation where physics-based resource management creates emergent racing behavior. Cars are dots, not player-controlled - the goal is to train AI agents to race.

**Key distinction**: Unlike F1 broadcast maps (1D position on a curved line), this is full 2D positional physics across a track surface with varying widths.

---

## Current Implementation Status

### Completed (Phases 1-4)
- [x] Project setup (TypeScript, Vite, Matter.js)
- [x] Physics engine with custom drag (velocity-squared air resistance)
- [x] Procedural track generation (Catmull-Rom splines, variable width)
- [x] Track rendering (F1 minimal aesthetic - white outlines on dark)
- [x] Off-track detection
- [x] Canvas auto-sizing to fit any track
- [x] Tire heat system (lateral acceleration detection)
- [x] Skid mark trails (heat-based opacity)
- [x] Grip degradation from heat
- [x] Grip affects lateral acceleration (low grip = harder to turn)
- [x] Fuel consumption on acceleration
- [x] Pit stops (zone near start, stop to refuel + restore grip)
- [x] Basic UI (speed, grip, heat, fuel, health bars, pit status)

### In Progress
- [ ] AI path-following controller (Phase 5)

---

## Core Physics Concepts

### Movement
- Cars are dots that can accelerate in any direction
- Air resistance limits max speed: `F_drag = -k * v * |v|`
- Must overcome momentum to change direction (simulates turning)

### Unified Friction System (THE CORE MECHANIC)

Friction is a unified concept affecting both speed AND tire wear:

**1. Surface Friction (Rolling Resistance)**
```
F_surface = -μ × speed
- On-track: Low resistance (smooth asphalt)
- Off-track: High resistance (gravel trap - slows car down)
```

**2. Sliding Friction (Cornering)**
```
F_slide = -μ × lateral_velocity × grip
- Lateral movement creates friction opposing motion
- Worn tires = less friction = less control AND less braking
```

**3. Heat from Friction Power**
```
heat = friction_force × speed (power dissipation)
```
- Correlates with skid mark intensity
- Causes grip degradation
- The "graphite pencil" metaphor: aggressive driving leaves marks and uses grip faster

**Key insight**: Grip limits available friction. Worn tires can't generate as much friction, meaning less control AND less stopping power.

### Powertrain Simulation

Realistic acceleration with diminishing returns at speed:

**1. Power Curve**
```
Force = Power / (velocity + ε)
```
- High force at low speed (engine torque)
- Diminishing returns at high speed
- Terminal velocity where power = drag

**2. Traction Limit**
```
Max Force = grip × TRACTION_COEFFICIENT
```
- Grip caps maximum applicable force
- Worn tires = less traction = slower acceleration

**3. Wheelspin**
```
If engineForce > tractionLimit × threshold → Wheelspin!
```
- Over-throttling at low speed/low grip causes wheelspin
- Generates extra heat → faster grip degradation
- Visual: increased heat = darker skid marks

**4. Power Split (Turning)**
```
Forward Force = power × alignment with velocity
Lateral Force = power × (1 - alignment) × grip
```
- Power splits between forward thrust and turning
- Turning is grip-limited

### Implemented Resources
- **Grip**: Limits max friction, degrades with heat, refreshed at pit stop
- **Fuel**: Consumed on acceleration, empty = no acceleration, refreshed at pit stop
- **Health**: Tracked but damage system not yet implemented

---

## Key Files

| File | Purpose |
|------|---------|
| `src/game/Game.ts` | Main game loop, integrates all systems |
| `src/entities/Car.ts` | Car physics, heat calculation, state |
| `src/track/TrackGenerator.ts` | Procedural closed-loop track generation |
| `src/track/Track.ts` | Track data structure, boundary detection |
| `src/rendering/Renderer.ts` | Canvas rendering coordinator |
| `src/rendering/SkidMarkRenderer.ts` | Heat-based trail visualization |
| `src/utils/Constants.ts` | All tuning parameters |
| `src/physics/PhysicsEngine.ts` | Matter.js wrapper |

---

## Controls

| Key | Action |
|-----|--------|
| WASD / Arrows | Accelerate car |
| R | Reset car position |
| N | Generate new track |
| D | Toggle debug view |
| Tab | Toggle AI mode (placeholder) |

---

## Tuning Constants (src/utils/Constants.ts)

**Powertrain:**
- `ENGINE_POWER`: 0.005 (power output)
- `TRACTION_COEFFICIENT`: 0.001 (max force per unit grip)
- `WHEELSPIN_THRESHOLD`: 1.2 (20% over traction = wheelspin)
- `WHEELSPIN_HEAT_MULTIPLIER`: 3.0 (heat penalty)
- `POWER_EPSILON`: 0.1 (prevents division by zero)
- `BASE_DRAG_COEFFICIENT`: 0.000001 (air resistance)

**Terminal Velocity:** `v_max = ∛(ENGINE_POWER / BASE_DRAG_COEFFICIENT)`

**Friction:**
- `TRACK_SURFACE_FRICTION`: 0.0005 (low - smooth asphalt)
- `OFF_TRACK_SURFACE_FRICTION`: 0.004 (high - gravel trap)
- `SLIDE_FRICTION_COEFF`: 0.008 (cornering speed loss)

**Grip:**
- `GRIP_DEGRADATION_RATE`: 0.0001
- `MIN_GRIP`: 0.3

**Track:** minRadius 420, maxRadius 640, width 28-45

---

## Architecture Decisions

1. **Matter.js for physics, custom for friction**: Matter.js handles momentum/collisions, friction/heat is custom overlay
2. **Unified friction model**: Surface friction + sliding friction both slow car AND generate heat
3. **Grip limits friction**: Worn tires = less friction available = less control AND less braking
4. **Skid marks as visual history**: Opacity correlates with friction power dissipation
5. **Procedural tracks**: Convex hull + midpoint displacement + Catmull-Rom smoothing
6. **Canvas auto-sizing**: Track generates at safe positive coordinates, canvas fits to bounds

---

## Next Steps (Priority Order)

1. **AI Controller**: Path-following agent using track centerline + lookahead
2. **Multiple cars**: Basic multi-agent simulation
3. **Collision damage**: Car-to-car and car-to-barrier impacts
4. **Lap timing**: Track lap progress and timing

---

## Running the Project

```bash
npm install
npm run dev
# Opens http://localhost:5173
```

---

## Design Philosophy

The simulation creates emergent racing behavior through resource constraints:
- Grip is finite → must manage tire usage
- Fuel is finite → must balance speed vs conservation
- Health is finite → must avoid collisions
- Pit stops trade time for resources

No scripted racing lines - optimal behavior emerges from physics and resource management.
