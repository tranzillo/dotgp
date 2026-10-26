import { G, PHYSICS as P } from '../../sim/constants';
import type { Track } from '../../sim/track';
import { BAND_FIELDS, DRAFT_FX, draftHeads, draftLinks, DraftWall, STREAK_FIELDS, type DraftLink } from '../draft';
import { EXHAUST, Exhaust } from '../exhaust';
import { numberColor, PACE_CAR_LIVERY, WRECKER_LIVERY, type Livery } from '../livery';
import { GROOVE_DISPLAY_ALPHA, GROOVE_STROKE_ALPHA, grooveChance, grooveWidth, skidStroke, STROKE_FIELDS } from '../marks';
import { damageModel } from '../../sim/damage';
import { TRUCK } from '../../sim/wrecker';
import { SMOKE, Smoke } from '../smoke';
import {
  COLORS, FALLBACK_BORDER, MARK_RES, paintBankLabels, paintBankLegend,
  type DebugLayers, type DotMode, type Insets, type RenderCar, type RenderOfficials, type TrackView,
} from '../view';
import { CAMERA_GLSL, FloatBatch, floats, program, rgba, vertexArray, type Program, type RGBA } from './glutil';
import { buildVenueMesh, FILL_LAYOUT, LINE_LAYOUT, type MeshItem, type VenueMesh } from './trackMesh';

/**
 * The track view on the GPU (WebGL2). The venue is geometry built once per
 * track (gl/trackMesh.ts) that the camera only moves; cars, numbers, puffs
 * and officials are one batch of instanced quads drawn in order; tire marks
 * are stamped into two textures at world resolution; trails are soft strips.
 * A frame is a few dozen draw calls whatever the zoom or the sim speed.
 */

const FILL_VS = `#version 300 es
precision highp float;
${CAMERA_GLSL}
in vec2 a_pos; in vec4 a_color; in float a_pattern;
out vec4 v_color; out vec2 v_world; flat out int v_pattern;
void main() {
  v_color = a_color; v_world = a_pos; v_pattern = int(a_pattern + 0.5);
  gl_Position = toClip(toScreen(a_pos));
}`;

// Patterns are fixed to the ground: mowing stripes 24 m wide across the view, painted run-off in red and blue bands.
const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 u_cam;
uniform vec3 u_mow; uniform vec4 u_red; uniform vec4 u_blue;
in vec4 v_color; in vec2 v_world; flat in int v_pattern;
out vec4 o;
void main() {
  vec4 c = v_color;
  float mx = u_cam.y * v_world.x;
  if (v_pattern == 1) {
    if (fract(mx / 48.0) < 0.5) c.rgb = u_mow;
  } else if (v_pattern == 2) {
    float r = mod(mx + v_world.y, 16.0);
    vec4 p = (r < 2.83 || r > 13.17) ? u_red : abs(r - 8.0) < 2.83 ? u_blue : vec4(0.0);
    c.rgb = mix(c.rgb, p.rgb, p.a);
  }
  o = vec4(c.rgb * c.a, c.a);
}`;

const LINE_VS = `#version 300 es
precision highp float;
${CAMERA_GLSL}
uniform float u_dpr;
in vec2 a_pos; in vec2 a_norm; in vec3 a_width; in vec3 a_dash; in vec4 a_color;
out vec4 v_color; out float v_along; out vec2 v_dash;
void main() {
  float w = max(a_width.x * u_dpr, a_width.y * u_cam.x) + a_width.z * u_dpr;
  vec2 p = toScreen(a_pos) + vec2(u_cam.y * a_norm.x, -a_norm.y) * w * 0.5;
  v_color = a_color; v_along = a_dash.x * u_cam.x; v_dash = a_dash.yz * u_dpr;
  gl_Position = toClip(p);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color; in float v_along; in vec2 v_dash;
out vec4 o;
void main() {
  if (v_dash.x > 0.0 && mod(v_along, v_dash.x + v_dash.y) >= v_dash.x) discard;
  o = vec4(v_color.rgb * v_color.a, v_color.a);
}`;

/** Instanced quads at a world point, sized and nudged in screen px: discs and rings, text, squares, puffs. */
const SPRITE_LAYOUT: Array<[string, number]> = [
  ['i_center', 2], ['i_offset', 2], ['i_half', 2], ['i_kind', 1], ['i_color', 4], ['i_color2', 4], ['i_data', 4],
];
const SPRITE_FLOATS = floats(SPRITE_LAYOUT);
const DISC = 0, GLYPH = 1, PUFF = 2;

const SPRITE_VS = `#version 300 es
precision highp float;
${CAMERA_GLSL}
in vec2 a_corner;
in vec2 i_center; in vec2 i_offset; in vec2 i_half; in float i_kind; in vec4 i_color; in vec4 i_color2; in vec4 i_data;
out vec2 v_local; out vec2 v_uv;
flat out int v_kind; flat out vec4 v_color; flat out vec4 v_color2; flat out vec4 v_data;
void main() {
  v_local = a_corner * i_half;
  v_uv = mix(i_data.xy, i_data.zw, a_corner * 0.5 + 0.5);
  v_kind = int(i_kind + 0.5); v_color = i_color; v_color2 = i_color2; v_data = i_data;
  gl_Position = toClip(toScreen(i_center) + i_offset + v_local);
}`;

// Discs: data = (radius, ring width or 0). Puffs: data = (radius).
const SPRITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
in vec2 v_local; in vec2 v_uv;
flat in int v_kind; flat in vec4 v_color; flat in vec4 v_color2; flat in vec4 v_data;
out vec4 o;
void main() {
  vec4 c = v_color;
  float a;
  if (v_kind == 0) {
    float d = length(v_local);
    a = clamp(v_data.x - d + 0.5, 0.0, 1.0);
    if (v_data.y > 0.0) a *= clamp(d - (v_data.x - v_data.y) + 0.5, 0.0, 1.0);
  } else if (v_kind == 1) {
    a = texture(u_atlas, v_uv).a;
  } else {
    float t = length(v_local) / v_data.x;
    a = t < 0.35 ? mix(1.0, 0.6, t / 0.35) : mix(0.6, 0.0, clamp((t - 0.35) / 0.65, 0.0, 1.0));
  }
  a *= c.a;
  o = vec4(c.rgb * a, a);
}`;

/** Triangles at world points, offset in px along world directions: trails, debug arrows. */
const SHAPE_LAYOUT: Array<[string, number]> = [['a_pos', 2], ['a_off', 2], ['a_color', 4]];
const SHAPE_FLOATS = floats(SHAPE_LAYOUT);

const SHAPE_VS = `#version 300 es
precision highp float;
${CAMERA_GLSL}
in vec2 a_pos; in vec2 a_off; in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = toClip(toScreen(a_pos) + vec2(u_cam.y * a_off.x, -a_off.y));
}`;

const SHAPE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o;
void main() { o = vec4(v_color.rgb * v_color.a, v_color.a); }`;

/** The tire marks: both textures over the venue, the groove at its capped opacity under the skids. */
const MARKS_VS = `#version 300 es
precision highp float;
${CAMERA_GLSL}
uniform vec2 u_min; uniform float u_res; uniform vec2 u_tex;
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = (a_pos - u_min) * u_res / u_tex; gl_Position = toClip(toScreen(a_pos)); }`;

const MARKS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_groove; uniform sampler2D u_skids; uniform float u_grooveAlpha;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 k = texture(u_skids, v_uv), g = texture(u_groove, v_uv) * u_grooveAlpha;
  o = k + g * (1.0 - k.a);
}`;

