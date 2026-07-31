import type { PanelState } from "@repo/shared";
import { StillnessEngine } from "./stillness";

type Listener = (state: PanelState) => void;

declare global {
  var __visionMenuStore: VisionStore | undefined;
  var __visionMenuStoreVersion: number | undefined;
}

const STORE_VERSION = 5;

class VisionStore {
  readonly engine = new StillnessEngine();
  private listeners = new Set<Listener>();

  getState(): PanelState {
    return this.engine.getState();
  }

  ingest(...args: Parameters<StillnessEngine["ingest"]>): PanelState {
    const state = this.engine.ingest(...args);
    this.emit(state);
    return state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(state: PanelState) {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export function getVisionStore(): VisionStore {
  if (
    !globalThis.__visionMenuStore ||
    globalThis.__visionMenuStoreVersion !== STORE_VERSION
  ) {
    globalThis.__visionMenuStore = new VisionStore();
    globalThis.__visionMenuStoreVersion = STORE_VERSION;
  }
  return globalThis.__visionMenuStore;
}
