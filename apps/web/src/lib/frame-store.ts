import { Buffer } from "node:buffer";

type FrameListener = (frame: Buffer, seq: number) => void;

declare global {
  var __visionMenuFrameStore: FrameStore | undefined;
}

class FrameStore {
  private frame: Buffer | null = null;
  private seq = 0;
  private listeners = new Set<FrameListener>();

  setFrame(frame: Buffer) {
    this.frame = frame;
    this.seq += 1;
    for (const listener of this.listeners) {
      listener(frame, this.seq);
    }
  }

  getFrame(): Buffer | null {
    return this.frame;
  }

  getSeq(): number {
    return this.seq;
  }

  hasFrame(): boolean {
    return this.frame !== null && this.frame.length > 0;
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function getFrameStore(): FrameStore {
  if (!globalThis.__visionMenuFrameStore) {
    globalThis.__visionMenuFrameStore = new FrameStore();
  }
  return globalThis.__visionMenuFrameStore;
}