/** A stroke stamped into a mark texture: a segment with round ends, in the texture's px. */
const STAMP_LAYOUT: Array<[string, number]> = [['i_seg', 4], ['i_half', 1], ['i_color', 4]];
const STAMP_FLOATS = floats(STAMP_LAYOUT);

const STAMP_VS = `#version 300 es
precision highp float;
uniform vec2 u_min; uniform float u_res; uniform vec2 u_tex;
in vec2 a_corner; in vec4 i_seg; in float i_half; in vec4 i_color;
out vec2 v_p; flat out vec4 v_seg; flat out float v_half; flat out vec4 v_color;
void main() {
  vec2 p0 = (i_seg.xy - u_min) * u_res, p1 = (i_seg.zw - u_min) * u_res;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  float h = i_half * u_res + 1.0;
  vec2 p = (a_corner.x < 0.0 ? p0 - dir * h : p1 + dir * h) + vec2(-dir.y, dir.x) * a_corner.y * h;
  v_p = p; v_seg = vec4(p0, p1); v_half = i_half * u_res; v_color = i_color;
  gl_Position = vec4(p / u_tex * 2.0 - 1.0, 0.0, 1.0);
}`;

const STAMP_FS = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec4 v_seg; flat in float v_half; flat in vec4 v_color;
out vec4 o;
void main() {
  vec2 pa = v_p - v_seg.xy, ba = v_seg.zw - v_seg.xy;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float a = v_color.a * clamp(v_half - length(pa - ba * t) + 0.5, 0.0, 1.0);
  o = vec4(v_color.rgb * a, a);
}`;

/** Largest mark texture side (px): a bigger venue gets coarser marks rather than a texture the GPU can't hold. */
const MARK_MAX_PX = 8192;

/** Car numbers and labels, rendered once each into a texture (white: tinted when drawn). */
class GlyphAtlas {
  static readonly FONT = 48;
  static readonly CELL = 64;
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly entries = new Map<string, { uv: [number, number, number, number]; w: number }>();
  private x = 0;
  private y = 0;
  dirty = true;

  constructor() {
    this.canvas.width = this.canvas.height = 1024;
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** Where `text` is in the atlas (u0, v0, u1, v1) and its width in atlas px. */
  get(text: string): { uv: [number, number, number, number]; w: number } {
    let e = this.entries.get(text);
    if (e) return e;
    const ctx = this.ctx, S = this.canvas.width, C = GlyphAtlas.CELL;
    ctx.font = `700 ${GlyphAtlas.FONT}px system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    if (this.x + w > S) { this.x = 0; this.y += C; }
    if (this.y + C > S) {
      // Full (never, with car numbers): start over.
      ctx.clearRect(0, 0, S, S);
      this.entries.clear();
      this.x = this.y = 0;
    }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.x + w / 2, this.y + C / 2);
    e = { uv: [this.x / S, this.y / S, (this.x + w) / S, (this.y + C) / S], w };
    this.entries.set(text, e);
    this.x += w;
    this.dirty = true;
    return e;
  }
}

/** A buffer of floats written each frame, its GPU buffer, and how to draw from it. */
interface Stream {
  batch: FloatBatch;
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
}

interface Gpu {
  fill: Program; line: Program; sprite: Program; shape: Program; marks: Program; stamp: Program;
  fillBuffer: WebGLBuffer; fillVao: WebGLVertexArrayObject;
  lineBuffer: WebGLBuffer; lineVao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  marksQuad: WebGLBuffer; marksVao: WebGLVertexArrayObject;
  /** Puffs, cars and officials, attenuators; trails, debug arrows; groove and skid stamps. */
  puffs: Stream; cars: Stream; discs: Stream;
  trails: Stream; arrows: Stream;
  stamps: Stream;
  atlas: WebGLTexture;
  timer: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; pending: WebGLQuery[] } | null;
}

interface Marks {
  groove: WebGLTexture; skids: WebGLTexture;
  grooveFb: WebGLFramebuffer; skidsFb: WebGLFramebuffer;
  w: number; h: number; res: number; minX: number; minY: number;
}

