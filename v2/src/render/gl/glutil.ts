/** Small WebGL2 helpers for the track view. */

/** A colour as 0..1 floats, straight (not premultiplied) alpha. */
export type RGBA = [number, number, number, number];

const parsed = new Map<string, RGBA>();

/** '#rgb', '#rrggbb', 'rgb(...)' or 'rgba(...)' to floats (anything else: white). Cached. */
export function rgba(color: string): RGBA {
  let c = parsed.get(color);
  if (c) return c;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((ch) => ch + ch).join('') : hex[1];
    c = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
  } else {
    const fn = /^rgba?\(([^)]*)\)$/i.exec(color.trim());
    const v = fn ? fn[1].split(',').map((x) => Number(x.trim())) : [];
    c = v.length >= 3 ? [v[0] / 255, v[1] / 255, v[2] / 255, v.length > 3 ? v[3] : 1] : [1, 1, 1, 1];
  }
  parsed.set(color, c);
  return c;
}

/** The same colour at a different opacity. */
export function withAlpha(c: RGBA, a: number): RGBA {
  return [c[0], c[1], c[2], c[3] * a];
}

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`shader: ${gl.getShaderInfoLog(s)}\n${source}`);
  }
  return s;
}

/** A linked program, and where its attributes and uniforms are. */
export interface Program {
  program: WebGLProgram;
  attrib: Record<string, number>;
  uniform: Record<string, WebGLUniformLocation | null>;
}

export function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const attrib: Record<string, number> = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
    const a = gl.getActiveAttrib(p, i)!;
    attrib[a.name] = gl.getAttribLocation(p, a.name);
  }
  const uniform: Record<string, WebGLUniformLocation | null> = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const u = gl.getActiveUniform(p, i)!;
    uniform[u.name] = gl.getUniformLocation(p, u.name);
  }
  return { program: p, attrib, uniform };
}

/**
 * A vertex array over one interleaved float buffer: attributes in order with
 * their sizes; `instanced` ones advance per instance rather than per vertex.
 */
export function vertexArray(
  gl: WebGL2RenderingContext, prog: Program, buffer: WebGLBuffer, layout: Array<[string, number]>, instanced = false,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = layout.reduce((n, [, size]) => n + size, 0) * 4;
  let offset = 0;
  for (const [name, size] of layout) {
    const loc = prog.attrib[name];
    if (loc !== undefined && loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      if (instanced) gl.vertexAttribDivisor(loc, 1);
    }
    offset += size * 4;
  }
  gl.bindVertexArray(null);
  return vao;
}

/** Floats per item of a layout. */
export const floats = (layout: Array<[string, number]>) => layout.reduce((n, [, size]) => n + size, 0);

/** A growable float array, written each frame and uploaded in one go. */
export class FloatBatch {
  data: Float32Array;
  length = 0;

  constructor(initial = 4096) {
    this.data = new Float32Array(initial);
  }

  /** Room for n more floats. */
  reserve(n: number): void {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  push(...values: number[]): void {
    this.reserve(values.length);
    this.data.set(values, this.length);
    this.length += values.length;
  }

  clear(): void {
    this.length = 0;
  }

  /** Upload to `buffer` (stream draw), growing it if need be. */
  upload(gl: WebGL2RenderingContext, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.length), gl.STREAM_DRAW);
  }
}

/**
 * The camera, shared by every shader: world (m, y up) to canvas px (y down)
 * as px = (off.x + mirror * x * scale, off.y - y * scale), then to clip space.
 */
export const CAMERA_GLSL = `
uniform vec4 u_cam;   // scale (px per m), mirror (1 or -1), offset x, offset y (px)
uniform vec2 u_size;  // canvas px
vec2 toScreen(vec2 w) { return vec2(u_cam.z + u_cam.y * w.x * u_cam.x, u_cam.w - w.y * u_cam.x); }
vec4 toClip(vec2 px) { return vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0); }
`;
