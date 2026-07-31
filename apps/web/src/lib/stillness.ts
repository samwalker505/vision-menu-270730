import type { DetectionBox, IngestPayload, PanelState } from "@repo/shared";
import { DEFAULT_PANEL_STATE, normalizeBoxes } from "@repo/shared";

export type StillnessConfig = {
  /** Person class id from SenseCraft person detection model. */
  personTarget: number;
  /** Minimum confidence (0–1) to count as a person. */
  minScore: number;
  /** Sliding window length for motion samples. */
  windowMs: number;
  /** Max centroid movement (normalized by frame diagonal) to count as still. */
  maxCentroidNormStd: number;
  /** Max relative area stddev to count as still. */
  maxAreaRelStd: number;
  /** How long isStill must hold before unlocking the menu. */
  unlockHoldMs: number;
  /** Clear humanPresent / still if no ingest arrives within this time. */
  staleMs: number;
};

export const DEFAULT_STILLNESS_CONFIG: StillnessConfig = {
  personTarget: 0,
  minScore: 0.5,
  windowMs: 2000,
  maxCentroidNormStd: 0.02,
  maxAreaRelStd: 0.08,
  unlockHoldMs: 1000,
  staleMs: 4000,
};

type Sample = {
  ts: number;
  cx: number;
  cy: number;
  area: number;
  score: number;
  box: DetectionBox;
};

function stddev(values: number[]): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function pickPrimaryPerson(
  boxes: DetectionBox[],
  config: StillnessConfig = DEFAULT_STILLNESS_CONFIG,
): DetectionBox | null {
  const people = boxes.filter(
    (b) => b.target === config.personTarget && b.score >= config.minScore,
  );
  if (people.length === 0) return null;
  return people.reduce((best, box) => {
    const bestArea = best.w * best.h;
    const area = box.w * box.h;
    if (box.score > best.score) return box;
    if (box.score === best.score && area > bestArea) return box;
    return best;
  });
}

export class StillnessEngine {
  private samples: Sample[] = [];
  private stillSince: number | null = null;
  private unlocked = false;
  private lastImage: string | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastDeviceId: string | null = null;
  private lastIngestAt = 0;
  private lastConfidence = 0;
  private lastBox: DetectionBox | null = null;

  constructor(private readonly config: StillnessConfig = DEFAULT_STILLNESS_CONFIG) {}

  ingest(payload: IngestPayload, now = Date.now()): PanelState {
    const boxes = normalizeBoxes(payload.boxes);
    const primary = pickPrimaryPerson(boxes, this.config);

    this.lastDeviceId = payload.deviceId;
    this.lastIngestAt = now;
    this.lastWidth = payload.width;
    this.lastHeight = payload.height;
    if (payload.imageBase64) {
      this.lastImage = payload.imageBase64;
    }

    if (!primary) {
      this.samples = [];
      this.stillSince = null;
      this.unlocked = false;
      this.lastConfidence = 0;
      this.lastBox = null;
      return this.getState(now);
    }

    this.lastConfidence = primary.score;
    this.lastBox = primary;

    // Always use server time for the sliding window. Device `ts` may be millis() uptime.
    const sample: Sample = {
      ts: now,
      cx: primary.x + primary.w / 2,
      cy: primary.y + primary.h / 2,
      area: primary.w * primary.h,
      score: primary.score,
      box: primary,
    };

    this.samples.push(sample);
    const cutoff = now - this.config.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);

    const isStill = this.evaluateStill(payload.width, payload.height);
    if (isStill) {
      if (this.stillSince === null) this.stillSince = now;
      const held = now - this.stillSince;
      if (held >= this.config.unlockHoldMs) {
        this.unlocked = true;
      }
    } else {
      this.stillSince = null;
      this.unlocked = false;
    }

    return this.getState(now);
  }

  getState(now = Date.now()): PanelState {
    const stale = this.lastIngestAt > 0 && now - this.lastIngestAt > this.config.staleMs;
    if (stale) {
      return {
        ...DEFAULT_PANEL_STATE,
        deviceId: this.lastDeviceId,
        imageBase64: this.lastImage,
        width: this.lastWidth,
        height: this.lastHeight,
        updatedAt: now,
        lastIngestAt: this.lastIngestAt,
      };
    }

    const humanPresent = this.lastBox !== null;
    const isStill = this.stillSince !== null;
    const stillMs = isStill && this.stillSince !== null ? Math.max(0, now - this.stillSince) : 0;

    return {
      deviceId: this.lastDeviceId,
      humanPresent,
      isStill,
      stillMs,
      confidence: this.lastConfidence,
      menuUnlocked: this.unlocked,
      imageBase64: this.lastImage,
      width: this.lastWidth,
      height: this.lastHeight,
      primaryBox: this.lastBox,
      updatedAt: now,
      lastIngestAt: this.lastIngestAt,
    };
  }

  private evaluateStill(width: number, height: number): boolean {
    if (this.samples.length < 3) return false;
    const span = this.samples[this.samples.length - 1].ts - this.samples[0].ts;
    if (span < this.config.windowMs * 0.75) return false;

    const diagonal = Math.hypot(width, height) || 1;
    const meanArea =
      this.samples.reduce((sum, s) => sum + s.area, 0) / this.samples.length || 1;

    const cxStd = stddev(this.samples.map((s) => s.cx)) / diagonal;
    const cyStd = stddev(this.samples.map((s) => s.cy)) / diagonal;
    const areaRelStd = stddev(this.samples.map((s) => s.area)) / meanArea;

    const centroidOk =
      cxStd <= this.config.maxCentroidNormStd &&
      cyStd <= this.config.maxCentroidNormStd;
    const areaOk = areaRelStd <= this.config.maxAreaRelStd;

    // Ensure continuous presence across the window (no large gaps).
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].ts - this.samples[i - 1].ts > this.config.windowMs * 0.5) {
        return false;
      }
    }

    return centroidOk && areaOk;
  }
}