/** Can this browser draw the track with WebGL2? */
export function webgl2Available(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export class GlRenderer implements TrackView {
  readonly kind = 'webgl2';
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private gpu: Gpu | null = null;
  private lost = false;
  private track: Track | null = null;
  private mesh: VenueMesh | null = null;
  private meshStale = false;
  private marks: Marks | null = null;
  private fitScale = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  /** -1 to draw the world mirrored left to right (a real clockwise track, raced as its mirror image). */
  private mirror: 1 | -1 = 1;
  private dpr = 1;
  private zoom = 1;
  private focusX = 0;
  private focusY = 0;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private debugLayers: DebugLayers = { inputs: true, forces: false, banking: false, draft: false };
  dotMode: DotMode = 'legible';
  effects = true;
  effectsPaused = false;
  drafting = true;
  private effectsWere = true;
  private readonly exhaust = new Exhaust();
  /** The draft's wind walls (draft.ts), and the streaks' buffer, reused frame to frame. */
  private readonly windWalls = new DraftWall();
  private readonly streaks: number[] = [];
  private draftClock = performance.now();
  /** Damaged cars' smoke (the second damage model: damage.ts). */
  private readonly smoke = new Smoke();
  private readonly atlas = new GlyphAtlas();
  /** Text the GPU doesn't draw (the banking debug labels), on a 2D canvas over this one; made when first needed. */
  private overlay: HTMLCanvasElement | null = null;
  private overlayShown = false;
  /** For the performance readout: meshes built and the ms that took, draw calls last frame, GPU ms per frame. */
  readonly stats = { records: 0, recordMs: 0, ops: 0, gpuMs: null as number | null };

  /** Throws if there's no WebGL2 here (see webgl2Available). */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, stencil: true, alpha: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.gpu = null;
      this.marks = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
    });
    this.init();
  }

  get debug(): Readonly<DebugLayers> {
    return this.debugLayers;
  }

  setDebug(layer: keyof DebugLayers, on: boolean): void {
    this.debugLayers[layer] = on;
    if (layer === 'banking') this.meshStale = true;
  }

  // ---------- GPU resources ----------

  private init(): void {
    const gl = this.gl;
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const stream = (prog: Program, layout: Array<[string, number]>, instanced: boolean): Stream => {
      const buffer = gl.createBuffer()!;
      const vao = instanced ? this.instancedArray(prog, buffer, layout, quad) : vertexArray(gl, prog, buffer, layout);
      return { batch: new FloatBatch(), buffer, vao };
    };
    const fill = program(gl, FILL_VS, FILL_FS);
    const line = program(gl, LINE_VS, LINE_FS);
    const sprite = program(gl, SPRITE_VS, SPRITE_FS);
    const shape = program(gl, SHAPE_VS, SHAPE_FS);
    const marks = program(gl, MARKS_VS, MARKS_FS);
    const stamp = program(gl, STAMP_VS, STAMP_FS);
    const fillBuffer = gl.createBuffer()!, lineBuffer = gl.createBuffer()!, marksQuad = gl.createBuffer()!;
    const atlas = gl.createTexture()!;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.gpu = {
      fill, line, sprite, shape, marks, stamp, quad,
      fillBuffer, fillVao: vertexArray(gl, fill, fillBuffer, FILL_LAYOUT),
      lineBuffer, lineVao: vertexArray(gl, line, lineBuffer, LINE_LAYOUT),
      marksQuad, marksVao: vertexArray(gl, marks, marksQuad, [['a_pos', 2]]),
      puffs: stream(sprite, SPRITE_LAYOUT, true),
      cars: stream(sprite, SPRITE_LAYOUT, true),
      discs: stream(sprite, SPRITE_LAYOUT, true),
      trails: stream(shape, SHAPE_LAYOUT, false),
      arrows: stream(shape, SHAPE_LAYOUT, false),
      stamps: stream(stamp, STAMP_LAYOUT, true),
      atlas,
      timer: ext ? { ext, pending: [] } : null,
    };
    this.atlas.dirty = true;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.track) {
      this.uploadMesh();
      this.makeMarks();
    }
  }

  /** A vertex array for instanced quads: corners per vertex, the layout per instance. */
  private instancedArray(prog: Program, buffer: WebGLBuffer, layout: Array<[string, number]>, quad: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = vertexArray(gl, prog, buffer, layout, true);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    const loc = prog.attrib.a_corner;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private uploadMesh(): void {
    const gl = this.gl, gpu = this.gpu;
    if (!gpu || !this.track) return;
    const started = performance.now();
    this.mesh = buildVenueMesh(this.track, this.debugLayers.banking);
    this.meshStale = false;
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.fillBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.fill, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.line, gl.STATIC_DRAW);
    this.stats.records++;
    this.stats.recordMs += performance.now() - started;
  }

  /** Mark textures over the track's bounds, as fine as the GPU allows up to MARK_RES px per metre. */
  private makeMarks(): void {
    const gl = this.gl, track = this.track;
    if (!track || !this.gpu) return;
    if (this.marks) {
      gl.deleteTexture(this.marks.groove); gl.deleteTexture(this.marks.skids);
      gl.deleteFramebuffer(this.marks.grooveFb); gl.deleteFramebuffer(this.marks.skidsFb);
    }
    const b = track.bounds;
    const most = Math.min(MARK_MAX_PX, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const res = Math.min(MARK_RES, most / (b.maxX - b.minX), most / (b.maxY - b.minY));
    const w = Math.ceil((b.maxX - b.minX) * res), h = Math.ceil((b.maxY - b.minY) * res);
    const target = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return [tex, fb] as const;
    };
    const [groove, grooveFb] = target(), [skids, skidsFb] = target();
    this.marks = { groove, skids, grooveFb, skidsFb, w, h, res, minX: b.minX, minY: b.minY };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gpu.marksQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      b.minX, b.minY, b.maxX, b.minY, b.minX, b.maxY, b.maxX, b.maxY,
    ]), gl.STATIC_DRAW);
    this.clearMarks();
  }

  // ---------- the track and the camera ----------

  setTrack(track: Track): void {
    this.track = track;
    this.mirror = track.layout.params?.drawnMirrored ? -1 : 1;
    this.uploadMesh();
    this.makeMarks();
    this.exhaust.reset();
    this.smoke.reset();
    this.resize();
  }

  /** Match the canvas to its size on screen (call when that changes), and refit the track to it. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.overlay && (this.overlay.width !== w || this.overlay.height !== h)) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    const track = this.track;
    if (!track) return;
    const b = track.bounds;
    const pad = 24 * this.dpr;
    const ins = this.insets, px = this.dpr;
    const fitW = w - 2 * pad - (ins.left + ins.right) * px;
    const fitH = h - 2 * pad - (ins.top + ins.bottom) * px;
    this.fitScale = Math.max(1e-3, Math.min(fitW / (b.maxX - b.minX), fitH / (b.maxY - b.minY)));
    this.updateTransform();
  }

  /** Keep these edges of the view (CSS px) clear of the track: it fits, and the camera centres, in what's left. */
  setInsets(insets: Partial<Insets>): void {
    const next = { ...this.insets, ...insets };
    const old = this.insets;
    if (next.top === old.top && next.right === old.right && next.bottom === old.bottom && next.left === old.left) return;
    this.insets = next;
    this.resize();
  }

  /** Camera. zoom 1 frames the whole track; above 1 the view centres on (x, y) in world metres. */
  setView(zoom: number, x: number, y: number): void {
    this.zoom = zoom;
    this.focusX = x;
    this.focusY = y;
    this.updateTransform();
  }

  /** The zoom at which a box this size (world metres) takes up `share` of the view (clear of the insets). */
  zoomToFit(w: number, h: number, share = 0.6): number {
    const ins = this.insets, px = this.dpr;
    const viewW = this.canvas.width - (ins.left + ins.right) * px;
    const viewH = this.canvas.height - (ins.top + ins.bottom) * px;
    return Math.min((viewW * share) / Math.max(1, w), (viewH * share) / Math.max(1, h)) / this.fitScale;
  }

  private updateTransform(): void {
    const track = this.track;
    if (!track) return;
    const b = track.bounds;
    const cx = this.zoom > 1 ? this.focusX : (b.minX + b.maxX) / 2;
    const cy = this.zoom > 1 ? this.focusY : (b.minY + b.maxY) / 2;
    this.scale = this.fitScale * this.zoom;
    const ins = this.insets, px = this.dpr;
    this.offsetX = this.canvas.width / 2 + ((ins.left - ins.right) / 2) * px - this.mirror * cx * this.scale;
    this.offsetY = this.canvas.height / 2 + ((ins.top - ins.bottom) / 2) * px + cy * this.scale;
  }

  private toScreen(x: number, y: number): [number, number] {
    return [this.offsetX + this.mirror * x * this.scale, this.offsetY - y * this.scale];
  }

  // ---------- tire marks ----------

  clearMarks(): void {
    const gl = this.gl, m = this.marks;
    if (!m || this.lost) return;
    gl.clearColor(0, 0, 0, 0);
    for (const fb of [m.grooveFb, m.skidsFb]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Stamp mark strokes (from a StrokeCollector) into the groove and skid textures, where they stay. */
  stampStrokes(strokes: Float32Array): void {
    const gl = this.gl, gpu = this.gpu, m = this.marks;
    if (!gpu || !m || this.lost || !strokes.length) return;
    const groove: number[] = [], skids: number[] = [];
    const rubber = rgba(`rgb(${COLORS.rubber})`), turf = rgba(`rgb(${COLORS.turf})`), stones = rgba(`rgb(${COLORS.stones})`);
    const grooveHalf = grooveWidth() / 2;
    for (let k = 0; k + STROKE_FIELDS <= strokes.length; k += STROKE_FIELDS) {
      const x0 = strokes[k], y0 = strokes[k + 1], x1 = strokes[k + 2], y1 = strokes[k + 3];
      if (Math.random() < grooveChance({ groove: strokes[k + 4] })) {
        groove.push(x0, y0, x1, y1, grooveHalf, rubber[0], rubber[1], rubber[2], GROOVE_STROKE_ALPHA);
      }
      const ground = strokes[k + 6];
      const skid = skidStroke({ skid: strokes[k + 5], surface: ground === 1 ? 'grass' : ground === 2 ? 'gravel' : 'track' });
      if (skid) {
        const c = skid.turf ? turf : skid.gravel ? stones : rubber;
        skids.push(x0, y0, x1, y1, skid.width / 2, c[0], c[1], c[2], skid.alpha);
      }
    }
    const p = gpu.stamp;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniform.u_min, m.minX, m.minY);
    gl.uniform1f(p.uniform.u_res, m.res);
    gl.uniform2f(p.uniform.u_tex, m.w, m.h);
    gl.viewport(0, 0, m.w, m.h);
    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(gpu.stamps.vao);
    for (const [fb, data] of [[m.grooveFb, groove], [m.skidsFb, skids]] as const) {
      if (!data.length) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stamps.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / STAMP_FLOATS);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---------- drawing ----------

  /** Point a program at the camera. */
  private use(p: Program): void {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.uniform4f(p.uniform.u_cam, this.scale, this.mirror, this.offsetX, this.offsetY);
    gl.uniform2f(p.uniform.u_size, this.canvas.width, this.canvas.height);
    if (p.uniform.u_dpr) gl.uniform1f(p.uniform.u_dpr, this.dpr);
  }

  /** Stencil for plain drawing: everywhere, or only off the ovals' pavement (bit 0x80). */
  private stencilFor(offPavement: boolean): void {
    const gl = this.gl;
    gl.stencilMask(0);
    gl.stencilFunc(offPavement ? gl.EQUAL : gl.ALWAYS, 0, 0x80);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private drawItems(items: MeshItem[], offPavement: boolean): void {
    const gl = this.gl, gpu = this.gpu!;
    for (const it of items) {
      this.stats.ops++;
      if (it.kind === 'fill') {
        this.use(gpu.fill);
        gl.bindVertexArray(gpu.fillVao);
        this.stencilFor(offPavement);
        gl.drawArrays(gl.TRIANGLES, it.first, it.count);
      } else if (it.kind === 'line') {
        this.use(gpu.line);
        gl.bindVertexArray(gpu.lineVao);
        this.stencilFor(offPavement);
        gl.drawArrays(gl.TRIANGLES, it.first, it.count);
      } else if (it.kind === 'poly') {
        // Even-odd: the fan flips bit 0x01 where it covers an odd number of times; the cover paints there and clears it.
        this.use(gpu.fill);
        gl.bindVertexArray(gpu.fillVao);
        gl.colorMask(false, false, false, false);
        gl.stencilMask(0x01);
        gl.stencilFunc(offPavement ? gl.EQUAL : gl.ALWAYS, 0, 0x80);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.drawArrays(gl.TRIANGLES, it.first, it.count);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 0x01, 0x01);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
        gl.drawArrays(gl.TRIANGLES, it.coverFirst, it.coverCount);
        this.stats.ops++;
      } else {
        // Attenuators: at least 3 px across.
        const s = gpu.discs.batch;
        s.clear();
        for (const d of it.discs) {
          const r = Math.max(3 * this.dpr, d.r * this.scale);
          this.sprite(s, d.x, d.y, 0, 0, r + 1, r + 1, DISC, d.color, d.color, r, 0, 0, 0);
        }
        this.drawSprites(gpu.discs, offPavement);
      }
    }
    gl.bindVertexArray(null);
  }

  /** One instanced quad (see SPRITE_FS for what `data` means per kind). */
  private sprite(
    b: FloatBatch, x: number, y: number, ox: number, oy: number, hx: number, hy: number, kind: number,
    c: RGBA, c2: RGBA, d0: number, d1: number, d2: number, d3: number, alpha = 1,
  ): void {
    b.reserve(SPRITE_FLOATS);
    const a = b.data;
    let o = b.length;
    a[o++] = x; a[o++] = y; a[o++] = ox; a[o++] = oy; a[o++] = hx; a[o++] = hy; a[o++] = kind;
    a[o++] = c[0]; a[o++] = c[1]; a[o++] = c[2]; a[o++] = c[3] * alpha;
    a[o++] = c2[0]; a[o++] = c2[1]; a[o++] = c2[2]; a[o++] = c2[3] * alpha;
    a[o++] = d0; a[o++] = d1; a[o++] = d2; a[o++] = d3;
    b.length = o;
  }

  /** One triangle vertex at a world point, offset px along world directions. */
  private shape(b: FloatBatch, x: number, y: number, ox: number, oy: number, c: RGBA, alpha: number): void {
    b.reserve(SHAPE_FLOATS);
    const a = b.data;
    let o = b.length;
    a[o++] = x; a[o++] = y; a[o++] = ox; a[o++] = oy; a[o++] = c[0]; a[o++] = c[1]; a[o++] = c[2]; a[o++] = c[3] * alpha;
    b.length = o;
  }

  /** A line from a to b (px from the world point, along world directions), w px wide. */
  private shapeLine(b: FloatBatch, x: number, y: number, ax: number, ay: number, bx: number, by: number, w: number, c: RGBA, alpha: number): void {
    const dx = bx - ax, dy = by - ay, m = Math.hypot(dx, dy) || 1;
    const nx = (-dy / m) * w / 2, ny = (dx / m) * w / 2;
    for (const [px, py] of [[ax + nx, ay + ny], [ax - nx, ay - ny], [bx + nx, by + ny], [bx + nx, by + ny], [ax - nx, ay - ny], [bx - nx, by - ny]]) {
      this.shape(b, x, y, px, py, c, alpha);
    }
  }

  private drawSprites(s: Stream, offPavement = false): void {
    const gl = this.gl, gpu = this.gpu!;
    if (!s.batch.length) return;
    this.use(gpu.sprite);
    this.stencilFor(offPavement);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.atlas);
    gl.uniform1i(gpu.sprite.uniform.u_atlas, 0);
    s.batch.upload(gl, s.buffer);
    gl.bindVertexArray(s.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.batch.length / SPRITE_FLOATS);
    gl.bindVertexArray(null);
    this.stats.ops++;
  }

  private drawShapes(s: Stream): void {
    const gl = this.gl, gpu = this.gpu!;
    if (!s.batch.length) return;
    this.use(gpu.shape);
    this.stencilFor(false);
    s.batch.upload(gl, s.buffer);
    gl.bindVertexArray(s.vao);
    gl.drawArrays(gl.TRIANGLES, 0, s.batch.length / SHAPE_FLOATS);
    gl.bindVertexArray(null);
    this.stats.ops++;
  }

  render(
    cars: RenderCar[], liveryOf: (car: RenderCar) => Livery | undefined, highlight: readonly RenderCar[] = [],
    officials: RenderOfficials = { paceCar: null, wreckers: [] },
  ): void {
    const gl = this.gl, gpu = this.gpu, track = this.track;
    if (this.lost || !gpu) return;
    if (this.meshStale) this.uploadMesh();
    this.stats.ops = 0;
    const timer = this.beginTimer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = rgba(COLORS.background);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    const mesh = this.mesh;
    if (track && mesh) {
      this.drawVenue(mesh);
      this.drawOverlay(track);
      this.drawCars(cars, liveryOf, highlight, officials);
    }
    gl.disable(gl.STENCIL_TEST);
    this.endTimer(timer);
  }

  /** Pavement mask, every track's surfaces, the tire marks, then every track's lines. */
  private drawVenue(mesh: VenueMesh): void {
    const gl = this.gl, gpu = this.gpu!;
    const fill = gpu.fill;
    this.use(fill);
    const mow = rgba(COLORS.grassStripe), red = rgba(COLORS.paintRed), blue = rgba(COLORS.paintBlue);
    gl.uniform3f(fill.uniform.u_mow, mow[0], mow[1], mow[2]);
    gl.uniform4f(fill.uniform.u_red, red[0], red[1], red[2], red[3]);
    gl.uniform4f(fill.uniform.u_blue, blue[0], blue[1], blue[2], blue[3]);
    if (mesh.pavement) {
      gl.bindVertexArray(gpu.fillVao);
      gl.colorMask(false, false, false, false);
      gl.stencilMask(0x80);
      gl.stencilFunc(gl.ALWAYS, 0x80, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.drawArrays(gl.TRIANGLES, mesh.pavement.first, mesh.pavement.count);
      gl.colorMask(true, true, true, true);
      this.stats.ops++;
    }
    for (const part of mesh.parts) this.drawItems(part.base, part.baseOffPavement);
    const m = this.marks;
    if (m) {
      const p = gpu.marks;
      this.use(p);
      this.stencilFor(false);
      gl.uniform2f(p.uniform.u_min, m.minX, m.minY);
      gl.uniform1f(p.uniform.u_res, m.res);
      gl.uniform2f(p.uniform.u_tex, m.w, m.h);
      gl.uniform1f(p.uniform.u_grooveAlpha, GROOVE_DISPLAY_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, m.groove);
      gl.uniform1i(p.uniform.u_groove, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, m.skids);
      gl.uniform1i(p.uniform.u_skids, 1);
      gl.bindVertexArray(gpu.marksVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
      this.stats.ops++;
    }
    for (const part of mesh.parts) this.drawItems(part.lines, part.linesOffPavement);
  }

  /** The banking debug labels and legend: text, on a 2D canvas over the view. */
  private drawOverlay(track: Track): void {
    const want = this.debugLayers.banking;
    if (!want && !this.overlayShown) return;
    if (!this.overlay) {
      const c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      this.canvas.after(c);
      this.overlay = c;
      this.resize();
    }
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.overlayShown = want;
    if (!want) return;
    paintBankLabels(ctx, track, (x, y) => this.toScreen(x, y), this.dpr);
    paintBankLegend(ctx, this.overlay.height, this.dpr);
  }

  private drawCars(
    cars: RenderCar[], liveryOf: (car: RenderCar) => Livery | undefined, highlight: readonly RenderCar[], officials: RenderOfficials,
  ): void {
    const gpu = this.gpu!, dpr = this.dpr;
    const minR = (this.dotMode === 'legible' ? 8 : 2.5) * dpr;
    const r = Math.max(minR, P.CAR_RADIUS * this.scale);
    const showNumbers = r >= 6 * dpr;
    const w = this.canvas.width, h = this.canvas.height;

    const effects = this.effects && !this.effectsPaused;
    if (effects !== this.effectsWere) {
      this.exhaust.reset(); // trails start afresh rather than joining across the gap
      this.smoke.reset();
      this.effectsWere = effects;
    }
    const trails = gpu.trails.batch, puffs = gpu.puffs.batch;
    trails.clear();
    puffs.clear();
    // Who's in whose air, for the wind walls and the draft debug.
    const links = this.drafting && (effects || this.debugLayers.draft) ? draftLinks(cars, this.track!) : [];
    const clock = performance.now(), dt = Math.min(0.1, (clock - this.draftClock) / 1000);
    this.draftClock = clock;
    let smokeNow: number | null = null;
    if (effects) {
      this.windWalls.advance(links, dt);
      this.windWall(trails, links, r);
      // Only cars under their own power smoke; the rest drop their trails.
      const running = cars
        .filter((c) => !c.variant && !c.retired && !c.cleared && !c.towed && !c.parked)
        .map((car) => ({ car, color: liveryOf(car)?.border ?? FALLBACK_BORDER }));
      const now = this.exhaust.advance(running);
      for (const { car, color } of running) this.trail(car, color, r);
      for (const p of this.exhaust.livePuffs(now)) {
        const age = (now - p.born) / p.life;
        const spread = 1 + age;
        const rad = r * p.size * (1 + (EXHAUST.PUFF_GROWTH - 1) * Math.sqrt(age));
        this.sprite(puffs, p.x, p.y, p.ox * spread * r, -p.oy * spread * r, rad, rad, PUFF, rgba(p.color), rgba(p.color),
          rad, 0, 0, 0, p.alpha * (1 - age) * (1 - age));
      }
      // Damaged cars smoke from the nose (a wreck still on track too): health comes with every car's view. (Under
      // the race's damage model: the first has no smoke.) Drawn over the cars, below.
      const model = damageModel(this.track?.kind ?? 'oval');
      smokeNow = this.smoke.advance(cars
        .filter((c) => !c.variant && !c.cleared && !c.towed && !c.parked)
        .map((c) => ({ id: c.id, x: c.x, y: c.y, frameX: c.frameX, frameY: c.frameY, health: (c as RenderCar & { health?: number }).health ?? 1, damageModel: model })));
    }
    this.drawShapes(gpu.trails);
    this.drawSprites(gpu.puffs);

    // Back to front by track position so leaders sit on top in a pack; debug arrows under the cars.
    const arrows = gpu.arrows.batch, sprites = gpu.cars.batch;
    arrows.clear();
    sprites.clear();
    const order = [...cars].sort((a, c) => Number(!!c.variant) - Number(!!a.variant) || a.dist - c.dist);
    for (const car of order) {
      const [sx, sy] = this.toScreen(car.x, car.y);
      if (sx < -50 || sy < -50 || sx > w + 50 || sy > h + 50) continue;
      const livery = liveryOf(car);
      const fill = rgba(livery?.fill ?? car.color);
      const border = rgba(livery?.border ?? FALLBACK_BORDER);
      if (car.variant) {
        // A practice variation: a faint dot in the student's colour, under the students.
        if (!car.retired) this.sprite(sprites, car.x, car.y, 0, 0, r * 0.5 + 1, r * 0.5 + 1, DISC, fill, fill, r * 0.5, 0, 0, 0, 0.28);
        continue;
      }
      if (this.debugLayers.forces && !car.retired) this.forceArrows(arrows, car, r);
      if (this.debugLayers.inputs && !car.retired) {
        // The driver's acceleration request in world space; length = input magnitude.
        const mag = Math.hypot(car.inputX, car.inputY);
        const wx = (car.inputX * car.frameX - car.inputY * car.frameY) / Math.max(1e-6, mag);
        const wy = (car.inputX * car.frameY + car.inputY * car.frameX) / Math.max(1e-6, mag);
        const len = r + 22 * dpr * Math.min(1, mag);
        this.shapeLine(arrows, car.x, car.y, wx * r, wy * r, wx * len, wy * len, 1.5 * dpr, fill, 0.8);
      }
      if (car.cleared && !car.towed && !car.parked) continue;
      const alpha = car.retired ? 0.35 : 1;
      // Border ring, the trim ring, then the fill, then the number.
      this.sprite(sprites, car.x, car.y, 0, 0, r + 1, r + 1, DISC, border, border, r, 0, 0, 0, alpha);
      const inner = r * (showNumbers ? 0.72 : 0.58);
      if (livery?.trim) this.trimRing(sprites, car.x, car.y, r, inner, rgba(livery.trim), alpha);
      this.sprite(sprites, car.x, car.y, 0, 0, inner + 1, inner + 1, DISC, fill, fill, inner, 0, 0, 0, alpha);
      if (showNumbers && livery) {
        const text = livery.label ?? String(livery.number);
        this.text(sprites, car.x, car.y, inner * 0.06, text, inner * (text.length > 1 ? 1.15 : 1.35), rgba(numberColor(livery.fill)), alpha);
      }
      if (highlight.includes(car)) {
        const R = r + 3 * dpr + 0.75 * dpr;
        this.sprite(sprites, car.x, car.y, 0, 0, R + 1, R + 1, DISC, [1, 1, 1, 1], [1, 1, 1, 1], R, 1.5 * dpr, 0, 0);
      }
    }
    if (this.debugLayers.draft) this.draftDebug(arrows, sprites, links);
    this.officials(sprites, officials, r);
    this.drawShapes(gpu.arrows);
    if (this.atlas.dirty) this.uploadAtlas();
    this.drawSprites(gpu.cars);

    // Smoke over the cars, faint: a haze they show through, drifting off on the breeze (smoke.ts).
    if (smokeNow !== null) {
      puffs.clear();
      const soot = rgba(SMOKE.COLOR);
      for (const p of this.smoke.livePuffs(smokeNow)) {
        const age = (smokeNow - p.born) / p.life, seconds = smokeNow - p.born;
        const rad = r * p.size * (1 + (SMOKE.GROWTH - 1) * Math.sqrt(age));
        const ox = (p.ox * (1 + age) + p.dx * seconds) * r, oy = (p.oy * (1 + age) + p.dy * seconds) * r;
        // (Faded in over the first third of its life: thickest a little downwind of the car, not hugging it like a
        // shadow.)
        this.sprite(puffs, p.x, p.y, ox, -oy, rad, rad, PUFF, soot, soot, rad, 0, 0, 0, p.alpha * (1 - age) * Math.min(1, 0.15 + 2.5 * age));
      }
      this.drawSprites(gpu.puffs);
    }
  }

  /**
   * The draft's wind wall (draft.ts): a faint band down both flanks of every
   * link, thin streaks flowing back over it (bright at the front, gone at the
   * back), and a bow wave round the nose of each train's front car. Under the
   * cars and their trails.
   */
  private windWall(b: FloatBatch, links: readonly DraftLink<RenderCar>[], r: number): void {
    if (!links.length) return;
    const track = this.track!, dpr = this.dpr, buf = this.streaks;
    const air = rgba(DRAFT_FX.COLOR);
    const hw = 0.6 * dpr;
    // The band: across each flank, clear at the pocket's edge, peaking at the inner lane, clear past the outer one.
    const across = [DRAFT_FX.WALL_INSET - 0.45, DRAFT_FX.WALL_INSET, DRAFT_FX.WALL_INSET + DRAFT_FX.LANES * DRAFT_FX.LANE_STEP].map((u) => u * r);
    const peak = [0, 1, 0];
    const m = this.windWalls.bands(links, track, buf);
    for (let k = 0; k + 1 < m; k++) {
      const o = k * BAND_FIELDS, p = o + BAND_FIELDS;
      if (Number.isNaN(buf[o]) || Number.isNaN(buf[p])) continue;
      const [ax, ay] = track.toWorld(buf[o], buf[o + 1]), [bx, by] = track.toWorld(buf[p], buf[p + 1]);
      const ai = track.indexAt(buf[o]), bi = track.indexAt(buf[p]);
      const anx = -track.ty[ai], any = track.tx[ai], bnx = -track.ty[bi], bny = track.tx[bi];
      for (const side of [-1, 1]) {
        for (let j = 0; j < 2; j++) {
          const u0 = side * across[j], u1 = side * across[j + 1];
          const a0 = buf[o + 2], b0 = buf[p + 2];
          this.shape(b, ax, ay, anx * u0, any * u0, air, a0 * peak[j]);
          this.shape(b, ax, ay, anx * u1, any * u1, air, a0 * peak[j + 1]);
          this.shape(b, bx, by, bnx * u0, bny * u0, air, b0 * peak[j]);
          this.shape(b, bx, by, bnx * u0, bny * u0, air, b0 * peak[j]);
          this.shape(b, ax, ay, anx * u1, any * u1, air, a0 * peak[j + 1]);
          this.shape(b, bx, by, bnx * u1, bny * u1, air, b0 * peak[j + 1]);
        }
      }
    }
    const n = this.windWalls.streaks(links, track, (DRAFT_FX.MIN_PX * dpr) / this.scale, buf);
    for (let k = 0; k < n; k++) {
      const o = k * STREAK_FIELDS;
      const d = buf[o + 2], off = buf[o + 3] * r, alpha = buf[o + 4];
      const [fx, fy] = track.toWorld(buf[o], d), [bx, by] = track.toWorld(buf[o + 1], d);
      const fi = track.indexAt(buf[o]), bi = track.indexAt(buf[o + 1]);
      // Across the track (the normal toWorld offsets d along), at each end.
      const fnx = -track.ty[fi], fny = track.tx[fi], bnx = -track.ty[bi], bny = track.tx[bi];
      this.shape(b, fx, fy, fnx * (off + hw), fny * (off + hw), air, alpha);
      this.shape(b, fx, fy, fnx * (off - hw), fny * (off - hw), air, alpha);
      this.shape(b, bx, by, bnx * (off + hw), bny * (off + hw), air, 0);
      this.shape(b, bx, by, bnx * (off + hw), bny * (off + hw), air, 0);
      this.shape(b, fx, fy, fnx * (off - hw), fny * (off - hw), air, alpha);
      this.shape(b, bx, by, bnx * (off - hw), bny * (off - hw), air, 0);
    }
    // The bow wave: two arcs ahead of the car breaking the air, meeting the walls at its sides.
    const SEG = 14;
    for (const { car, effect } of draftHeads(links)) {
      const i = track.indexAt(car.s);
      const tx = track.tx[i], ty = track.ty[i], nx = -ty, ny = tx;
      for (let ring = 0; ring < 2; ring++) {
        const R = r * (DRAFT_FX.WALL_INSET + ring * DRAFT_FX.LANE_STEP);
        const a = DRAFT_FX.BOW_ALPHA * Math.sqrt(effect) * (ring ? 0.5 : 1);
        for (let j = 0; j < SEG; j++) {
          const t0 = -Math.PI / 2 + (Math.PI * j) / SEG, t1 = t0 + Math.PI / SEG;
          const ux0 = tx * Math.cos(t0) + nx * Math.sin(t0), uy0 = ty * Math.cos(t0) + ny * Math.sin(t0);
          const ux1 = tx * Math.cos(t1) + nx * Math.sin(t1), uy1 = ty * Math.cos(t1) + ny * Math.sin(t1);
          // Brightest dead ahead, fading round to the sides where the walls' streaks take over.
          const a0 = a * (0.2 + 0.8 * Math.cos(t0)), a1 = a * (0.2 + 0.8 * Math.cos(t1));
          this.shape(b, car.x, car.y, ux0 * (R + hw), uy0 * (R + hw), air, a0);
          this.shape(b, car.x, car.y, ux0 * (R - hw), uy0 * (R - hw), air, a0);
          this.shape(b, car.x, car.y, ux1 * (R + hw), uy1 * (R + hw), air, a1);
          this.shape(b, car.x, car.y, ux1 * (R + hw), uy1 * (R + hw), air, a1);
          this.shape(b, car.x, car.y, ux0 * (R - hw), uy0 * (R - hw), air, a0);
          this.shape(b, car.x, car.y, ux1 * (R - hw), uy1 * (R - hw), air, a1);
        }
      }
    }
  }

  /** The draft debug layer: a line from each car to the car whose air it's in, labelled with the drag it saves. */
  private draftDebug(lines: FloatBatch, labels: FloatBatch, links: readonly DraftLink<RenderCar>[]): void {
    const dpr = this.dpr, color = rgba('#7dd3fc');
    for (const { follower: A, leader: B, strength } of links) {
      const dx = B.x - A.x, dy = B.y - A.y, m = Math.hypot(dx, dy) || 1;
      const w = (1 + 2 * strength) * dpr / 2;
      const px = (-dy / m) * w, py = (dx / m) * w;
      const alpha = 0.35 + 0.65 * strength;
      for (const [x, y, s] of [[A.x, A.y, 1], [A.x, A.y, -1], [B.x, B.y, 1], [B.x, B.y, 1], [A.x, A.y, -1], [B.x, B.y, -1]]) {
        this.shape(lines, x, y, px * s, py * s, color, alpha);
      }
      this.text(labels, (A.x + B.x) / 2, (A.y + B.y) / 2, 0, `-${Math.round(P.DRAFT_MAX * strength * 100)}%`, 10 * dpr, color, 1);
    }
  }

  /** The livery's trim: a thin disc just wider than the fill (`inner`), drawn over the border, under the fill. */
  private trimRing(b: FloatBatch, x: number, y: number, r: number, inner: number, color: RGBA, alpha: number): void {
    const R = Math.min(r - 0.5 * this.dpr, inner + Math.max(this.dpr, r * 0.1));
    this.sprite(b, x, y, 0, 0, R + 1, R + 1, DISC, color, color, R, 0, 0, 0, alpha);
  }

  /** Text centred on a world point, nudged down `dy` px, `size` px tall (the font size it's drawn at). */
  private text(b: FloatBatch, x: number, y: number, dy: number, text: string, size: number, color: RGBA, alpha: number): void {
    const g = this.atlas.get(text);
    const k = size / GlyphAtlas.FONT;
    this.sprite(b, x, y, 0, dy, (g.w / 2) * k, (GlyphAtlas.CELL / 2) * k, GLYPH, color, color, g.uv[0], g.uv[1], g.uv[2], g.uv[3], alpha);
  }

  private uploadAtlas(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.gpu!.atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.atlas.dirty = false;
  }

  /**
   * Horizontal forces per unit mass, 1 g = 26 px: the banking's push toward
   * the infield (amber) and what the tires are doing (cyan).
   */
  private forceArrows(b: FloatBatch, car: RenderCar, r: number): void {
    const track = this.track!, dpr = this.dpr;
    const FORCE_PX = 26 * dpr;
    const i = car.trackIdx;
    const nx = -track.ty[i], ny = track.tx[i];
    const tx = car.tireLon * car.frameX - car.tireLat * car.frameY;
    const ty = car.tireLon * car.frameY + car.tireLat * car.frameX;
    const arrow = (ax: number, ay: number, color: RGBA) => {
      const m = Math.hypot(ax, ay);
      if (m < 0.05 * G) return;
      const ux = ax / m, uy = ay / m;
      const len = r + FORCE_PX * (m / G);
      this.shapeLine(b, car.x, car.y, ux * r, uy * r, ux * len, uy * len, 2 * dpr, color, 1);
      const hd = 5 * dpr;
      // The head: a triangle back from the tip.
      for (const [px, py] of [[ux * len, uy * len], [ux * (len - hd) - uy * hd * 0.6, uy * (len - hd) + ux * hd * 0.6], [ux * (len - hd) + uy * hd * 0.6, uy * (len - hd) - ux * hd * 0.6]]) {
        this.shape(b, car.x, car.y, px, py, color, 1);
      }
    };
    arrow(nx * car.bankAcc, ny * car.bankAcc, rgba('#f5c518'));
    arrow(tx, ty, rgba('#4fd1ff'));
  }

  /**
   * Pace car (white, amber light bar) and wreckers (orange, a size up: trucks), dots like the cars, always on show:
   * lights flashing while they're at work, dark parked at their posts.
   */
  private officials(b: FloatBatch, o: RenderOfficials, carR: number): void {
    const dpr = this.dpr;
    const flash = Math.floor(performance.now() / 250) % 2 === 0;
    const light = rgba('rgba(245, 197, 24, 0.35)');
    const dot = (x: number, y: number, livery: Livery, lit: boolean, r = carR) => {
      if (lit && flash) this.sprite(b, x, y, 0, 0, r * 1.9 + 1, r * 1.9 + 1, DISC, light, light, r * 1.9, 0, 0, 0);
      const border = rgba(livery.border), fill = rgba(livery.fill);
      this.sprite(b, x, y, 0, 0, r + 1, r + 1, DISC, border, border, r, 0, 0, 0);
      const inner = r * 0.72;
      if (livery.trim) this.trimRing(b, x, y, r, inner, rgba(livery.trim), 1);
      this.sprite(b, x, y, 0, 0, inner + 1, inner + 1, DISC, fill, fill, inner, 0, 0, 0);
      const label = livery.label;
      if (label && r >= 6 * dpr) this.text(b, x, y, inner * 0.06, label, inner * (label.length > 1 ? 1.05 : 1.35), rgba(numberColor(livery.fill)), 1);
    };
    if (o.paceCar) dot(o.paceCar.x, o.paceCar.y, PACE_CAR_LIVERY, o.paceCar.out !== false);
    const truckR = carR * (TRUCK.RADIUS / P.CAR_RADIUS);
    for (const wk of o.wreckers) {
      if (wk.phase !== 'done') dot(wk.x, wk.y, WRECKER_LIVERY, wk.phase !== 'idle' && wk.phase !== 'return', truckR);
    }
  }

  /**
   * The air the car pushes through: a soft envelope round the nose that
   * streams back along its recent path, narrowing to a point and fading out.
   * Brightest along the middle and at the car, clear at the edges.
   */
  private trail(car: RenderCar, color: string, r: number): void {
    const tail = this.exhaust.trail(car.id);
    const over = car.speed - EXHAUST.TRAIL_START_SPEED;
    if (!tail || over <= 0) return;
    const dpr = this.dpr, scale = this.scale;
    // 0 at the start speed, 1 at full: length, width and opacity all grow with it.
    const pace = Math.min(1, over / (EXHAUST.TRAIL_FULL_SPEED - EXHAUST.TRAIL_START_SPEED));
    const lengthM = Math.max(over * EXHAUST.TRAIL_LENGTH_PER_MS, (pace * EXHAUST.TRAIL_MIN_PX * dpr) / scale);
    // The centreline, car first: world points and how far along the trail each is.
    const P = this.trailPoints(tail.pts.length / 2 + 2);
    let n = 0;
    const put = (x: number, y: number, u: number) => { P[n * 3] = x; P[n * 3 + 1] = y; P[n * 3 + 2] = u; n++; };
    put(car.x, car.y, 0);
    const pts = tail.pts;
    let wx = car.x, wy = car.y, done = 0;
    for (let i = pts.length - 2; i >= 0 && done < lengthM; i -= 2) {
      let bx = pts[i], by = pts[i + 1];
      let seg = Math.hypot(bx - wx, by - wy);
      if (seg < 1e-3) continue;
      if (done + seg > lengthM) {
        const f = (lengthM - done) / seg;
        bx = wx + (bx - wx) * f;
        by = wy + (by - wy) * f;
        seg = lengthM - done;
      }
      done += seg;
      wx = bx; wy = by;
      // Thin out points closer than a couple of px; keep the true end.
      if (Math.hypot(bx - P[(n - 1) * 3], by - P[(n - 1) * 3 + 1]) * scale < 2 * dpr && done < lengthM) continue;
      put(bx, by, done);
    }
    if (n < 2) return;
    const total = P[(n - 1) * 3 + 2];
    for (let i = 1; i < n; i++) P[i * 3 + 2] /= total;

    const c = rgba(color);
    const A = EXHAUST.TRAIL_ALPHA * Math.min(1, 0.25 + pace * 1.5) * Math.min(1, pace * 4);
    // Across, five lanes: the rims, the core's edges, the middle. Along: bright at the car, fading out.
    const R = r * EXHAUST.TRAIL_WIDTH * (0.75 + 0.25 * pace) * EXHAUST.TRAIL_SHEATH;
    const CORE = 1 / EXHAUST.TRAIL_SHEATH;
    const LANES = [-1, -CORE, 0, CORE, 1];
    // The core about as strong as its middle (the sheath and core over each other); the sheath fading to its rim.
    const lane = (j: number, a: number) => {
      const core = 1 - (1 - 0.45 * a) * (1 - a);
      return j === 2 ? core : j === 0 || j === 4 ? 0.15 * a : 0.85 * core;
    };
    const b = this.gpu!.trails.batch;
    // Each point's row across: offset (px, world directions) and alpha per lane.
    const row = this.trailRows(n * 15);
    for (let i = 0; i < n; i++) {
      let fx: number, fy: number;
      if (i === 0) { fx = car.frameX; fy = car.frameY; } else {
        const k = Math.min(n - 1, i + 1);
        fx = P[(i - 1) * 3] - P[k * 3]; fy = P[(i - 1) * 3 + 1] - P[k * 3 + 1];
      }
      const m = Math.hypot(fx, fy) || 1;
      fx /= m; fy /= m;
      const u = P[i * 3 + 2];
      const width = R * (1 - u) ** EXHAUST.TRAIL_TAPER;
      const a = A * (u < 0.3 ? 1 - (0.45 * u) / 0.3 : 0.55 * (1 - (u - 0.3) / 0.7));
      for (let j = 0; j < 5; j++) {
        const o = i * 15 + j * 3;
        row[o] = -fy * width * LANES[j]; row[o + 1] = fx * width * LANES[j]; row[o + 2] = lane(j, a);
      }
    }
    const vertex = (i: number, j: number) => {
      const o = i * 15 + j * 3;
      this.shape(b, P[i * 3], P[i * 3 + 1], row[o], row[o + 1], c, row[o + 2]);
    };
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < 5; j++) {
        vertex(i - 1, j - 1); vertex(i - 1, j); vertex(i, j - 1);
        vertex(i, j - 1); vertex(i - 1, j); vertex(i, j);
      }
    }
    // The bow: half an ellipse round the nose, hugging it closer than the sides, joining the first row.
    const fx = car.frameX, fy = car.frameY;
    const STEPS = 8;
    const centre = lane(2, A), mid = lane(1, A), rim = lane(0, A);
    let p0x = 0, p0y = 0;
    for (let k = 0; k <= STEPS; k++) {
      const th = -Math.PI / 2 + (Math.PI * k) / STEPS;
      // Unit direction round the nose (forward squashed by the bow), then out to the core's edge and the rim.
      const dx = fx * Math.cos(th) * EXHAUST.TRAIL_BOW - fy * Math.sin(th), dy = fy * Math.cos(th) * EXHAUST.TRAIL_BOW + fx * Math.sin(th);
      if (k > 0) {
        const x = car.x, y = car.y, cr = R * CORE;
        this.shape(b, x, y, 0, 0, c, centre); this.shape(b, x, y, p0x * cr, p0y * cr, c, mid); this.shape(b, x, y, dx * cr, dy * cr, c, mid);
        this.shape(b, x, y, p0x * cr, p0y * cr, c, mid); this.shape(b, x, y, p0x * R, p0y * R, c, rim); this.shape(b, x, y, dx * cr, dy * cr, c, mid);
        this.shape(b, x, y, dx * cr, dy * cr, c, mid); this.shape(b, x, y, p0x * R, p0y * R, c, rim); this.shape(b, x, y, dx * R, dy * R, c, rim);
      }
      p0x = dx; p0y = dy;
    }
  }

  /** Scratch for trails, grown as needed: points (x, y, u), and rows of lanes (offset x, y, alpha). */
  private trailScratch = new Float64Array(1024);
  private rowScratch = new Float64Array(4096);

  private trailPoints(n: number): Float64Array {
    if (this.trailScratch.length < n * 3) this.trailScratch = new Float64Array(n * 6);
    return this.trailScratch;
  }

  private trailRows(size: number): Float64Array {
    if (this.rowScratch.length < size) this.rowScratch = new Float64Array(size * 2);
    return this.rowScratch;
  }

  // ---------- GPU timing ----------

  /** Start timing this frame on the GPU, if it can be (a few frames' results in flight at most). */
  private beginTimer(): WebGLQuery | null {
    const gl = this.gl, t = this.gpu?.timer;
    if (!t) return null;
    // Results come in a frame or two late: take any that have.
    while (t.pending.length && gl.getQueryParameter(t.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = t.pending.shift()!;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
      if (gl.getParameter(t.ext.GPU_DISJOINT_EXT)) continue;
      const ms = ns / 1e6;
      this.stats.gpuMs = this.stats.gpuMs === null ? ms : this.stats.gpuMs * 0.9 + ms * 0.1;
    }
    if (t.pending.length >= 4) return null;
    const q = gl.createQuery();
    if (!q) return null;
    gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
    return q;
  }

  private endTimer(q: WebGLQuery | null): void {
    const t = this.gpu?.timer;
    if (!q || !t) return;
    this.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
    t.pending.push(q);
  }
}
