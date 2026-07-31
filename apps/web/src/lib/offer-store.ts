import QRCode from "qrcode";
import {
  DEFAULT_OFFER_STATE,
  OFFER_DISPLAY_MS,
  type EpaperCommand,
  type OfferState,
  type QrMatrix,
} from "@repo/shared";

type Listener = (snapshot: OfferSnapshot) => void;

export type OfferSnapshot = {
  offer: OfferState;
  epaper: EpaperCommand;
};

declare global {
  var __visionMenuOfferStore: OfferStore | undefined;
  var __visionMenuOfferStoreVersion: number | undefined;
}

const STORE_VERSION = 1;

function pickDiscountPct(): number {
  return 10 + Math.floor(Math.random() * 11);
}

function packQrModules(modules: { size: number; get(row: number, col: number): boolean | number }): QrMatrix {
  const size = modules.size;
  const bits = size * size;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  let bitIndex = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(row, col)) {
        bytes[bitIndex >> 3] |= 0x80 >> (bitIndex & 7);
      }
      bitIndex += 1;
    }
  }
  return {
    size,
    modulesB64: Buffer.from(bytes).toString("base64"),
  };
}

class OfferStore {
  private offer: OfferState = { ...DEFAULT_OFFER_STATE };
  private epaper: EpaperCommand = {
    type: "epaper",
    mode: "welcome",
    updatedAt: 0,
  };
  private expireTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();

  getSnapshot(): OfferSnapshot {
    this.expireIfNeeded();
    return { offer: this.offer, epaper: this.epaper };
  }

  getOffer(): OfferState {
    return this.getSnapshot().offer;
  }

  getEpaperCommand(): EpaperCommand {
    return this.getSnapshot().epaper;
  }

  /** Browser: person left frame — clear prompt / idle (active promo keeps running). */
  setPresence(humanPresent: boolean, now = Date.now()): OfferSnapshot | null {
    this.expireIfNeeded(now);
    if (this.offer.phase === "active") {
      return null;
    }
    if (!humanPresent && this.offer.phase !== "idle") {
      this.offer = {
        ...DEFAULT_OFFER_STATE,
        phase: "idle",
        updatedAt: now,
      };
      return this.emit();
    }
    return null;
  }

  /** Browser / server: presence long enough → show claim prompt. */
  markEligible(now = Date.now()): OfferSnapshot | null {
    this.expireIfNeeded(now);
    if (this.offer.phase !== "idle") return null;
    // Don't re-prompt while the counter ePaper is still showing a promo.
    if (this.epaper.mode === "promo") return null;
    this.offer = {
      phase: "prompt",
      discountPct: null,
      code: null,
      expiresAt: null,
      updatedAt: now,
    };
    return this.emit();
  }

  dismiss(now = Date.now()): OfferSnapshot {
    // Closing the browser modal must not cancel an active ePaper promo.
    if (this.offer.phase === "active" && this.epaper.mode === "promo") {
      this.offer = {
        ...this.offer,
        phase: "idle",
        discountPct: null,
        code: null,
        // Keep expiresAt so the timer / UI countdown still makes sense server-side.
        updatedAt: now,
      };
      return this.emit();
    }

    this.clearExpireTimer();
    this.offer = {
      ...DEFAULT_OFFER_STATE,
      phase: "idle",
      updatedAt: now,
    };
    this.epaper = { type: "epaper", mode: "welcome", updatedAt: now };
    return this.emit();
  }

  async claim(now = Date.now()): Promise<OfferSnapshot> {
    this.expireIfNeeded(now);
    const pct = pickDiscountPct();
    const code = `VISION-${pct}OFF`;
    const qrRaw = QRCode.create(code, { errorCorrectionLevel: "M" });
    const qr = packQrModules(qrRaw.modules);
    const expiresAt = now + OFFER_DISPLAY_MS;

    this.clearExpireTimer();
    this.offer = {
      phase: "active",
      discountPct: pct,
      code,
      expiresAt,
      updatedAt: now,
    };
    this.epaper = {
      type: "epaper",
      mode: "promo",
      code,
      discountPct: pct,
      expiresAt,
      qr,
      updatedAt: now,
    };
    this.expireTimer = setTimeout(() => {
      this.returnToWelcome();
    }, OFFER_DISPLAY_MS);

    return this.emit();
  }

  returnToWelcome(now = Date.now()): OfferSnapshot {
    this.clearExpireTimer();
    this.offer = {
      ...DEFAULT_OFFER_STATE,
      phase: "idle",
      updatedAt: now,
    };
    this.epaper = { type: "epaper", mode: "welcome", updatedAt: now };
    return this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private expireIfNeeded(now = Date.now()) {
    if (
      this.offer.phase === "active" &&
      this.offer.expiresAt !== null &&
      now >= this.offer.expiresAt
    ) {
      this.clearExpireTimer();
      this.offer = {
        ...DEFAULT_OFFER_STATE,
        phase: "idle",
        updatedAt: now,
      };
      this.epaper = { type: "epaper", mode: "welcome", updatedAt: now };
      this.emit();
    }
  }

  private clearExpireTimer() {
    if (this.expireTimer) {
      clearTimeout(this.expireTimer);
      this.expireTimer = null;
    }
  }

  private emit(): OfferSnapshot {
    const snapshot = { offer: this.offer, epaper: this.epaper };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }
}

export function getOfferStore(): OfferStore {
  if (
    !globalThis.__visionMenuOfferStore ||
    globalThis.__visionMenuOfferStoreVersion !== STORE_VERSION
  ) {
    globalThis.__visionMenuOfferStore = new OfferStore();
    globalThis.__visionMenuOfferStoreVersion = STORE_VERSION;
  }
  return globalThis.__visionMenuOfferStore;
}
