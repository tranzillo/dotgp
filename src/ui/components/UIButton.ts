import { UIComponentBase, UI_COLORS } from '../UIComponent';

export class UIButton extends UIComponentBase {
  private label: string;
  private clickHandler: (() => void) | null = null;
  private disabled: boolean = false;

  constructor(x: number, y: number, width: number, height: number, label: string) {
    super(x, y, width, height);
    this.label = label;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  setOnClick(handler: () => void): void {
    this.clickHandler = handler;
  }

  onClick(): void {
    if (!this.disabled && this.clickHandler) {
      this.clickHandler();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    // Background
    if (this.disabled) {
      ctx.fillStyle = UI_COLORS.buttonDisabled;
    } else if (this.isHovered) {
      ctx.fillStyle = UI_COLORS.buttonHover;
    } else {
      ctx.fillStyle = UI_COLORS.buttonBackground;
    }
    ctx.fillRect(this.x, this.y, this.width, this.height);

    // Border
    ctx.strokeStyle = this.isHovered && !this.disabled
      ? UI_COLORS.textHighlight
      : UI_COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.x, this.y, this.width, this.height);

    // Label
    ctx.fillStyle = this.disabled ? UI_COLORS.textMuted : UI_COLORS.text;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, this.x + this.width / 2, this.y + this.height / 2);
  }
}
