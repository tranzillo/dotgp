import type { WorkerFramePerf } from '../events/protocol';

/**
 * The performance readout: how the viewer is keeping up on this machine.
 *
 * Every screen frame and every frame from the event worker is counted, all
 * the time, into one-second samples; the last couple of minutes are kept.
 * The panel (top right of the view, when shown) reads the newest sample. A
 * report (Copy / Save) has the machine, what was on screen, and every kept
 * second, so a slow run on someone's machine can be looked at elsewhere.
 */

/** What was on screen, for the report: labelled values, in order. */
export type PerfContext = Array<[string, string]>;

interface Sample {
  /** Page time at the end of the second (ms). */
  at: number;
  fps: number;
  /** Time between screen frames (ms). */
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** Frames that took over 50 ms (visible stutter). */
  slow: number;
  /** The page's own work per frame: everything, and the track view's part (ms). */
  mainAvg: number;
  mainP95: number;
  renderAvg: number;
  /** Long tasks the browser saw (anything over 50 ms on the main thread), and their total (ms). */
  longTasks: number;
  longMs: number;
  /** The worker's stepping (ms per frame), building frames (ms per frame). */
  stepAvg: number;
  stepMax: number;
  sendAvg: number;
  /** Sim seconds per real second, against what was asked; sim seconds dropped for want of time. */
  simRate: number;
  asked: number;
  dropped: number;
  /** The track drawn again (zooming), and the ms that took. */
  records: number;
  recordMs: number;
  /** The GPU's time per frame (ms), where the renderer can measure it (WebGL with timer queries). */
  gpuMs: number | null;
  /** JS heap in use (MB; Chromium only). */
  heapMB: number | null;
}

/** Seconds of samples kept for the report. */
const KEEP = 120;
/** A frame this long is a visible stutter (ms). */
const SLOW_FRAME = 50;
const STORAGE_KEY = 'dotgp.v2.perf';

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const max = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

let gpuName: string | null = null;

/** The graphics hardware as the browser reports it (a software renderer, e.g. SwiftShader, means no GPU drawing). */
function gpu(): string {
  if (gpuName !== null) return gpuName;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return (gpuName = 'no WebGL');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    gpuName = info
      ? `${gl.getParameter(info.UNMASKED_VENDOR_WEBGL)} · ${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`
      : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    gpuName = 'unknown';
  }
  return gpuName;
}

export class PerfMonitor {
  private readonly samples: Sample[] = [];
  // This second so far.
  private intervals: number[] = [];
  private main: number[] = [];
  private render: number[] = [];
  private steps: number[] = [];
  private sends: number[] = [];
  private sim = 0;
  private dropped = 0;
  private longTasks = 0;
  private longMs = 0;
  private recordsWere = 0;
  private recordMsWere = 0;
  private secondStart = performance.now();
  private panel: HTMLElement | null = null;
  private fields: Record<'fps' | 'frame' | 'main' | 'sim' | 'worker', HTMLElement> | null = null;
  private shown = false;

