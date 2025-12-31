import { UIComponentBase, UI_COLORS } from '../UIComponent';

export class UIProgressBar extends UIComponentBase {
  private value: number = 0; // 0 to 1
  private label: string = '';
  private showLabel: boolean = true;
  private fillColor: string = UI_COLORS.progressFill;

  constructor(x: number, y: number, width: number, height: number) {
    super(x, y, width, height);
  }

  setValue(value: number): void {
    this.value = Math.max(0, Math.min(1, value));
  }

  getValue(): number {
    return this.value;
  }

  setLabel(label: string): void {
    this.label = label;
    this.showLabel = label.length > 0;
  }

  setFillColor(color: string): void {
    this.fillColor = color;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    // Background
    ctx.fillStyle = UI_COLORS.progressBackground;
    ctx.fillRect(this.x, this.y, this.width, this.height);

    // Fill
    const fillWidth = this.width * this.value;
    if (fillWidth > 0) {
      ctx.fillStyle = this.fillColor;
      ctx.fillRect(this.x, this.y, fillWidth, this.height);
    }

    // Border
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.x, this.y, this.width, this.height);

    // Label
    if (this.showLabel) {
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.label, this.x + this.width / 2, this.y + this.height / 2);
    }
  }
}
