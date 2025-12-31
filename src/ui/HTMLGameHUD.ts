/**
 * HTMLGameHUD - HTML-based HUD for the game display.
 *
 * Renders header (lap info, resources, track info) and footer (status, controls)
 * as HTML elements instead of canvas rendering. This allows the canvas to scale
 * independently to fill the viewport.
 */

import type { Car } from '../entities/Car';
import type { Track } from '../track/Track';
import type { RaceTimer } from '../race/RaceTimer';
import { CONFIG } from '../utils/Constants';

export interface GameHUDCallbacks {
  onReset: () => void;
  onNewTrack: () => void;
  onGP: () => void;
  onOval: () => void;
  onDirt: () => void;
  onToggleMode: () => void;
}

export class HTMLGameHUD {
  private headerContainer: HTMLElement;
  private footerContainer: HTMLElement;
  private callbacks: GameHUDCallbacks;

  // Header elements
  private speedEl!: HTMLElement;
  private lapEl!: HTMLElement;
  private lapTimeEl!: HTMLElement;
  private modeEl!: HTMLElement;
  private gripBar!: HTMLElement;
  private heatBar!: HTMLElement;
  private fuelBar!: HTMLElement;
  private healthBar!: HTMLElement;
  private sector1El!: HTMLElement;
  private sector2El!: HTMLElement;
  private sector3El!: HTMLElement;
  private bestLapEl!: HTMLElement;
  private lastLapEl!: HTMLElement;
  private trackInfoEl!: HTMLElement;

  // Footer elements
  private trackStatusEl!: HTMLElement;
  private pitStatusEl!: HTMLElement;

  constructor(headerId: string, footerId: string, callbacks: GameHUDCallbacks) {
    const header = document.getElementById(headerId);
    const footer = document.getElementById(footerId);
    if (!header) throw new Error(`Header element #${headerId} not found`);
    if (!footer) throw new Error(`Footer element #${footerId} not found`);

    this.headerContainer = header;
    this.footerContainer = footer;
    this.callbacks = callbacks;

    this.renderHeader();
    this.renderFooter();
    this.bindEvents();
  }

  private renderHeader(): void {
    this.headerContainer.innerHTML = `
      <div class="hud-left">
        <div class="lap-info">
          <span id="hud-speed">Speed: 0</span>
          <span style="margin-left: 20px;" id="hud-lap">Lap 1</span>
          <span style="margin-left: 20px;" id="hud-lap-time" style="color: #fff;">Time: 0.000</span>
        </div>
        <div class="sector-times">
          <span id="hud-sector1">S1: ---.---</span>
          <span id="hud-sector2">S2: ---.---</span>
          <span id="hud-sector3">S3: ---.---</span>
        </div>
        <div class="lap-times-row">
          <span id="hud-best-lap" style="color: #a0f;">Best: --:--.---</span>
          <span id="hud-last-lap" style="color: #888;">Last: --:--.---</span>
        </div>
      </div>
      <div class="hud-center">
        <div class="resource-bars">
          <div class="resource-bar">
            <span class="resource-bar-label">GRIP</span>
            <div class="resource-bar-track">
              <div id="hud-grip-bar" class="resource-bar-fill" style="width: 100%; background: #0f0;"></div>
            </div>
          </div>
          <div class="resource-bar">
            <span class="resource-bar-label">HEAT</span>
            <div class="resource-bar-track">
              <div id="hud-heat-bar" class="resource-bar-fill" style="width: 0%; background: #f60;"></div>
            </div>
          </div>
          <div class="resource-bar">
            <span class="resource-bar-label">FUEL</span>
            <div class="resource-bar-track">
              <div id="hud-fuel-bar" class="resource-bar-fill" style="width: 100%; background: #ff0;"></div>
            </div>
          </div>
          <div class="resource-bar">
            <span class="resource-bar-label">HEALTH</span>
            <div class="resource-bar-track">
              <div id="hud-health-bar" class="resource-bar-fill" style="width: 100%; background: #f44;"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="hud-right">
        <div class="track-info-title">─── TRACK INFO ───</div>
        <div id="hud-track-info"></div>
      </div>
    `;

    // Cache element references
    this.speedEl = document.getElementById('hud-speed')!;
    this.lapEl = document.getElementById('hud-lap')!;
    this.lapTimeEl = document.getElementById('hud-lap-time')!;
    this.gripBar = document.getElementById('hud-grip-bar')!;
    this.heatBar = document.getElementById('hud-heat-bar')!;
    this.fuelBar = document.getElementById('hud-fuel-bar')!;
    this.healthBar = document.getElementById('hud-health-bar')!;
    this.sector1El = document.getElementById('hud-sector1')!;
    this.sector2El = document.getElementById('hud-sector2')!;
    this.sector3El = document.getElementById('hud-sector3')!;
    this.bestLapEl = document.getElementById('hud-best-lap')!;
    this.lastLapEl = document.getElementById('hud-last-lap')!;
    this.trackInfoEl = document.getElementById('hud-track-info')!;
  }

