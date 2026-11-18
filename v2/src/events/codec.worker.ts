/// <reference lib="webworker" />
import type { TapeSegment } from './tape';
import { packTape, unpackTape } from './tapeCodec';

/** Packs tapes for keeping, and unpacks kept ones, off the page's thread (a whole race takes a second or two). */

export type CodecRequest =
  | { id: number; op: 'pack'; seg: TapeSegment }
  | { id: number; op: 'unpack'; packed: Uint8Array };

export type CodecReply =
  | { id: number; packed: Uint8Array }
  | { id: number; seg: TapeSegment }
  | { id: number; error: string };

self.onmessage = async (e: MessageEvent<CodecRequest>) => {
  const msg = e.data;
  try {
    if (msg.op === 'pack') {
      const packed = await packTape(msg.seg);
      self.postMessage({ id: msg.id, packed } satisfies CodecReply, [packed.buffer]);
    } else {
      const seg = await unpackTape(msg.packed);
      self.postMessage({ id: msg.id, seg } satisfies CodecReply, [seg.bytes]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err) } satisfies CodecReply);
  }
};
