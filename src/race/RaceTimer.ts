import type { Car } from '../entities/Car';
import type { Track } from '../track/Track';
import type { LapData, SectorTime, RaceConfig } from '../types';
import { SectorManager } from './SectorManager';

export type LapCompleteCallback = (car: Car, lapData: LapData) => void;
export type SectorCompleteCallback = (car: Car, sectorIndex: number, sectorTime: number) => void;
export type RaceStartCallback = () => void;

export class RaceTimer {
  private sectorManager: SectorManager;
  private track: Track;
  private elapsedTime: number = 0;
  private onLapCompleteCallback: LapCompleteCallback | null = null;
  private onSectorCompleteCallback: SectorCompleteCallback | null = null;
  private onRaceStartCallback: RaceStartCallback | null = null;

  constructor(track: Track) {
    this.track = track;
    this.sectorManager = new SectorManager(track);
  }

  /**
   * Set a callback to be invoked when a lap is completed.
   * Used by TimeTrialManager to record lap times.
   */
  setOnLapComplete(callback: LapCompleteCallback): void {
    this.onLapCompleteCallback = callback;
  }

  /**
   * Clear the lap completion callback.
   */
  clearOnLapComplete(): void {
    this.onLapCompleteCallback = null;
  }

  /**
   * Set a callback to be invoked when a sector is completed.
   */
  setOnSectorComplete(callback: SectorCompleteCallback): void {
    this.onSectorCompleteCallback = callback;
  }

  /**
   * Clear the sector completion callback.
   */
  clearOnSectorComplete(): void {
    this.onSectorCompleteCallback = null;
  }

  /**
   * Set a callback to be invoked when the race actually starts (on line crossing).
   */
  setOnRaceStart(callback: RaceStartCallback): void {
    this.onRaceStartCallback = callback;
  }

  /**
   * Clear the race start callback.
   */
  clearOnRaceStart(): void {
    this.onRaceStartCallback = null;
  }

  getSectorManager(): SectorManager {
    return this.sectorManager;
  }

  update(car: Car, deltaTime: number): void {
    const raceState = car.state.raceState;

    // Always update elapsed time for consistent timing
    this.elapsedTime += deltaTime;

    const closestPoint = this.track.getClosestTrackPoint(car.getPosition());
    if (!closestPoint) return;

    const currIndex = closestPoint.index;
    const prevIndex = raceState.lastTrackIndex;

    // First frame initialization
    if (prevIndex < 0) {
      raceState.lastTrackIndex = currIndex;
      raceState.currentSector = this.sectorManager.getSectorForIndex(currIndex);
      return;
    }

    // Check for sector crossing
    const crossing = this.sectorManager.checkSectorCrossing(prevIndex, currIndex);

    // Handle waiting for start - trigger race on crossing into sector 0
    if (raceState.isWaitingForStart) {
      if (crossing.crossed && !crossing.wrongDirection && crossing.sectorEntered === 0) {
        this.beginRace(car);
        raceState.currentSector = 0;
        raceState.sectorsCompleted = [true, false, false]; // Starting in sector 0
      }
      raceState.lastTrackIndex = currIndex;
      return;
    }

    // Not racing yet - skip timing updates
    if (!raceState.isRacing) {
      raceState.lastTrackIndex = currIndex;
      return;
    }

    // Track off-track incidents
    if (!car.state.isOnTrack) {
      // Only count once per off-track excursion
      const wasOnTrack = raceState.lastTrackIndex >= 0;
      if (wasOnTrack) {
        raceState.offTrackCount++;
        raceState.currentLapValid = false;
      }
    }

    if (crossing.crossed && !crossing.wrongDirection) {
      // Mark the sector we just completed (the one before sectorEntered)
      const completedSector = (crossing.sectorEntered + 2) % 3;
      const previousSector = (completedSector + 2) % 3;

      // Sector order validation: only complete a sector if previous was completed
      // Sector 0 can always be completed (it's the start/finish)
      const canCompleteSector = completedSector === 0 || raceState.sectorsCompleted[previousSector];

      if (canCompleteSector) {
        raceState.sectorsCompleted[completedSector] = true;
        this.recordSectorTime(car, crossing.sectorEntered);

        // Crossing into sector 0 means we might have completed a lap
        // Only count it if all sectors were completed in order
        if (crossing.sectorEntered === 0 && raceState.currentLap > 0) {
          // Check that sectors 1 and 2 were completed before crossing finish
          if (raceState.sectorsCompleted[1] && raceState.sectorsCompleted[2]) {
            this.completeLap(car);
          }
        }
      }
      // else: out of order crossing, ignore

      raceState.currentSector = crossing.sectorEntered;
    }

    raceState.lastTrackIndex = currIndex;
  }

