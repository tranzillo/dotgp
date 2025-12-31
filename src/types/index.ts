import type { Vector2 } from '../utils/Vector2';

export type ControlMode = 'keyboard' | 'ai';

export interface CarConfig {
  mass: number;
  initialFuel: number;
  fuelConsumptionRate: number;
  initialGrip: number;
  maxHealth: number;
  teamColor: string;
  radius: number;
}

export interface CarState {
  position: Vector2;
  velocity: Vector2;
  previousVelocity: Vector2; // For calculating acceleration
  fuel: number;
  grip: number;
  heat: number; // Current tire heat (0-1), causes grip degradation
  wheelspinHeat: number; // Heat from wheelspin this frame
  turningHeat: number; // Heat from turning effort this frame
  health: number;
  isOnTrack: boolean;
  isInPit: boolean; // Currently in pit zone
  isPitting: boolean; // Actively receiving pit service
  pitTimer: number; // Time remaining in pit stop (seconds)
  controlMode: ControlMode;
  raceState: RaceState;
}

export interface TrackConfig {
  seed: number;
  numControlPoints: number;
  minWidth: number;
  maxWidth: number;
  roughness: number;
}

export interface GameState {
  isRunning: boolean;
  isPaused: boolean;
  elapsedTime: number;
}

// Racing/Timing Types

export interface Sector {
  index: number;
  startTrackIndex: number;
  endTrackIndex: number;
}

export interface SectorTime {
  sectorIndex: number;
  time: number;
  isValid: boolean;
}

export interface LapData {
  lapNumber: number;
  sectorTimes: SectorTime[];
  totalTime: number;
  isValid: boolean;
}

export interface RaceState {
  totalLaps: number;
  currentLap: number;
  currentSector: number;
  sectorStartTime: number;
  lapStartTime: number;
  currentLapValid: boolean;
  laps: LapData[];
  bestLapTime: number;
  offTrackCount: number;
  lastTrackIndex: number;
  isRacing: boolean;
  isWaitingForStart: boolean; // True until player first moves
  sectorsCompleted: boolean[]; // Tracks which sectors have been passed this lap [S0, S1, S2]
}

export interface RaceConfig {
  totalLaps: number;
}
