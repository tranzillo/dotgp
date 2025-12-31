/**
 * HTMLTracksPanel - Track generation options UI panel.
 *
 * Provides:
 * - Current track seed display with copy button
 * - Seed input for loading specific tracks
 * - Track type/class/surface/shape configuration
 * - Advanced sliders for all track generation parameters
 * - Generate track button
 */

import { OvalShape, SurfaceType } from '../track/Track';
import {
  SizeClass,
  TimeTrialTrackType,
  FullTrackConfig,
  encodeCompositeSeed,
  decodeCompositeSeed,
} from '../timetrials/types';

/**
 * Extended track generation config with all slider parameters.
 * All numeric parameters are optional - if not provided, they'll be randomized.
 */
export interface TrackGenerationConfig {
  trackType: TimeTrialTrackType;
  sizeClass: SizeClass;
  surfaceType?: SurfaceType;
  ovalShape?: OvalShape;

  // GP parameters
  roughness?: number;
  maxBankingAngle?: number;

  // GP-specific
  numControlPoints?: number;

  // Oval-specific
  straightLength?: number;
  turnRadius?: number;
  trackWidth?: number;
  paperclipEccentricity?: number;
  triOvalAngle?: number;
  doglegIntensity?: number;
}

export interface TracksPanelCallbacks {
  onGenerateTrack: (config: TrackGenerationConfig) => void;
  onLoadTrack: (config: FullTrackConfig) => void;
}

// Dropdown option definitions
const TYPE_OPTIONS = [
  { value: 'gp', label: 'GP' },
  { value: 'oval', label: 'Oval' },
];

const CLASS_OPTIONS: Record<string, { value: string; label: string }[]> = {
  gp: [
    { value: 'park', label: 'Park' },
    { value: 'circuit', label: 'Circuit' },
    { value: 'autodrome', label: 'Autodrome' },
  ],
  oval: [
    { value: 'short', label: 'Short' },
    { value: 'speedway', label: 'Speedway' },
    { value: 'superspeedway', label: 'Superspeedway' },
  ],
};

const SURFACE_OPTIONS = [
  { value: 'asphalt', label: 'Asphalt' },
  { value: 'dirt', label: 'Dirt' },
];

const SHAPE_OPTIONS = [
  { value: 'elliptical', label: 'Elliptical' },
  { value: 'trioval', label: 'Trioval' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'egg', label: 'Egg' },
  { value: 'paperclip', label: 'Paperclip' },
];

/**
 * Slider configuration with min/max ranges per size class.
 * Format: { [sizeClass]: { min, max, step, default } }
 */
interface SliderRanges {
  [sizeClass: string]: { min: number; max: number; step: number; default: number };
}

// GP slider ranges by size class
const GP_ROUGHNESS: SliderRanges = {
  park: { min: 28, max: 50, step: 2, default: 40 },
  circuit: { min: 30, max: 60, step: 2, default: 45 },
  autodrome: { min: 40, max: 60, step: 2, default: 50 },
};

const GP_BANKING: SliderRanges = {
  park: { min: 3, max: 9, step: 1, default: 5 },
  circuit: { min: 7, max: 18, step: 1, default: 12 },
  autodrome: { min: 14, max: 29, step: 1, default: 20 },
};

const GP_CORNERS: SliderRanges = {
  park: { min: 6, max: 8, step: 1, default: 7 },
  circuit: { min: 8, max: 9, step: 1, default: 8 },
  autodrome: { min: 12, max: 14, step: 1, default: 13 },
};

// Oval slider ranges by size class
const OVAL_STRAIGHT: SliderRanges = {
  short: { min: 160, max: 320, step: 10, default: 240 },
  speedway: { min: 350, max: 550, step: 10, default: 450 },
  superspeedway: { min: 600, max: 1000, step: 20, default: 800 },
};

const OVAL_TURN_RADIUS: SliderRanges = {
  short: { min: 120, max: 175, step: 5, default: 150 },
  speedway: { min: 180, max: 320, step: 10, default: 250 },
  superspeedway: { min: 350, max: 600, step: 10, default: 475 },
};

