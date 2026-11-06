import type { CodecReply, CodecRequest } from './codec.worker';
import type { TapeSegment } from './tape';
import { packTape, unpackTape } from './tapeCodec';

/**
 * Packing and unpacking kept tapes (tapeCodec.ts) in a worker, so a race
 * being saved or a replay being opened doesn't freeze the view. Where a
 * worker can't be made, it's done here instead.
 */

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (r: CodecReply) => void }>();

function codec(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<CodecReply>) => {
      pending.get(e.data.id)?.resolve(e.data);
      pending.delete(e.data.id);
    };
  } catch {
    worker = null;
  }
  return worker;
}

function ask(req: CodecRequest, transfer: Transferable[]): Promise<CodecReply> {
  return new Promise((resolve) => {
    pending.set(req.id, { resolve });
    codec()!.postMessage(req, transfer);
  });
}

/**
 * Pack a tape segment for storage. Its bytes go to the worker and can't be used after, unless `keep` (then a copy
 * goes).
 */
export async function packTapeOff(seg: TapeSegment, keep = false): Promise<Uint8Array> {
  if (!codec()) return packTape(seg);
  const sent = keep ? { ...seg, bytes: seg.bytes.slice(0) } : seg;
  const reply = await ask({ id: nextId++, op: 'pack', seg: sent }, [sent.bytes]);
  if ('error' in reply) throw new Error(reply.error);
  return (reply as { packed: Uint8Array }).packed;
}

/** Unpack a stored tape. */
export async function unpackTapeOff(packed: Uint8Array): Promise<TapeSegment> {
  if (!codec()) return unpackTape(packed);
  const reply = await ask({ id: nextId++, op: 'unpack', packed }, []);
  if ('error' in reply) throw new Error(reply.error);
  return (reply as { seg: TapeSegment }).seg;
}
