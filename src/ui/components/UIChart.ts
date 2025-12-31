import { UIComponentBase, UI_COLORS } from '../UIComponent';

export class UIChart extends UIComponentBase {
  private dataPoints: number[] = [];
  private maxPoints: number;
  private minValue: number = 0;
  private maxValue: number = 100;
  private autoScale: boolean = true;
  private lineColor: string = UI_COLORS.chartLine;
  private title: string = '';

  constructor(x: number, y: number, width: number, height: number, maxPoints: number = 100) {
    super(x, y, width, height);
    this.maxPoints = maxPoints;
  }

  addPoint(value: number): void {
    this.dataPoints.push(value);
    if (this.dataPoints.length > this.maxPoints) {
      this.dataPoints.shift();
    }

    if (this.autoScale && this.dataPoints.length > 0) {
      this.minValue = Math.min(...this.dataPoints);
      this.maxValue = Math.max(...this.dataPoints);
      // Add some padding
      const range = this.maxValue - this.minValue || 1;
      this.minValue -= range * 0.1;
      this.maxValue += range * 0.1;
    }
  }

  clear(): void {
    this.dataPoints = [];
  }

  setTitle(title: string): void {
    this.title = title;
  }

  setLineColor(color: string): void {
    this.lineColor = color;
  }

  setAutoScale(auto: boolean): void {
    this.autoScale = auto;
  }

  setRange(min: number, max: number): void {
    this.minValue = min;
    this.maxValue = max;
    this.autoScale = false;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    // Background
    ctx.fillStyle = UI_COLORS.chartBackground;
    ctx.fillRect(this.x, this.y, this.width, this.height);

    // Border
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.x, this.y, this.width, this.height);

    // Title
    if (this.title) {
      ctx.fillStyle = UI_COLORS.textMuted;
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(this.title, this.x + 4, this.y + 2);
    }

    // Draw data line
    if (this.dataPoints.length < 2) return;

    const range = this.maxValue - this.minValue || 1;
    const chartPadding = this.title ? 14 : 4;
    const chartHeight = this.height - chartPadding - 4;
    const chartY = this.y + chartPadding;

    ctx.beginPath();
    ctx.strokeStyle = this.lineColor;
    ctx.lineWidth = 1.5;

    const stepX = (this.width - 8) / (this.maxPoints - 1);

    for (let i = 0; i < this.dataPoints.length; i++) {
      const val = this.dataPoints[i];
      const normalizedVal = (val - this.minValue) / range;
      const px = this.x + 4 + i * stepX;
      const py = chartY + chartHeight - normalizedVal * chartHeight;

      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }

    ctx.stroke();

    // Draw current value
    if (this.dataPoints.length > 0) {
      const lastValue = this.dataPoints[this.dataPoints.length - 1];
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(lastValue.toFixed(1), this.x + this.width - 4, this.y + 2);
    }
  }
}
