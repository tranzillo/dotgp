/**
 * Base interface for all UI components.
 */
export interface UIComponent {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;

  /**
   * Render the component to the canvas.
   */
  render(ctx: CanvasRenderingContext2D): void;

  /**
   * Check if a point is within the component bounds.
   */
  containsPoint(px: number, py: number): boolean;

  /**
   * Handle click event (optional).
   */
  onClick?(): void;

  /**
   * Handle hover state change (optional).
   */
  onHover?(isHovered: boolean): void;
}

/**
 * Base class with common functionality for UI components.
 */
export abstract class UIComponentBase implements UIComponent {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean = true;
  protected isHovered: boolean = false;

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  abstract render(ctx: CanvasRenderingContext2D): void;

  containsPoint(px: number, py: number): boolean {
    return (
      px >= this.x &&
      px <= this.x + this.width &&
      py >= this.y &&
      py <= this.y + this.height
    );
  }

  onHover(hovered: boolean): void {
    this.isHovered = hovered;
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
}

/**
 * UI color scheme.
 */
export const UI_COLORS = {
  panelBackground: '#1a1a2e',
  panelBorder: '#3a3a5e',
  buttonBackground: '#2a2a4e',
  buttonHover: '#3a3a6e',
  buttonActive: '#4a4a8e',
  buttonDisabled: '#1a1a2e',
  text: '#ffffff',
  textMuted: '#888888',
  textHighlight: '#00ff00',
  progressBackground: '#333333',
  progressFill: '#00ff00',
  chartLine: '#00ff00',
  chartBackground: '#0a0a1e',
  listItemHover: '#2a2a4e',
  listItemSelected: '#3a3a6e',
  success: '#00ff00',
  warning: '#ffaa00',
  error: '#ff4444',
};
