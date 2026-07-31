import { z } from "zod";

export const DetectionBoxSchema = z.object({
  target: z.number().int().nonnegative(),
  /** Confidence in 0–1 (or 0–100 from SenseCraft; normalized on ingest). */
  score: z.number().min(0).max(100),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export type DetectionBox = z.infer<typeof DetectionBoxSchema>;

export function normalizeScore(score: number): number {
  return score > 1 ? score / 100 : score;
}

export function normalizeBoxes(boxes: DetectionBox[]): DetectionBox[] {
  return boxes.map((box) => ({
    ...box,
    score: normalizeScore(box.score),
  }));
}

export const IngestPayloadSchema = z.object({
  deviceId: z.string().min(1).max(128),
  ts: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  imageBase64: z.string().min(1).optional(),
  boxes: z.array(DetectionBoxSchema).default([]),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

export const PanelStateSchema = z.object({
  deviceId: z.string().nullable(),
  humanPresent: z.boolean(),
  isStill: z.boolean(),
  stillMs: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  menuUnlocked: z.boolean(),
  imageBase64: z.string().nullable(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  primaryBox: DetectionBoxSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
  lastIngestAt: z.number().int().nonnegative(),
});

export type PanelState = z.infer<typeof PanelStateSchema>;

export const DEFAULT_PANEL_STATE: PanelState = {
  deviceId: null,
  humanPresent: false,
  isStill: false,
  stillMs: 0,
  confidence: 0,
  menuUnlocked: false,
  imageBase64: null,
  width: 0,
  height: 0,
  primaryBox: null,
  updatedAt: 0,
  lastIngestAt: 0,
};

/** Placeholder menu always shown on the vision panel. */
export const PLACEHOLDER_MENU = [
  {
    id: "espresso",
    name: "Espresso",
    description: "Single origin, short and bright.",
    price: "$3.50",
  },
  {
    id: "latte",
    name: "Latte",
    description: "Silky steamed milk, double shot.",
    price: "$4.75",
  },
  {
    id: "matcha",
    name: "Matcha Latte",
    description: "Ceremonial grade, lightly sweetened.",
    price: "$5.25",
  },
  {
    id: "croissant",
    name: "Butter Croissant",
    description: "Baked this morning.",
    price: "$3.25",
  },
] as const;

export type MenuItem = (typeof PLACEHOLDER_MENU)[number];