  private renderFooter(): void {
    this.footerContainer.innerHTML = `
      <div class="status-left">
        <div id="hud-track-status" class="track-status on-track">ON TRACK</div>
        <div id="hud-pit-status" class="pit-status"></div>
      </div>
      <div class="controls">
        <span>WASD: move</span>
        <span>|</span>
        <span class="control-btn" data-action="reset">R: reset</span>
        <span>|</span>
        <span class="control-btn" data-action="new_track">N: new</span>
        <span>|</span>
        <span class="control-btn" data-action="gp">G: GP</span>
        <span>|</span>
        <span class="control-btn" data-action="oval">O: oval</span>
        <span>|</span>
        <span class="control-btn" data-action="dirt">V: dirt</span>
        <span>|</span>
        <span class="control-btn" id="hud-mode" data-action="toggle_mode">[KEYBOARD] Tab: toggle</span>
      </div>
    `;

    this.trackStatusEl = document.getElementById('hud-track-status')!;
    this.pitStatusEl = document.getElementById('hud-pit-status')!;
    this.modeEl = document.getElementById('hud-mode')!;
  }

  private bindEvents(): void {
    // Footer control buttons (including mode toggle)
    this.footerContainer.querySelectorAll('.control-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const action = (e.target as HTMLElement).dataset.action;
        switch (action) {
          case 'reset':
            this.callbacks.onReset();
            break;
          case 'new_track':
            this.callbacks.onNewTrack();
            break;
          case 'gp':
            this.callbacks.onGP();
            break;
          case 'oval':
            this.callbacks.onOval();
            break;
          case 'dirt':
            this.callbacks.onDirt();
            break;
          case 'toggle_mode':
            this.callbacks.onToggleMode();
            break;
        }
      });
    });
  }

  update(car: Car, track: Track, raceTimer: RaceTimer): void {
    const raceState = car.state.raceState;

    // Speed and lap
    const speed = Math.round(car.getSpeed() * 50);
    this.speedEl.textContent = `Speed: ${speed}`;

    const lapDisplay = raceState.totalLaps > 0
      ? `Lap ${raceState.currentLap}/${raceState.totalLaps}`
      : `Lap ${raceState.currentLap}`;
    this.lapEl.textContent = lapDisplay;

    // Lap time
    if (raceState.isRacing) {
      const currentLapTime = raceTimer.getCurrentLapTime(car);
      const lapTimeStr = this.formatTime(currentLapTime);
      const validColor = raceState.currentLapValid ? '#fff' : '#f60';
      this.lapTimeEl.textContent = `Time: ${lapTimeStr}`;
      this.lapTimeEl.style.color = validColor;
    } else {
      this.lapTimeEl.textContent = 'Time: 0.000';
      this.lapTimeEl.style.color = '#888';
    }

    // Control mode
    const modeColor = car.state.controlMode === 'ai' ? '#0ff' : '#888';
    this.modeEl.textContent = `[${car.state.controlMode.toUpperCase()}] Tab to toggle`;
    this.modeEl.style.color = modeColor;

    // Resource bars
    this.gripBar.style.width = `${Math.max(0, Math.min(100, car.state.grip * 100))}%`;
    this.heatBar.style.width = `${Math.max(0, Math.min(100, car.state.heat * 100))}%`;
    this.fuelBar.style.width = `${Math.max(0, Math.min(100, (car.state.fuel / car.config.initialFuel) * 100))}%`;
    this.healthBar.style.width = `${Math.max(0, Math.min(100, (car.state.health / car.config.maxHealth) * 100))}%`;

    // Sector times
    this.updateSectorTimes(car, raceTimer);

    // Best and last lap
    if (raceState.bestLapTime < Infinity) {
      this.bestLapEl.textContent = `Best: ${this.formatTime(raceState.bestLapTime)}`;
    } else {
      this.bestLapEl.textContent = 'Best: --:--.---';
    }

    const lastLap = raceTimer.getLastLap(car);
    if (lastLap && lastLap.lapNumber < raceState.currentLap) {
      this.lastLapEl.textContent = `Last: ${this.formatTime(lastLap.totalTime)}`;
      this.lastLapEl.style.color = lastLap.isValid ? '#888' : '#f60';
    } else {
      this.lastLapEl.textContent = 'Last: --:--.---';
      this.lastLapEl.style.color = '#888';
    }

    // Track info
    this.updateTrackInfo(track);

    // Track status (footer)
    if (car.state.isOnTrack) {
      this.trackStatusEl.textContent = 'ON TRACK';
      this.trackStatusEl.className = 'track-status on-track';
    } else {
      this.trackStatusEl.textContent = 'OFF TRACK';
      this.trackStatusEl.className = 'track-status off-track';
    }

    // Pit status
    if (car.state.isPitting) {
      this.pitStatusEl.textContent = `PITTING... ${car.state.pitTimer.toFixed(1)}s`;
    } else if (car.state.isInPit) {
      this.pitStatusEl.textContent = 'IN PIT ZONE - Stop to refuel';
    } else {
      this.pitStatusEl.textContent = '';
    }
  }

  private updateSectorTimes(car: Car, raceTimer: RaceTimer): void {
    const raceState = car.state.raceState;
    const currentLapData = raceState.laps.find(l => l.lapNumber === raceState.currentLap);
    const sectorTimes = currentLapData?.sectorTimes || [];

    const elements = [this.sector1El, this.sector2El, this.sector3El];

    for (let i = 0; i < 3; i++) {
      const sectorTime = sectorTimes.find(s => s.sectorIndex === i);
      let timeStr = '---.---';
      let color = '#666';

      if (sectorTime) {
        timeStr = sectorTime.time.toFixed(3);
        color = sectorTime.isValid ? '#fff' : '#f60';
      } else if (i === raceState.currentSector && raceState.isRacing) {
        const currentSectorTime = raceTimer.getCurrentSectorTime(car);
        timeStr = currentSectorTime.toFixed(3);
        color = raceState.currentLapValid ? '#ff0' : '#f60';
      }

      elements[i].textContent = `S${i + 1}: ${timeStr}`;
      elements[i].style.color = color;
    }
  }

  private updateTrackInfo(track: Track): void {
    const meta = track.metadata;
    let html = '';

    // Track type
    let typeDisplay: string;
    let typeColor: string;
    switch (meta.type) {
      case 'oval':
        typeDisplay = 'OVAL';
        typeColor = '#fa0';
        break;
      default:
        typeDisplay = 'GRAND PRIX';
        typeColor = '#0af';
    }
    html += `<div style="color: ${typeColor}">Type: ${typeDisplay}</div>`;

    if (meta.type === 'oval') {
      const shapeDisplay = meta.ovalShape ? meta.ovalShape.toUpperCase() : 'UNKNOWN';
      html += `<div style="color: #aaa">Shape: ${shapeDisplay}</div>`;

      const sizeDisplay = meta.ovalSizeClass ? meta.ovalSizeClass.toUpperCase() : 'UNKNOWN';
      const sizeColor = meta.ovalSizeClass === 'superspeedway' ? '#f80' :
                        meta.ovalSizeClass === 'speedway' ? '#8f8' : '#88f';
      html += `<div style="color: ${sizeColor}">Class: ${sizeDisplay}</div>`;

      const surfaceDisplay = meta.surfaceType === 'dirt' ? 'DIRT' : 'ASPHALT';
      const surfaceColor = meta.surfaceType === 'dirt' ? CONFIG.COLORS.RALLYCROSS_INFO : '#aaa';
      html += `<div style="color: ${surfaceColor}">Surface: ${surfaceDisplay}</div>`;

      if (meta.surfaceType === 'dirt') {
        const gripPercent = Math.round(CONFIG.DIRT_GRIP_MULTIPLIER * 100);
        html += `<div style="color: #f60">Grip: ${gripPercent}%</div>`;
      }

      const turnPoint = track.trackPoints.find(p => p.banking > 0);
      if (turnPoint) {
        const bankingDeg = (turnPoint.banking * 180 / Math.PI).toFixed(1);
        html += `<div style="color: #aaa">Banking: ${bankingDeg}&deg;</div>`;
      }
    } else {
      const sizeDisplay = meta.gpSizeClass ? meta.gpSizeClass.toUpperCase() : 'UNKNOWN';
      const shapeDisplay = meta.gpTrackShape ? meta.gpTrackShape.toUpperCase() : 'CIRCULAR';
      const sizeColor = meta.gpSizeClass === 'autodrome' ? '#f80' :
                        meta.gpSizeClass === 'circuit' ? '#8f8' : '#88f';
      html += `<div style="color: ${sizeColor}">Class: ${sizeDisplay} (${shapeDisplay})</div>`;

      const trackLength = this.calculateTrackLength(track);
      html += `<div style="color: #aaa">Length: ${(trackLength / 1000).toFixed(2)} km</div>`;
    }

    this.trackInfoEl.innerHTML = html;
  }

  private calculateTrackLength(track: Track): number {
    let length = 0;
    for (let i = 0; i < track.trackPoints.length; i++) {
      const curr = track.trackPoints[i];
      const next = track.trackPoints[(i + 1) % track.trackPoints.length];
      length += curr.position.distanceTo(next.position);
    }
    return length;
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0
      ? `${mins}:${secs.toFixed(3).padStart(6, '0')}`
      : secs.toFixed(3);
  }
}
