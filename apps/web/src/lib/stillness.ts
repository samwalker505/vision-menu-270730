import type { DetectionBox, IngestPayload, PanelState } from "@repo/shared";
import { DEFAULT_PANEL_STATE, normalizeBoxes } from "@repo/shared";

export type StillnessConfig = {
  /** If set, only this class id counts; null = any class above minScore. */
  personTarget: number | null;
  /** Minimum confidence (0–1) to count as a detection. */
  minScore: number;
  /** Sliding window length for motion samples. */
  windowMs: number;
  /**
   * Max center travel in the window, as a fraction of mean face diagonal.
   * Face-detector jitter is large vs frame size — face-relative is more stable.
   */
  maxCenterTravelFaceFrac: number;
  /** Max relative area change (peak-to-peak / mean) in the window. */
  maxAreaTravelFrac: number;
  /** Loosen motion limits while already still. */
  stayLooseFactor: number;
  /** EMA blend toward new boxes (0–1). Lower = smoother. */
  boxSmoothAlpha: number;
  /** Soft dead-zone as a fraction of face diagonal (per-frame). */
  faceShakeDeadzone: number;
  /** Motion must persist this long before leaving still. */
  leaveStillMs: number;
  /** How long isStill must hold before unlocking the menu. */
  unlockHoldMs: number;
  /** Clear presence if no ingest arrives within this time. */
  staleMs: number;
  /** Keep last face briefly if the detector flickers off. */
  missGraceMs: number;
};

export const DEFAULT_STILLNESS_CONFIG: StillnessConfig = {
  // Face models often use class ids other than 0 — accept any scored box.
  personTarget: null,
  minScore: 0.2,
  // Short window: face boxes jitter a lot; long peak-to-peak windows never settle.
  windowMs: 450,
  // Allow almost a full face-diagonal of center wander (detector noise, not head motion).
  maxCenterTravelFaceFrac: 1.25,
  // Face w/h flicker is huge even when still — do not gate on area.
  maxAreaTravelFrac: Number.POSITIVE_INFINITY,
  stayLooseFactor: 2,
  boxSmoothAlpha: 0.15,
  faceShakeDeadzone: 0.45,
  leaveStillMs: 800,
  unlockHoldMs: 350,
  staleMs: 4000,
  /** Keep last face briefly if the detector flickers off. */
  missGraceMs: 1500,
};