const OVAL_WIDTH: SliderRanges = {
  short: { min: 48, max: 60, step: 2, default: 54 },
  speedway: { min: 65, max: 80, step: 2, default: 72 },
  superspeedway: { min: 90, max: 160, step: 5, default: 125 },
};

const OVAL_BANKING: SliderRanges = {
  short: { min: 6, max: 12, step: 1, default: 9 },
  speedway: { min: 9, max: 17, step: 1, default: 13 },
  superspeedway: { min: 14, max: 31, step: 1, default: 23 },
};

// Shape-specific ranges (not dependent on size class)
const PAPERCLIP_ECCENTRICITY = { min: 1.5, max: 3.0, step: 0.1, default: 2.2 };
const TRIOVAL_ANGLE = { min: 0.5, max: 1.3, step: 0.1, default: 0.9 };
const DOGLEG_INTENSITY = { min: 0.5, max: 1.0, step: 0.1, default: 0.75 };

export class HTMLTracksPanel {
  private container: HTMLElement;
  private callbacks: TracksPanelCallbacks;

  // Seed display and input
  private compositeSeedDisplay!: HTMLSpanElement;
  private trackInfoLabel!: HTMLSpanElement;
  private copyButton!: HTMLButtonElement;
  private seedInput!: HTMLInputElement;
  private loadButton!: HTMLButtonElement;

  // Dropdowns
  private typeSelect!: HTMLSelectElement;
  private classSelect!: HTMLSelectElement;
  private surfaceSelect!: HTMLSelectElement;
  private shapeSelect!: HTMLSelectElement;

  // Containers for conditional visibility
  private surfaceRow!: HTMLElement;
  private shapeRow!: HTMLElement;
  private advancedSection!: HTMLElement;
  private advancedToggle!: HTMLElement;

  // GP sliders
  private gpSlidersContainer!: HTMLElement;
  private gpRoughnessSlider!: HTMLInputElement;
  private gpRoughnessValue!: HTMLSpanElement;
  private gpBankingSlider!: HTMLInputElement;
  private gpBankingValue!: HTMLSpanElement;
  private gpCornersSlider!: HTMLInputElement;
  private gpCornersValue!: HTMLSpanElement;

  // Oval sliders
  private ovalSlidersContainer!: HTMLElement;
  private ovalStraightSlider!: HTMLInputElement;
  private ovalStraightValue!: HTMLSpanElement;
  private ovalTurnRadiusSlider!: HTMLInputElement;
  private ovalTurnRadiusValue!: HTMLSpanElement;
  private ovalWidthSlider!: HTMLInputElement;
  private ovalWidthValue!: HTMLSpanElement;
  private ovalBankingSlider!: HTMLInputElement;
  private ovalBankingValue!: HTMLSpanElement;

  // Oval shape-specific sliders
  private paperclipRow!: HTMLElement;
  private paperclipSlider!: HTMLInputElement;
  private paperclipValue!: HTMLSpanElement;
  private triovalRow!: HTMLElement;
  private triovalAngleSlider!: HTMLInputElement;
  private triovalAngleValue!: HTMLSpanElement;
  private doglegRow!: HTMLElement;
  private doglegSlider!: HTMLInputElement;
  private doglegValue!: HTMLSpanElement;

  // Generate button
  private generateButton!: HTMLButtonElement;

  // Current composite seed
  private currentCompositeSeed: number = 0;

  // Track whether advanced section is expanded
  private advancedExpanded: boolean = false;