  /**
   * asked: the sim speed asked for now (0 paused). context: what's on screen.
   * renderStats: the renderer's running counts of track recordings.
   */
  constructor(
    private readonly asked: () => number,
    private readonly context: () => PerfContext,
    private readonly renderStats: () => { records: number; recordMs: number; ops: number; gpuMs?: number | null },
  ) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.longTasks++;
          this.longMs += e.duration;
        }
      }).observe({ type: 'longtask' });
    } catch { /* not in this browser: none counted */ }
    setInterval(() => this.endSecond(), 1000);
  }

  /** A screen frame: since the last one, the page's work on it, and the track view's part (ms). */
  frame(interval: number, mainMs: number, renderMs: number): void {
    if (interval > 0) this.intervals.push(interval);
    this.main.push(mainMs);
    this.render.push(renderMs);
  }

  /** A frame from the event on screen. */
  worker(p: WorkerFramePerf): void {
    this.steps.push(p.stepMs);
    this.sends.push(p.sendMs);
    this.sim += p.sim;
    this.dropped += p.dropped;
  }

  private endSecond(): void {
    const now = performance.now();
    const real = (now - this.secondStart) / 1000;
    this.secondStart = now;
    const rs = this.renderStats();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.samples.push({
      at: now,
      fps: this.intervals.length / Math.max(real, 1e-3),
      frameP50: pct(this.intervals, 0.5),
      frameP95: pct(this.intervals, 0.95),
      frameMax: max(this.intervals),
      slow: this.intervals.filter((t) => t > SLOW_FRAME).length,
      mainAvg: avg(this.main),
      mainP95: pct(this.main, 0.95),
      renderAvg: avg(this.render),
      longTasks: this.longTasks,
      longMs: this.longMs,
      stepAvg: avg(this.steps),
      stepMax: max(this.steps),
      sendAvg: avg(this.sends),
      simRate: this.sim / Math.max(real, 1e-3),
      asked: this.asked(),
      dropped: this.dropped,
      records: rs.records - this.recordsWere,
      recordMs: rs.recordMs - this.recordMsWere,
      gpuMs: rs.gpuMs ?? null,
      heapMB: memory ? memory.usedJSHeapSize / 1e6 : null,
    });
    if (this.samples.length > KEEP) this.samples.shift();
    this.recordsWere = rs.records;
    this.recordMsWere = rs.recordMs;
    this.intervals = [];
    this.main = [];
    this.render = [];
    this.steps = [];
    this.sends = [];
    this.sim = 0;
    this.dropped = 0;
    this.longTasks = 0;
    this.longMs = 0;
    if (this.shown) this.show();
  }

  /** Whether the panel is up (remembered between visits). */
  get visible(): boolean {
    return this.shown;
  }

  set visible(on: boolean) {
    this.shown = on;
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* for this visit only */ }
    if (this.panel) {
      this.panel.hidden = !on;
      this.panel.parentElement?.classList.toggle('perf-on', on);
    }
    if (on) this.show();
  }

  /** Shown last visit (or asked for in the address)? */
  static wanted(): boolean {
    const asked = new URLSearchParams(location.search).get('perf');
    if (asked !== null) return asked !== '0';
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  }

  /** Put the panel in this element (it's drawn over its top right). */
  attach(view: HTMLElement): void {
    const panel = document.createElement('div');
    panel.id = 'perf';
    panel.hidden = true;
    const span = () => document.createElement('span');
    const fields = { fps: span(), frame: span(), main: span(), sim: span(), worker: span() };
    const sep = () => document.createTextNode(' · ');
    const row1 = document.createElement('div');
    row1.append(fields.fps, sep(), fields.frame, sep(), fields.main);
    const row2 = document.createElement('div');
    const button = (label: string, title: string, act: (b: HTMLButtonElement) => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = () => act(b);
      return b;
    };
    row2.append(
      fields.sim, sep(), fields.worker, ' ',
      button('Copy', 'Copy a performance report (this machine, what\'s on screen, the last two minutes)', (b) => this.copy(b)),
      button('Save', 'Save the performance report as a text file', () => this.save()),
    );
    panel.append(row1, row2);
    view.appendChild(panel);
    this.panel = panel;
    this.fields = fields;
  }

  private show(): void {
    const f = this.fields, s = this.samples[this.samples.length - 1];
    if (!f) return;
    if (!s) {
      f.fps.textContent = 'measuring…';
      return;
    }
    const warn = (el: HTMLElement, level: 0 | 1 | 2) => { el.className = level === 2 ? 'bad' : level === 1 ? 'warn' : ''; };
    f.fps.textContent = `${s.fps.toFixed(0)} fps`;
    warn(f.fps, s.fps < 30 ? 2 : s.fps < 50 ? 1 : 0);
    f.frame.textContent = `frame p95 ${s.frameP95.toFixed(0)} · max ${s.frameMax.toFixed(0)} ms`;
    warn(f.frame, s.slow > 2 ? 2 : s.slow > 0 ? 1 : 0);
    f.main.textContent = `page ${s.mainAvg.toFixed(1)} ms${s.gpuMs !== null ? ` · gpu ${s.gpuMs.toFixed(1)} ms` : ''}`;
    warn(f.main, s.mainAvg > 12 ? 2 : s.mainAvg > 6 ? 1 : 0);
    const short = s.asked > 0 && s.simRate < s.asked * 0.95;
    f.sim.textContent = s.asked > 0 ? `sim ${s.simRate.toFixed(s.simRate < 10 ? 1 : 0)}× of ${s.asked}×` : 'sim paused';
    warn(f.sim, short && s.simRate < s.asked * 0.7 ? 2 : short ? 1 : 0);
    f.worker.textContent = `worker ${s.stepAvg.toFixed(1)} ms`;
    warn(f.worker, s.dropped > 0 ? 1 : 0);
  }

  /** The report: this machine, what's on screen, a summary of the last ten seconds, then every kept second. */
  report(): string {
    const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
    const now = new Date();
    const upFor = performance.now() / 1000;
    const rs = this.renderStats();
    const recent = this.samples.slice(-10);
    const r = (k: keyof Sample, d = 1) => {
      const v = avg(recent.map((s) => (s[k] as number) ?? 0));
      return v.toFixed(d);
    };
    const canvas = document.querySelector('canvas');
    const lines: string[] = [];
    const row = (label: string, value: string) => lines.push(`${label.padEnd(11)}${value}`);
    lines.push('DotGP performance report');
    row('Taken', `${now.toISOString()} · page up ${Math.floor(upFor / 60)}m${Math.floor(upFor % 60)}s`);
    row('Address', location.href);
    row('Browser', navigator.userAgent);
    row('Machine', [
      nav.userAgentData?.platform ?? navigator.platform,
      `${navigator.hardwareConcurrency ?? '?'} threads`,
      nav.deviceMemory ? `${nav.deviceMemory} GB memory (or more)` : 'memory not reported',
    ].join(' · '));
    row('GPU', gpu());
    row('Screen', `${screen.width}×${screen.height} at ${window.devicePixelRatio}× · window ${innerWidth}×${innerHeight}`
      + (canvas ? ` · track canvas ${canvas.width}×${canvas.height} px` : ''));
    for (const [label, value] of this.context()) row(label, value);
    row('Track draw', `built ${rs.records}× (${rs.recordMs.toFixed(0)} ms in all), ${rs.ops} draw ops per frame`);
    lines.push('');
    if (recent.length) {
      lines.push(`Last ${recent.length} s: ${r('fps', 0)} fps, frame p95 ${r('frameP95', 0)} ms (worst ${max(recent.map((s) => s.frameMax)).toFixed(0)}), `
        + `${recent.reduce((n, s) => n + s.slow, 0)} slow frames, page ${r('mainAvg')} ms/frame (track view ${r('renderAvg')}), `
        + `${recent.reduce((n, s) => n + s.longTasks, 0)} long tasks, worker ${r('stepAvg')} ms/frame, sim ${r('simRate')}× of ${r('asked', 0)}×`);
      lines.push('');
    }
    lines.push('Per second, oldest first. Frame times are between screen frames; page is the viewer\'s own work per frame;');
    lines.push('long = browser long tasks; step/send = the event worker per frame; drop = sim seconds it had no time for.');
    const cols: Array<[string, (s: Sample) => string]> = [
      ['time', (s) => { const t = s.at / 1000; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }],
      ['fps', (s) => s.fps.toFixed(0)],
      ['p50', (s) => s.frameP50.toFixed(1)],
      ['p95', (s) => s.frameP95.toFixed(1)],
      ['max', (s) => s.frameMax.toFixed(0)],
      ['slow', (s) => String(s.slow)],
      ['page', (s) => s.mainAvg.toFixed(2)],
      ['pg95', (s) => s.mainP95.toFixed(2)],
      ['view', (s) => s.renderAvg.toFixed(2)],
      ['gpu', (s) => (s.gpuMs === null ? '' : s.gpuMs.toFixed(2))],
      ['long', (s) => String(s.longTasks)],
      ['lms', (s) => s.longMs.toFixed(0)],
      ['step', (s) => s.stepAvg.toFixed(2)],
      ['smax', (s) => s.stepMax.toFixed(1)],
      ['send', (s) => s.sendAvg.toFixed(2)],
      ['sim×', (s) => s.simRate.toFixed(2)],
      ['ask×', (s) => String(s.asked)],
      ['drop', (s) => s.dropped.toFixed(2)],
      ['redraw', (s) => (s.records ? `${s.records}/${s.recordMs.toFixed(0)}ms` : '')],
      ['heapMB', (s) => (s.heapMB === null ? '' : s.heapMB.toFixed(0))],
    ];
    const table = [cols.map(([h]) => h), ...this.samples.map((s) => cols.map(([, f]) => f(s)))];
    const widths = cols.map((_, i) => Math.max(...table.map((t) => t[i].length)));
    for (const t of table) lines.push(t.map((v, i) => v.padStart(widths[i])).join('  ').trimEnd());
    return lines.join('\n');
  }

  private copy(b: HTMLButtonElement): void {
    const text = this.report();
    const done = (label: string) => { b.textContent = label; setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
    // No clipboard here (a page not served securely, say): saved as a file instead.
    if (!navigator.clipboard) { this.save(text); return; }
    navigator.clipboard.writeText(text).then(() => done('Copied'), () => { this.save(text); done('Saved'); });
  }

  private save(text = this.report()): void {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `dotgp-perf-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
}
