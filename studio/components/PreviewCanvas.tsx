"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  backgroundDestRect,
  collectRels,
  evaluateFrame,
  type PreviewCommand,
} from "@/lib/previewCompose";
import { assetUrl } from "@/lib/worker";

const DISPLAY_WIDTH = 854;
const DISPLAY_HEIGHT = 480;

type TextureMap = Map<string, HTMLImageElement>;

function loadTexture(project: string, rel: string): Promise<HTMLImageElement | null> {
  const src = assetUrl(project, rel, { preview: true });
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  cmd: PreviewCommand,
  canvasW: number,
  canvasH: number
) {
  if (!img) {
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvasW, canvasH);
    return;
  }
  // Dest size comes from the graph (CLI source pixels + cover/contain), never
  // from the loaded texture. `?preview=1` assets are ~512px; drawing them at
  // natural size left a small strip on a 1920×1080 stage.
  const rect = backgroundDestRect(cmd, canvasW, canvasH);
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
}

function drawSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, cmd: PreviewCommand) {
  const width = Number(cmd.width) || img.naturalWidth || 1;
  const height = Number(cmd.height) || img.naturalHeight || 1;
  const scale = Number(cmd.scale) || 1;
  const rotation = ((Number(cmd.rotation) || 0) * Math.PI) / 180;
  const srcW = width * scale;
  const srcH = height * scale;
  let ax: number;
  let ay: number;
  if (cmd.pivot && cmd.pivot.length >= 2) {
    ax = Number(cmd.pivot[0]) * scale;
    ay = Number(cmd.pivot[1]) * scale;
    if (cmd.flipX) ax = srcW - ax;
  } else {
    const name = cmd.anchor || "center";
    const [vertical, horizontal = "center"] = name.split("-");
    ax = { left: 0, center: srcW / 2, right: srcW }[horizontal] ?? srcW / 2;
    ay = { top: 0, center: srcH / 2, bottom: srcH }[vertical] ?? srcH / 2;
  }
  const cx = srcW / 2;
  const cy = srcH / 2;
  const dx = ax - cx;
  const dy = ay - cy;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rdx = dx * cos - dy * sin;
  const rdy = dx * sin + dy * cos;
  ctx.save();
  ctx.globalAlpha = cmd.opacity == null ? 1 : Number(cmd.opacity);
  ctx.translate(Number(cmd.x) - rdx, Number(cmd.y) - rdy);
  ctx.rotate(rotation);
  if (cmd.flipX) ctx.scale(-1, 1);
  ctx.drawImage(img, cmd.flipX ? -cx : -cx, -cy, srcW, srcH);
  ctx.restore();
}

export default function PreviewCanvas({
  project,
  graph,
  frame,
}: {
  project: string;
  graph: unknown;
  frame: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const texturesRef = useRef<TextureMap>(new Map());
  const [readyTick, setReadyTick] = useState(0);
  const rels = useMemo(() => collectRels(graph), [graph]);

  useEffect(() => {
    let cancelled = false;
    const next = new Map<string, HTMLImageElement>();
    Promise.all(
      rels.map(async (rel) => {
        const img = await loadTexture(project, rel);
        if (img) next.set(rel, img);
      })
    ).then(() => {
      if (cancelled) return;
      texturesRef.current = next;
      setReadyTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [project, rels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const evaluated = evaluateFrame(graph, frame);
    const worldW = evaluated.canvas.width || 1920;
    const worldH = evaluated.canvas.height || 1080;
    const displayW = DISPLAY_WIDTH;
    const displayH = DISPLAY_HEIGHT;
    if (canvas.width !== displayW) canvas.width = displayW;
    if (canvas.height !== displayH) canvas.height = displayH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(displayW / worldW, 0, 0, displayH / worldH, 0, 0);
    ctx.clearRect(0, 0, worldW, worldH);
    const textures = texturesRef.current;
    for (const cmd of evaluated.commands) {
      const img = cmd.rel ? textures.get(cmd.rel) || null : null;
      if (cmd.kind === "bg") {
        drawBackground(ctx, img, cmd, worldW, worldH);
        continue;
      }
      if (!img) continue;
      drawSprite(ctx, img, cmd);
    }
  }, [graph, frame, readyTick]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="stage-preview-canvas"
      className="max-h-full max-w-full rounded-sm object-contain shadow-2xl"
      style={{ width: "100%", height: "auto", aspectRatio: "16 / 9" }}
      width={DISPLAY_WIDTH}
      height={DISPLAY_HEIGHT}
    />
  );
}