  constructor(containerId: string, callbacks: TracksPanelCallbacks) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container #${containerId} not found`);
    }
    this.container = container;
    this.callbacks = callbacks;

    this.buildDOM();
    this.setupEventListeners();

    // Initialize visibility based on default type
    this.updateVisibility(this.typeSelect.value);
    this.updateSliderRanges();
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="panel-header">TRACKS</div>
      <div class="panel-content">
        <!-- Current Track Seed (shareable) -->
        <div class="seed-display">
          <span class="seed-label">TRACK SEED</span>
          <div class="seed-value-row">
            <span id="tracks-composite-seed" class="seed-value">--</span>
            <button id="tracks-copy" class="copy-btn" title="Copy to clipboard">📋</button>
          </div>
          <span id="tracks-track-info" class="track-info"></span>
        </div>

        <!-- Load Track Section -->
        <div class="section">
          <div class="load-row">
            <input type="text" id="tracks-seed" placeholder="Paste seed to load...">
            <button id="tracks-load" class="load-btn" title="Load track">GO</button>
          </div>
        </div>

        <!-- Track Generation Options -->
        <div class="section-header">GENERATE NEW</div>
        <div class="tracks-row" id="tracks-type-row">
          <label for="tracks-type">Type:</label>
          <select id="tracks-type"></select>
        </div>
        <div class="tracks-row" id="tracks-class-row">
          <label for="tracks-class">Class:</label>
          <select id="tracks-class"></select>
        </div>
        <div class="tracks-row" id="tracks-surface-row">
          <label for="tracks-surface">Surface:</label>
          <select id="tracks-surface"></select>
        </div>
        <div class="tracks-row" id="tracks-shape-row">
          <label for="tracks-shape">Shape:</label>
          <select id="tracks-shape"></select>
        </div>

        <!-- Advanced Options (Collapsible) -->
        <div class="section-header clickable" id="tracks-advanced-toggle">
          <span>ADVANCED</span>
          <span class="chevron">▶</span>
        </div>
        <div id="tracks-advanced-section" class="advanced-section collapsed">
          <!-- GP Sliders -->
          <div id="gp-sliders" class="sliders-group">
            <div class="tracks-row slider-row">
              <label>Roughness:</label>
              <div class="slider-container">
                <input type="range" id="gp-roughness" min="28" max="60" step="2" value="45">
                <span id="gp-roughness-value" class="slider-value">45</span>
              </div>
            </div>
            <div class="tracks-row slider-row">
              <label>Banking (°):</label>
              <div class="slider-container">
                <input type="range" id="gp-banking" min="3" max="29" step="1" value="12">
                <span id="gp-banking-value" class="slider-value">12</span>
              </div>
            </div>
            <div class="tracks-row slider-row">
              <label>Corners:</label>
              <div class="slider-container">
                <input type="range" id="gp-corners" min="6" max="14" step="1" value="8">
                <span id="gp-corners-value" class="slider-value">8</span>
              </div>
            </div>
          </div>

          <!-- Oval Sliders -->
          <div id="oval-sliders" class="sliders-group">
            <div class="tracks-row slider-row">
              <label>Straight:</label>
              <div class="slider-container">
                <input type="range" id="oval-straight" min="160" max="1000" step="10" value="450">
                <span id="oval-straight-value" class="slider-value">450</span>
              </div>
            </div>
            <div class="tracks-row slider-row">
              <label>Turn Radius:</label>
              <div class="slider-container">
                <input type="range" id="oval-turn-radius" min="120" max="600" step="5" value="250">
                <span id="oval-turn-radius-value" class="slider-value">250</span>
              </div>
            </div>
            <div class="tracks-row slider-row">
              <label>Width:</label>
              <div class="slider-container">
                <input type="range" id="oval-width" min="48" max="160" step="2" value="72">
                <span id="oval-width-value" class="slider-value">72</span>
              </div>
            </div>
            <div class="tracks-row slider-row">
              <label>Banking (°):</label>
              <div class="slider-container">
                <input type="range" id="oval-banking" min="6" max="31" step="1" value="13">
                <span id="oval-banking-value" class="slider-value">13</span>
              </div>
            </div>
            <!-- Shape-specific -->
            <div class="tracks-row slider-row" id="paperclip-row">
              <label>Stretch:</label>
              <div class="slider-container">
                <input type="range" id="paperclip-slider" min="1.5" max="3.0" step="0.1" value="2.2">
                <span id="paperclip-value" class="slider-value">2.2</span>
              </div>
            </div>
            <div class="tracks-row slider-row" id="trioval-row">
              <label>Cut Angle:</label>
              <div class="slider-container">
                <input type="range" id="trioval-angle" min="0.5" max="1.3" step="0.1" value="0.9">
                <span id="trioval-angle-value" class="slider-value">0.9</span>
              </div>
            </div>
            <div class="tracks-row slider-row" id="dogleg-row">
              <label>Dogleg:</label>
              <div class="slider-container">
                <input type="range" id="dogleg-slider" min="0.5" max="1.0" step="0.1" value="0.75">
                <span id="dogleg-value" class="slider-value">0.75</span>
              </div>
            </div>
          </div>

        </div>

        <div class="tracks-row">
          <button id="tracks-generate" class="generate-btn">GENERATE TRACK</button>
        </div>
      </div>
    `;

    // Get element references - seed display
    this.compositeSeedDisplay = document.getElementById('tracks-composite-seed') as HTMLSpanElement;
    this.trackInfoLabel = document.getElementById('tracks-track-info') as HTMLSpanElement;
    this.copyButton = document.getElementById('tracks-copy') as HTMLButtonElement;
    this.seedInput = document.getElementById('tracks-seed') as HTMLInputElement;
    this.loadButton = document.getElementById('tracks-load') as HTMLButtonElement;

    // Get element references - dropdowns
    this.typeSelect = document.getElementById('tracks-type') as HTMLSelectElement;
    this.classSelect = document.getElementById('tracks-class') as HTMLSelectElement;
    this.surfaceSelect = document.getElementById('tracks-surface') as HTMLSelectElement;
    this.shapeSelect = document.getElementById('tracks-shape') as HTMLSelectElement;
    this.surfaceRow = document.getElementById('tracks-surface-row') as HTMLElement;
    this.shapeRow = document.getElementById('tracks-shape-row') as HTMLElement;

    // Advanced section
    this.advancedToggle = document.getElementById('tracks-advanced-toggle') as HTMLElement;
    this.advancedSection = document.getElementById('tracks-advanced-section') as HTMLElement;

    // GP sliders
    this.gpSlidersContainer = document.getElementById('gp-sliders') as HTMLElement;
    this.gpRoughnessSlider = document.getElementById('gp-roughness') as HTMLInputElement;
    this.gpRoughnessValue = document.getElementById('gp-roughness-value') as HTMLSpanElement;
    this.gpBankingSlider = document.getElementById('gp-banking') as HTMLInputElement;
    this.gpBankingValue = document.getElementById('gp-banking-value') as HTMLSpanElement;
    this.gpCornersSlider = document.getElementById('gp-corners') as HTMLInputElement;
    this.gpCornersValue = document.getElementById('gp-corners-value') as HTMLSpanElement;

    // Oval sliders
    this.ovalSlidersContainer = document.getElementById('oval-sliders') as HTMLElement;
    this.ovalStraightSlider = document.getElementById('oval-straight') as HTMLInputElement;
    this.ovalStraightValue = document.getElementById('oval-straight-value') as HTMLSpanElement;
    this.ovalTurnRadiusSlider = document.getElementById('oval-turn-radius') as HTMLInputElement;
    this.ovalTurnRadiusValue = document.getElementById('oval-turn-radius-value') as HTMLSpanElement;
    this.ovalWidthSlider = document.getElementById('oval-width') as HTMLInputElement;
    this.ovalWidthValue = document.getElementById('oval-width-value') as HTMLSpanElement;
    this.ovalBankingSlider = document.getElementById('oval-banking') as HTMLInputElement;
    this.ovalBankingValue = document.getElementById('oval-banking-value') as HTMLSpanElement;

    // Oval shape-specific
    this.paperclipRow = document.getElementById('paperclip-row') as HTMLElement;
    this.paperclipSlider = document.getElementById('paperclip-slider') as HTMLInputElement;
    this.paperclipValue = document.getElementById('paperclip-value') as HTMLSpanElement;
    this.triovalRow = document.getElementById('trioval-row') as HTMLElement;
    this.triovalAngleSlider = document.getElementById('trioval-angle') as HTMLInputElement;
    this.triovalAngleValue = document.getElementById('trioval-angle-value') as HTMLSpanElement;
    this.doglegRow = document.getElementById('dogleg-row') as HTMLElement;
    this.doglegSlider = document.getElementById('dogleg-slider') as HTMLInputElement;
    this.doglegValue = document.getElementById('dogleg-value') as HTMLSpanElement;

    this.generateButton = document.getElementById('tracks-generate') as HTMLButtonElement;

    // Populate dropdowns
    this.populateSelect(this.typeSelect, TYPE_OPTIONS);
    this.populateSelect(this.surfaceSelect, SURFACE_OPTIONS);
    this.populateSelect(this.shapeSelect, SHAPE_OPTIONS);

    // Initialize class options based on default type
    this.updateClassOptions(this.typeSelect.value);
  }

  private populateSelect(
    select: HTMLSelectElement,
    options: { value: string; label: string }[]
  ): void {
    select.innerHTML = options
      .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
      .join('');
  }

  private setupEventListeners(): void {
    // Copy button
    this.copyButton.addEventListener('click', () => {
      this.copyToClipboard();
    });

    // Load track button
    this.loadButton.addEventListener('click', () => {
      this.handleLoadTrack();
    });

    // Seed input - load on Enter
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.handleLoadTrack();
      }
      e.stopPropagation(); // Prevent game controls
    });

    // Type change → update class options, show/hide sections, update slider ranges
    this.typeSelect.addEventListener('change', () => {
      const trackType = this.typeSelect.value;
      this.updateClassOptions(trackType);
      this.updateVisibility(trackType);
      this.updateSliderRanges();
    });

    // Class change → update slider ranges
    this.classSelect.addEventListener('change', () => {
      this.updateSliderRanges();
    });

    // Shape change → show/hide shape-specific sliders
    this.shapeSelect.addEventListener('change', () => {
      this.updateShapeSliderVisibility();
    });

    // Advanced toggle
    this.advancedToggle.addEventListener('click', () => {
      this.advancedExpanded = !this.advancedExpanded;
      this.advancedSection.classList.toggle('collapsed', !this.advancedExpanded);
      const chevron = this.advancedToggle.querySelector('.chevron');
      if (chevron) {
        chevron.textContent = this.advancedExpanded ? '▼' : '▶';
      }
    });

    // GP slider value updates
    this.gpRoughnessSlider.addEventListener('input', () => {
      this.gpRoughnessValue.textContent = this.gpRoughnessSlider.value;
    });
    this.gpBankingSlider.addEventListener('input', () => {
      this.gpBankingValue.textContent = this.gpBankingSlider.value;
    });
    this.gpCornersSlider.addEventListener('input', () => {
      this.gpCornersValue.textContent = this.gpCornersSlider.value;
    });

    // Oval slider value updates
    this.ovalStraightSlider.addEventListener('input', () => {
      this.ovalStraightValue.textContent = this.ovalStraightSlider.value;
    });
    this.ovalTurnRadiusSlider.addEventListener('input', () => {
      this.ovalTurnRadiusValue.textContent = this.ovalTurnRadiusSlider.value;
    });
    this.ovalWidthSlider.addEventListener('input', () => {
      this.ovalWidthValue.textContent = this.ovalWidthSlider.value;
    });
    this.ovalBankingSlider.addEventListener('input', () => {
      this.ovalBankingValue.textContent = this.ovalBankingSlider.value;
    });
    this.paperclipSlider.addEventListener('input', () => {
      this.paperclipValue.textContent = this.paperclipSlider.value;
    });
    this.triovalAngleSlider.addEventListener('input', () => {
      this.triovalAngleValue.textContent = this.triovalAngleSlider.value;
    });
    this.doglegSlider.addEventListener('input', () => {
      this.doglegValue.textContent = this.doglegSlider.value;
    });

    // Generate button → collect values, call callback
    this.generateButton.addEventListener('click', () => {
      this.handleGenerate();
    });

    // Prevent keyboard events from triggering game controls
    const selects = [this.typeSelect, this.classSelect, this.surfaceSelect, this.shapeSelect];
    selects.forEach((select) => {
      select.addEventListener('keydown', (e) => e.stopPropagation());
    });
  }

  private updateClassOptions(trackType: string): void {
    const options = CLASS_OPTIONS[trackType] || CLASS_OPTIONS['gp'];
    this.populateSelect(this.classSelect, options);
  }

  private updateVisibility(trackType: string): void {
    const isOval = trackType === 'oval';
    this.surfaceRow.style.display = isOval ? 'flex' : 'none';
    this.shapeRow.style.display = isOval ? 'flex' : 'none';

    // Show/hide slider groups based on track type
    this.gpSlidersContainer.style.display = trackType === 'gp' ? 'block' : 'none';
    this.ovalSlidersContainer.style.display = trackType === 'oval' ? 'block' : 'none';

    this.updateShapeSliderVisibility();
  }

  private updateShapeSliderVisibility(): void {
    const isOval = this.typeSelect.value === 'oval';
    const shape = this.shapeSelect.value;

    // Paperclip eccentricity - only for paperclip
    this.paperclipRow.style.display = isOval && shape === 'paperclip' ? 'flex' : 'none';

    // Trioval angle - for trioval and egg
    this.triovalRow.style.display = isOval && (shape === 'trioval' || shape === 'egg') ? 'flex' : 'none';

    // Dogleg intensity - for trioval and egg
    this.doglegRow.style.display = isOval && (shape === 'trioval' || shape === 'egg') ? 'flex' : 'none';
  }

  /**
   * Update slider ranges and optionally reset values to defaults.
   * @param resetValues If true, reset slider values to defaults. If false, preserve current values.
   */
  private updateSliderRanges(resetValues: boolean = true): void {
    const trackType = this.typeSelect.value;
    const sizeClass = this.classSelect.value;

    if (trackType === 'gp') {
      const range = GP_ROUGHNESS[sizeClass];
      if (!range) return; // Size class not valid for this track type
      this.updateSlider(this.gpRoughnessSlider, this.gpRoughnessValue, range, resetValues);
      this.updateSlider(this.gpBankingSlider, this.gpBankingValue, GP_BANKING[sizeClass], resetValues);
      this.updateSlider(this.gpCornersSlider, this.gpCornersValue, GP_CORNERS[sizeClass], resetValues);
    } else if (trackType === 'oval') {
      const range = OVAL_STRAIGHT[sizeClass];
      if (!range) return; // Size class not valid for this track type
      this.updateSlider(this.ovalStraightSlider, this.ovalStraightValue, range, resetValues);
      this.updateSlider(this.ovalTurnRadiusSlider, this.ovalTurnRadiusValue, OVAL_TURN_RADIUS[sizeClass], resetValues);
      this.updateSlider(this.ovalWidthSlider, this.ovalWidthValue, OVAL_WIDTH[sizeClass], resetValues);
      this.updateSlider(this.ovalBankingSlider, this.ovalBankingValue, OVAL_BANKING[sizeClass], resetValues);
      // Shape-specific sliders have fixed ranges
      this.updateSlider(this.paperclipSlider, this.paperclipValue, PAPERCLIP_ECCENTRICITY, resetValues);
      this.updateSlider(this.triovalAngleSlider, this.triovalAngleValue, TRIOVAL_ANGLE, resetValues);
      this.updateSlider(this.doglegSlider, this.doglegValue, DOGLEG_INTENSITY, resetValues);
    }
  }

  private updateSlider(
    slider: HTMLInputElement,
    valueDisplay: HTMLSpanElement,
    range: { min: number; max: number; step: number; default: number },
    resetValue: boolean = true
  ): void {
    slider.min = range.min.toString();
    slider.max = range.max.toString();
    slider.step = range.step.toString();

    if (resetValue) {
      slider.value = range.default.toString();
      valueDisplay.textContent = range.default.toString();
    } else {
      // Clamp existing value to new range
      const currentValue = parseFloat(slider.value);
      const clampedValue = Math.max(range.min, Math.min(range.max, currentValue));
      slider.value = clampedValue.toString();
      valueDisplay.textContent = clampedValue.toString();
    }
  }

  private handleGenerate(): void {
    const trackType = this.typeSelect.value as TimeTrialTrackType;
    const sizeClass = this.classSelect.value as SizeClass;

    const config: TrackGenerationConfig = {
      trackType,
      sizeClass,
    };

    // Only include advanced params if section is expanded (user wants custom values)
    if (this.advancedExpanded) {
      if (trackType === 'gp') {
        config.roughness = parseInt(this.gpRoughnessSlider.value);
        config.maxBankingAngle = parseInt(this.gpBankingSlider.value) * (Math.PI / 180); // Convert to radians
        config.numControlPoints = parseInt(this.gpCornersSlider.value);
      } else if (trackType === 'oval') {
        config.surfaceType = this.surfaceSelect.value as SurfaceType;
        config.ovalShape = this.shapeSelect.value as OvalShape;
        config.straightLength = parseInt(this.ovalStraightSlider.value);
        config.turnRadius = parseInt(this.ovalTurnRadiusSlider.value);
        config.trackWidth = parseInt(this.ovalWidthSlider.value);
        config.maxBankingAngle = parseInt(this.ovalBankingSlider.value) * (Math.PI / 180);

        // Shape-specific parameters
        if (config.ovalShape === 'paperclip') {
          config.paperclipEccentricity = parseFloat(this.paperclipSlider.value);
        }
        if (config.ovalShape === 'trioval' || config.ovalShape === 'egg') {
          config.triOvalAngle = parseFloat(this.triovalAngleSlider.value);
          config.doglegIntensity = parseFloat(this.doglegSlider.value);
        }
      }
    } else {
      // Not expanded - just set oval-specific dropdowns
      if (trackType === 'oval') {
        config.surfaceType = this.surfaceSelect.value as SurfaceType;
        config.ovalShape = this.shapeSelect.value as OvalShape;
      }
    }

    this.callbacks.onGenerateTrack(config);
  }

  private handleLoadTrack(): void {
    const seedText = this.seedInput.value.trim();
    if (!seedText) return;

    // Parse seed - must be a number (composite seed)
    let seedNumber: number;
    if (/^\d+$/.test(seedText)) {
      seedNumber = parseInt(seedText, 10);
    } else {
      // Hash string to create a composite seed with defaults
      const hash = this.hashString(seedText);
      // Encode with default config (GP circuit)
      seedNumber = encodeCompositeSeed({
        baseSeed: hash,
        trackType: 'gp',
        sizeClass: 'circuit',
        surfaceType: 'asphalt',
        ovalShape: 'elliptical',
      });
    }

    // Decode composite seed and load
    const config = decodeCompositeSeed(seedNumber);
    this.callbacks.onLoadTrack(config);

    // Clear input after loading
    this.seedInput.value = '';
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash) % 1000000; // Keep base seed reasonable
  }

  private async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.currentCompositeSeed.toString());
      // Visual feedback
      const originalText = this.copyButton.textContent;
      this.copyButton.textContent = '✓';
      this.copyButton.classList.add('copied');
      setTimeout(() => {
        this.copyButton.textContent = originalText;
        this.copyButton.classList.remove('copied');
      }, 1500);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = this.currentCompositeSeed.toString();
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  }

  /**
   * Update the current track display with composite seed.
   */
  setCurrentTrack(config: FullTrackConfig): void {
    // Encode to composite seed
    this.currentCompositeSeed = encodeCompositeSeed(config);
    this.compositeSeedDisplay.textContent = this.currentCompositeSeed.toString();

    // Show track info below seed
    const typeLabel = config.trackType.toUpperCase();
    const sizeLabel = this.formatSizeClass(config.sizeClass);
    let info = `${typeLabel} / ${sizeLabel}`;
    if (config.trackType === 'oval') {
      info += ` / ${this.formatSizeClass(config.ovalShape)}`;
      if (config.surfaceType === 'dirt') {
        info += ' / Dirt';
      }
    }
    this.trackInfoLabel.textContent = info;

    // Also update the dropdowns to match
    this.setCurrentConfig({
      trackType: config.trackType,
      sizeClass: config.sizeClass,
      surfaceType: config.surfaceType,
      ovalShape: config.ovalShape,
    });
  }

  private formatSizeClass(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  /**
   * Sync panel dropdowns when track changes externally (e.g., keyboard shortcut).
   * Does NOT reset slider values - preserves user's custom settings.
   */
  setCurrentConfig(config: TrackGenerationConfig): void {
    // Set type
    this.typeSelect.value = config.trackType;
    this.updateClassOptions(config.trackType);
    this.updateVisibility(config.trackType);

    // Set class
    this.classSelect.value = config.sizeClass;

    // Update slider ranges but preserve current values
    // (don't reset - user may have customized them)
    this.updateSliderRanges(false);

    // Set oval-specific options
    if (config.surfaceType) {
      this.surfaceSelect.value = config.surfaceType;
    }
    if (config.ovalShape) {
      this.shapeSelect.value = config.ovalShape;
      this.updateShapeSliderVisibility();
    }
  }
}