  private recordSectorTime(car: Car, sectorEntered: number): void {
    const raceState = car.state.raceState;
    const currentTime = this.elapsedTime;

    // Calculate sector time
    const sectorTime = currentTime - raceState.sectorStartTime;

    // Find current lap data or create new one
    let currentLapData = raceState.laps.find(l => l.lapNumber === raceState.currentLap);
    if (!currentLapData) {
      currentLapData = {
        lapNumber: raceState.currentLap,
        sectorTimes: [],
        totalTime: 0,
        isValid: raceState.currentLapValid,
      };
      raceState.laps.push(currentLapData);
    }

    // Record the sector time for the PREVIOUS sector (that we just completed)
    const completedSector = (sectorEntered + 2) % 3; // Previous sector
    const sectorTimeData: SectorTime = {
      sectorIndex: completedSector,
      time: sectorTime,
      isValid: raceState.currentLapValid,
    };

    // Add or update sector time
    const existingIndex = currentLapData.sectorTimes.findIndex(s => s.sectorIndex === completedSector);
    if (existingIndex >= 0) {
      currentLapData.sectorTimes[existingIndex] = sectorTimeData;
    } else {
      currentLapData.sectorTimes.push(sectorTimeData);
    }

    // Fire sector complete callback
    if (this.onSectorCompleteCallback) {
      this.onSectorCompleteCallback(car, completedSector, sectorTime);
    }

    // Reset sector timer
    raceState.sectorStartTime = currentTime;
  }

  private completeLap(car: Car): void {
    const raceState = car.state.raceState;
    const currentTime = this.elapsedTime;

    // Calculate total lap time
    const lapTime = currentTime - raceState.lapStartTime;

    // Find the lap data
    const lapData = raceState.laps.find(l => l.lapNumber === raceState.currentLap);
    if (lapData) {
      lapData.totalTime = lapTime;
      lapData.isValid = raceState.currentLapValid;

      // Update best lap time if this is a valid lap and faster
      if (lapData.isValid && lapTime < raceState.bestLapTime) {
        raceState.bestLapTime = lapTime;
      }

      // Invoke lap complete callback (for time trial recording)
      if (this.onLapCompleteCallback) {
        this.onLapCompleteCallback(car, lapData);
      }
    }

    // Start new lap
    raceState.currentLap++;
    raceState.lapStartTime = currentTime;
    raceState.sectorStartTime = currentTime;
    raceState.currentLapValid = true; // Reset validity for new lap
    raceState.sectorsCompleted = [true, false, false]; // Reset sectors, starting in sector 0
  }

  startRace(car: Car, config: RaceConfig): void {
    const raceState = car.state.raceState;
    raceState.totalLaps = config.totalLaps;
    raceState.currentLap = 1;
    // Car spawns 15% before start/finish, which is in sector 2
    raceState.currentSector = 2;
    raceState.lapStartTime = this.elapsedTime;
    raceState.sectorStartTime = this.elapsedTime;
    raceState.currentLapValid = true;
    raceState.laps = [];
    raceState.offTrackCount = 0;
    raceState.lastTrackIndex = -1;
    raceState.bestLapTime = Infinity;
    raceState.isRacing = false; // Don't start racing until line crossing
    raceState.isWaitingForStart = true; // Wait for line crossing
    // No sectors completed yet - will complete sector 0 on line crossing
    raceState.sectorsCompleted = [false, false, false];
  }

  /**
   * Begin the actual race timing.
   * Called when car crosses start/finish line.
   */
  beginRace(car: Car): void {
    const raceState = car.state.raceState;
    if (!raceState.isWaitingForStart) return; // Already started

    raceState.isWaitingForStart = false;
    raceState.isRacing = true;
    raceState.lapStartTime = this.elapsedTime;
    raceState.sectorStartTime = this.elapsedTime;
    console.log('Race started!');

    // Notify Game.ts to start lap recording
    if (this.onRaceStartCallback) {
      this.onRaceStartCallback();
    }
  }

  /**
   * Check if waiting for the player to start.
   */
  isWaitingForStart(car: Car): boolean {
    return car.state.raceState.isWaitingForStart;
  }

  stopRace(car: Car): void {
    car.state.raceState.isRacing = false;
  }

  getCurrentLapTime(car: Car): number {
    if (!car.state.raceState.isRacing) return 0;
    return this.elapsedTime - car.state.raceState.lapStartTime;
  }

  getCurrentSectorTime(car: Car): number {
    if (!car.state.raceState.isRacing) return 0;
    return this.elapsedTime - car.state.raceState.sectorStartTime;
  }

  getLastLap(car: Car): LapData | undefined {
    const laps = car.state.raceState.laps;
    if (laps.length === 0) return undefined;
    return laps[laps.length - 1];
  }

  isRaceComplete(car: Car): boolean {
    const raceState = car.state.raceState;
    if (raceState.totalLaps === 0) return false; // Practice mode
    return raceState.currentLap > raceState.totalLaps;
  }

  resetTimer(): void {
    this.elapsedTime = 0;
  }
}
