import { frameFields, tapeFrameBytes, type FrameField, type TapeHeader, type TapeSegment } from './tape';

/**
 * Tapes for keeping: a tape packed small for storage (replays in IndexedDB),
 * and back.
 *
 * A tape in memory is fast to read but big (floats that change every frame
 * barely compress). For storage each field becomes a column across frames,
 * kept as whole numbers (positions to the centimetre, times to the
 * millisecond), and as the change from frame to frame: once for fields that
 * mostly hold still (laps, tires, flags: long runs of zeros), twice for ones
 * that change at a steady rate (positions, distance, time: small numbers).
 * Those go out as variable-length integers and the lot is gzipped.
 *
 * Lossy only below what the eye or the tower could show: positions within a
 * centimetre, times within a millisecond, speed within 0.05 m/s.
 */

const MAGIC = 0x31544744; // "DGT1"
/** Stands for NaN (no best lap, no race time yet) in a float column. */
const NAN = -(2 ** 31);

function read(v: DataView, at: number, f: FrameField): number {
  switch (f.type) {
    case 'f64': return v.getFloat64(at, true);
    case 'f32': return v.getFloat32(at, true);
    case 'i16': return v.getInt16(at, true);
    case 'u16': return v.getUint16(at, true);
    case 'i8': return v.getInt8(at);
    case 'u8': return v.getUint8(at);
  }
}

function write(v: DataView, at: number, f: FrameField, x: number): void {
  switch (f.type) {
    case 'f64': v.setFloat64(at, x, true); break;
    case 'f32': v.setFloat32(at, x, true); break;
    case 'i16': v.setInt16(at, x, true); break;
    case 'u16': v.setUint16(at, x, true); break;
    case 'i8': v.setInt8(at, x); break;
    case 'u8': v.setUint8(at, x); break;
  }
}

const isFloat = (f: FrameField) => f.type === 'f64' || f.type === 'f32';

/** A growing byte buffer of variable-length integers (zigzag, 7 bits a byte; exact to 2^53). */
class Varints {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  push(n: number): void {
    let z = n >= 0 ? 2 * n : -2 * n - 1;
    if (this.length + 8 > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    while (z >= 128) {
      this.buf[this.length++] = (z % 128) | 128;
      z = Math.floor(z / 128);
    }
    this.buf[this.length++] = z;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

async function gzip(bytes: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(mode === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pack a tape segment for storage. */
export async function packTape(seg: TapeSegment): Promise<Uint8Array> {
  const n = seg.header.cars.length, size = tapeFrameBytes(seg.header);
  const fields = frameFields(n, seg.header.wreckers ?? 4);
  const view = new DataView(seg.bytes);
  const out = new Varints();
  const header = new TextEncoder().encode(JSON.stringify(seg.header));
  for (const f of fields) {
    let prev = 0, prevDelta = 0;
    for (let i = 0; i < seg.count; i++) {
      const raw = read(view, i * size + f.at, f);
      const x = isFloat(f) ? (Number.isNaN(raw) ? NAN : Math.round(raw * f.scale)) : Math.round(raw / f.scale);
      const delta = x - prev;
      out.push(f.order === 2 ? delta - prevDelta : delta);
      prev = x;
      prevDelta = delta;
    }
  }
  const body = out.bytes();
  const packed = new Uint8Array(16 + header.length + body.length);
  const pv = new DataView(packed.buffer);
  pv.setUint32(0, MAGIC, true);
  pv.setUint32(4, seg.first, true);
  pv.setUint32(8, seg.count, true);
  pv.setUint32(12, header.length, true);
  packed.set(header, 16);
  packed.set(body, 16 + header.length);
  return gzip(packed, 'compress');
}

/** Unpack a stored tape into a segment (Tape.from reads it). */
export async function unpackTape(stored: Uint8Array): Promise<TapeSegment> {
  const packed = await gzip(stored, 'decompress');
  const pv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  if (pv.getUint32(0, true) !== MAGIC) throw new Error('not a stored tape');
  const first = pv.getUint32(4, true), count = pv.getUint32(8, true), headerLength = pv.getUint32(12, true);
  const header = JSON.parse(new TextDecoder().decode(packed.subarray(16, 16 + headerLength))) as TapeHeader;
  const n = header.cars.length, size = tapeFrameBytes(header);
  const bytes = new ArrayBuffer(count * size);
  const view = new DataView(bytes);
  let at = 16 + headerLength;
  const next = (): number => {
    let z = 0, mul = 1, b: number;
    do {
      b = packed[at++];
      z += (b & 127) * mul;
      mul *= 128;
    } while (b >= 128);
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  };
  for (const f of frameFields(n, header.wreckers ?? 4)) {
    let prev = 0, prevDelta = 0;
    for (let i = 0; i < count; i++) {
      const delta = f.order === 2 ? prevDelta + next() : next();
      const x = prev + delta;
      prev = x;
      prevDelta = delta;
      write(view, i * size + f.at, f, isFloat(f) ? (x === NAN ? NaN : x / f.scale) : x * f.scale);
    }
  }
  return { header, first, count, bytes };
}