type Sample = {
  ts: number;
  cx: number;
  cy: number;
  area: number;
  faceDiag: number;
  score: number;
  box: DetectionBox;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function range(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

function smoothBox(prev: DetectionBox | null, next: DetectionBox, alpha: number): DetectionBox {
  if (!prev) return next;
  return {
    ...next,
    x: lerp(prev.x, next.x, alpha),
    y: lerp(prev.y, next.y, alpha),
    w: lerp(prev.w, next.w, alpha),
    h: lerp(prev.h, next.h, alpha),
    score: lerp(prev.score, next.score, alpha),
  };
}

/** Shrink per-frame center jumps inside the face shake dead-zone. */
function softDeadzone(
  prev: Sample | null,
  cx: number,
  cy: number,
  faceDiag: number,
  deadzoneFrac: number,
): { cx: number; cy: number } {
  if (!prev || deadzoneFrac <= 0) return { cx, cy };
  const maxDelta = faceDiag * deadzoneFrac;
  const dx = cx - prev.cx;
  const dy = cy - prev.cy;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxDelta || dist < 1e-6) {
    return { cx: prev.cx, cy: prev.cy };
  }
  // Only keep motion beyond the dead-zone (ignores the shake band).
  const keep = (dist - maxDelta) / dist;
  return { cx: prev.cx + dx * keep, cy: prev.cy + dy * keep };
}

export function pickPrimaryPerson(
  boxes: DetectionBox[],
  config: StillnessConfig = DEFAULT_STILLNESS_CONFIG,
): DetectionBox | null {
  const people = boxes.filter((b) => {
    if (b.score < config.minScore) return false;
    if (config.personTarget == null) return true;
    return b.target === config.personTarget;
  });
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
  private movingSince: number | null = null;
  private unlocked = false;
  private smoothedBox: DetectionBox | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastDeviceId: string | null = null;
  private lastIngestAt = 0;
  private lastConfidence = 0;
  private lastBox: DetectionBox | null = null;
  private missingSince: number | null = null;

  constructor(private readonly config: StillnessConfig = DEFAULT_STILLNESS_CONFIG) {}

  ingest(payload: IngestPayload, now = Date.now()): PanelState {
    const boxes = normalizeBoxes(payload.boxes);
    const primary = pickPrimaryPerson(boxes, this.config);

    this.lastDeviceId = payload.deviceId;
    this.lastIngestAt = now;
    this.lastWidth = payload.width;
    this.lastHeight = payload.height;

    if (!primary) {
      // Face detectors flicker — hold last box and keep sampling through brief misses.
      if (this.lastBox && this.config.missGraceMs > 0) {
        if (this.missingSince === null) this.missingSince = now;
        if (now - this.missingSince < this.config.missGraceMs) {
          this.pushSample(this.lastBox, now);
          return this.finishIngest(now);
        }
      }
      this.samples = [];
      this.smoothedBox = null;
      this.stillSince = null;
      this.movingSince = null;
      this.missingSince = null;
      this.unlocked = false;
      this.lastConfidence = 0;
      this.lastBox = null;
      return this.getState(now);
    }

    this.missingSince = null;
    this.smoothedBox = smoothBox(this.smoothedBox, primary, this.config.boxSmoothAlpha);
    this.lastConfidence = this.smoothedBox.score;
    this.lastBox = this.smoothedBox;
    this.pushSample(this.smoothedBox, now);
    return this.finishIngest(now);
  }

  private pushSample(box: DetectionBox, now: number): void {
    const faceDiag = Math.hypot(box.w, box.h) || 1;
    let cx = box.x + box.w / 2;
    let cy = box.y + box.h / 2;
    const prev = this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
    ({ cx, cy } = softDeadzone(prev, cx, cy, faceDiag, this.config.faceShakeDeadzone));

    this.samples.push({
      ts: now,
      cx,
      cy,
      area: Math.max(1, box.w * box.h),
      faceDiag,
      score: box.score,
      box,
    });
    const cutoff = now - this.config.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    this.samples = keepTrailingContiguous(this.samples, this.config.windowMs * 0.85);
  }

  private finishIngest(now: number): PanelState {
    const alreadyStill = this.stillSince !== null;
    const isStillNow = this.evaluateStill(alreadyStill);

    if (isStillNow) {
      this.movingSince = null;
      if (this.stillSince === null) this.stillSince = now;
      if (now - this.stillSince >= this.config.unlockHoldMs) {
        this.unlocked = true;
      }
    } else if (alreadyStill) {
      if (this.movingSince === null) this.movingSince = now;
      if (now - this.movingSince >= this.config.leaveStillMs) {
        this.stillSince = null;
        this.movingSince = null;
        this.unlocked = false;
      }
    } else {
      this.stillSince = null;
      this.movingSince = null;
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
        imageBase64: null,
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
      imageBase64: null,
      width: this.lastWidth,
      height: this.lastHeight,
      primaryBox: this.lastBox,
      updatedAt: now,
      lastIngestAt: this.lastIngestAt,
    };
  }

  private evaluateStill(alreadyStill: boolean): boolean {
    // Need a short stable stretch — not a long quiet history (face boxes never stay put).
    if (this.samples.length < 2) return false;
    const span = this.samples[this.samples.length - 1].ts - this.samples[0].ts;
    if (span < Math.min(250, this.config.windowMs * 0.4)) return false;

    const meanFaceDiag =
      this.samples.reduce((sum, s) => sum + s.faceDiag, 0) / this.samples.length || 1;

    // Center-only: face detector w/h flicker is not head motion.
    const centerTravel = Math.hypot(
      range(this.samples.map((s) => s.cx)),
      range(this.samples.map((s) => s.cy)),
    );

    const loose = alreadyStill ? this.config.stayLooseFactor : 1;
    const maxCenter = this.config.maxCenterTravelFaceFrac * meanFaceDiag * loose;
    return centerTravel <= maxCenter;
  }
}

/** Drop samples before a large timing gap so brief face loss doesn't poison the window. */
function keepTrailingContiguous(samples: Sample[], maxGapMs: number): Sample[] {
  if (samples.length <= 1) return samples;
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].ts - samples[i - 1].ts > maxGapMs) {
      start = i;
    }
  }
  return start === 0 ? samples : samples.slice(start);
}
