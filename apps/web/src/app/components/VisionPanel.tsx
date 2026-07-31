"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  DEFAULT_PANEL_STATE,
  PLACEHOLDER_MENU,
  type DetectionBox,
  type PanelState,
} from "@repo/shared";

const OFFER_PRESENT_MS = 5000;

type OfferPhase = "idle" | "prompt" | "qr" | "dismissed";

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatAge(updatedAt: number, now: number): string {
  if (!updatedAt) return "waiting";
  const sec = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (sec < 1) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

type BoxRect = { x: number; y: number; w: number; h: number };

function toRect(box: DetectionBox): BoxRect {
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(from: BoxRect, to: BoxRect, t: number): BoxRect {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    w: lerp(from.w, to.w, t),
    h: lerp(from.h, to.h, t),
  };
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  const port = process.env.NEXT_PUBLIC_VISION_WS_PORT || "3001";
  return `${proto}//${host}:${port}/`;
}

function pickDiscountPct(): number {
  return 10 + Math.floor(Math.random() * 11);
}

export function VisionPanel() {
  const [state, setState] = useState<PanelState>(DEFAULT_PANEL_STATE);
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [displayBox, setDisplayBox] = useState<BoxRect | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  const [offerPhase, setOfferPhase] = useState<OfferPhase>("idle");
  const [presentSince, setPresentSince] = useState<number | null>(null);
  const [discountPct, setDiscountPct] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const targetBoxRef = useRef<BoxRect | null>(null);
  const displayBoxRef = useRef<BoxRect | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const offerPhaseRef = useRef<OfferPhase>("idle");

  useEffect(() => {
    offerPhaseRef.current = offerPhase;
  }, [offerPhase]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const applyState = (data: PanelState) => {
      setState(data);
      if (data.primaryBox) {
        targetBoxRef.current = toRect(data.primaryBox);
        if (!displayBoxRef.current) {
          displayBoxRef.current = toRect(data.primaryBox);
          setDisplayBox(displayBoxRef.current);
        }
      } else {
        targetBoxRef.current = null;
        displayBoxRef.current = null;
        setDisplayBox(null);
      }
    };

    const setFrame = (buffer: ArrayBuffer) => {
      const blob = new Blob([buffer], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = url;
      setImageSrc(url);
    };

    const connect = () => {
      if (cancelled) return;
      const url = wsUrl();
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setConnected(true);
        socket?.send(JSON.stringify({ type: "hello", role: "browser" }));
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              state?: PanelState;
            };
            if (msg.type === "state" && msg.state) {
              applyState(msg.state);
            }
          } catch {
            // ignore
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          setFrame(event.data);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        const delay = Math.min(4000, 500 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(clock);
      socket?.close();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const target = targetBoxRef.current;
      const current = displayBoxRef.current;
      if (target && current) {
        const next = lerpRect(current, target, 0.35);
        displayBoxRef.current = next;
        setDisplayBox(next);
      } else if (target && !current) {
        displayBoxRef.current = target;
        setDisplayBox(target);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Track continuous face presence for the guest offer.
  useEffect(() => {
    if (state.humanPresent) {
      setPresentSince((prev) => prev ?? Date.now());
      return;
    }
    setPresentSince(null);
    setOfferPhase("idle");
    setDiscountPct(null);
    setQrDataUrl(null);
  }, [state.humanPresent]);

  useEffect(() => {
    if (!state.humanPresent || presentSince === null) return;
    if (offerPhaseRef.current !== "idle") return;
    if (now - presentSince < OFFER_PRESENT_MS) return;
    setOfferPhase("prompt");
  }, [state.humanPresent, presentSince, now]);

  const acceptOffer = async () => {
    const pct = pickDiscountPct();
    const code = `VISION-${pct}OFF`;
    try {
      const url = await QRCode.toDataURL(code, {
        width: 220,
        margin: 2,
        color: { dark: "#10241e", light: "#ffffff" },
      });
      setDiscountPct(pct);
      setQrDataUrl(url);
      setOfferPhase("qr");
    } catch {
      setDiscountPct(pct);
      setQrDataUrl(null);
      setOfferPhase("qr");
    }
  };

  const dismissOffer = () => {
    setOfferPhase("dismissed");
    setDiscountPct(null);
    setQrDataUrl(null);
  };

  return (
    <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-10 px-5 py-10 sm:px-8 lg:px-10">
      <header className="animate-fade-up flex flex-col gap-3">
        <p
          className="text-sm font-medium tracking-[0.22em] uppercase"
          style={{ color: "var(--accent)" }}
        >
          XIAO Vision AI
        </p>
        <h1
          className="text-5xl leading-none tracking-tight sm:text-6xl"
          style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}
        >
          Vision Menu
        </h1>
        <p className="max-w-xl text-base sm:text-lg" style={{ color: "var(--ink-soft)" }}>
          Today&apos;s menu is always on. Linger in frame for a few seconds and we may
          offer a guest discount.
        </p>
        <div className="flex items-center gap-3 text-sm" style={{ color: "var(--ink-soft)" }}>
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "animate-pulse-glow" : ""}`}
            style={{ background: connected ? "var(--accent-bright)" : "var(--locked)" }}
            aria-hidden
          />
          {connected ? "Live WS" : "Reconnecting"}
          <span aria-hidden>·</span>
          <span>Updated {formatAge(state.updatedAt, now)}</span>
          {state.deviceId ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-xs">{state.deviceId}</span>
            </>
          ) : null}
        </div>
      </header>

      <div
        className="animate-fade-up grid gap-10 lg:grid-cols-2 lg:items-start"
        style={{ animationDelay: "80ms" }}
      >
        <section aria-label="Digital menu">
          <div className="mb-5">
            <h2
              className="text-3xl tracking-tight sm:text-4xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Today&apos;s Menu
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>
              Browse and order at the counter.
            </p>
          </div>

          <ul className="grid gap-6">
            {PLACEHOLDER_MENU.map((item, index) => (
              <li
                key={item.id}
                className="animate-fade-up border-t pt-4"
                style={{
                  borderColor: "var(--line)",
                  animationDelay: `${index * 70}ms`,
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xl" style={{ fontFamily: "var(--font-display)" }}>
                    {item.name}
                  </h3>
                  <span className="font-medium" style={{ color: "var(--accent)" }}>
                    {item.price}
                  </span>
                </div>
                <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>
                  {item.description}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-8" aria-label="Camera status">
          <div className="overflow-hidden rounded-sm" style={{ background: "var(--bg-deep)" }}>
            <div className="relative aspect-square w-full">
              {imageSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageSrc}
                  alt="Live WebSocket JPEG stream"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center px-8 text-center text-sm"
                  style={{ color: "rgba(231, 243, 238, 0.7)" }}
                >
                  Waiting for WebSocket frames from the camera…
                </div>
              )}
              {displayBox && state.width > 0 && state.height > 0 ? (
                <div
                  className="pointer-events-none absolute border-2 will-change-[left,top,width,height]"
                  style={{
                    borderColor: state.isStill ? "var(--accent-bright)" : "rgba(255,255,255,0.85)",
                    left: `${(displayBox.x / state.width) * 100}%`,
                    top: `${(displayBox.y / state.height) * 100}%`,
                    width: `${(displayBox.w / state.width) * 100}%`,
                    height: `${(displayBox.h / state.height) * 100}%`,
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <StatusRow
              label="Human in frame"
              value={state.humanPresent ? "Detected" : "None"}
              active={state.humanPresent}
            />
            <StatusRow
              label="Standing still"
              value={
                !state.humanPresent
                  ? "No"
                  : state.isStill
                    ? `Yes · ${(state.stillMs / 1000).toFixed(1)}s`
                    : "Settling…"
              }
              active={state.isStill}
            />
            <StatusRow
              label="Confidence"
              value={state.humanPresent ? formatConfidence(state.confidence) : "—"}
              active={state.confidence >= 0.5}
            />
          </div>
        </section>
      </div>

      {offerPhase === "prompt" ? (
        <div
          className="animate-fade-up fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6"
          role="status"
          aria-live="polite"
        >
          <div
            className="mx-auto flex max-w-3xl flex-col gap-4 border px-5 py-4 shadow-lg sm:flex-row sm:items-center sm:justify-between"
            style={{
              background: "var(--surface)",
              borderColor: "var(--line)",
              backdropFilter: "blur(10px)",
            }}
          >
            <div>
              <p
                className="text-lg tracking-tight"
                style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}
              >
                Guest offer ready
              </p>
              <p className="mt-0.5 text-sm" style={{ color: "var(--ink-soft)" }}>
                You&apos;ve been here a moment — claim a 10–20% off code?
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void acceptOffer()}
                className="px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ background: "var(--accent)" }}
              >
                Show my offer
              </button>
              <button
                type="button"
                onClick={dismissOffer}
                className="px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-80"
                style={{ color: "var(--ink-soft)", border: "1px solid var(--line)" }}
              >
                No thanks
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {offerPhase === "qr" && discountPct !== null ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="offer-qr-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default border-0"
            style={{ background: "rgba(12, 31, 26, 0.55)" }}
            aria-label="Close offer"
            onClick={dismissOffer}
          />
          <div
            className="animate-unlock relative z-10 w-full max-w-sm border px-6 py-8 text-center shadow-xl"
            style={{
              background: "#f7fcf9",
              borderColor: "var(--line)",
            }}
          >
            <p
              id="offer-qr-title"
              className="text-3xl tracking-tight"
              style={{ fontFamily: "var(--font-display)", color: "var(--accent)" }}
            >
              {discountPct}% off
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--ink-soft)" }}>
              Scan at the counter — code{" "}
              <span className="font-mono font-medium" style={{ color: "var(--ink)" }}>
                VISION-{discountPct}OFF
              </span>
            </p>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={`QR code for VISION-${discountPct}OFF`}
                className="mx-auto mt-6 h-52 w-52 bg-white p-2"
              />
            ) : (
              <p className="mt-6 text-sm" style={{ color: "var(--locked)" }}>
                QR unavailable — use the code above.
              </p>
            )}
            <button
              type="button"
              onClick={dismissOffer}
              className="mt-6 px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-80"
              style={{ color: "var(--ink-soft)", border: "1px solid var(--line)" }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusRow({
  label,
  value,
  active,
}: {
  label: string;
  value: string;
  active: boolean;
}) {
  return (
    <div className="border-b pb-4" style={{ borderColor: "var(--line)" }}>
      <div className="text-xs tracking-[0.18em] uppercase" style={{ color: "var(--ink-soft)" }}>
        {label}
      </div>
      <div
        className="mt-1 text-2xl"
        style={{
          fontFamily: "var(--font-display)",
          color: active ? "var(--accent)" : "var(--ink)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
