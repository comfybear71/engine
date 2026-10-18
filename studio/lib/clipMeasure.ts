import { opaqueHeight } from "./clipFit";
import { assetUrl, loadClipFrames } from "./worker";

const cache = new Map<string, Promise<number | null>>();
const SAMPLE_MAX_PX = 720;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the Action Shot frame"));
    img.src = src;
  });
}

async function contentHeightOf(src: string): Promise<number> {
  const img = await loadImage(src);
  const nativeW = img.naturalWidth;
  const nativeH = img.naturalHeight;
  if (!nativeW || !nativeH) return 0;
  const k = Math.min(1, SAMPLE_MAX_PX / nativeH);
  const w = Math.max(1, Math.round(nativeW * k));
  const h = Math.max(1, Math.round(nativeH * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return nativeH;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const seen = opaqueHeight(ctx.getImageData(0, 0, w, h).data, w, h);
    return seen > 0 ? seen / k : nativeH;
  } catch {
    return nativeH;
  }
}

/** How tall the character is in an Action Shot's baked frames (native pixels): the tallest of the first, middle and last frame. Null if it cannot be measured. */
export function measureActionContentHeight(project: string, characterId: string, actionId: string): Promise<number | null> {
  const key = `${project}/${characterId}/${actionId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    try {
      const { frames: rels } = await loadClipFrames(project, characterId, actionId);
      if (!rels.length) return null;
      const picks = [...new Set([0, Math.floor((rels.length - 1) / 2), rels.length - 1])].map((i) => rels[i]);
      const heights = await Promise.all(
        picks.map((rel) => {
          const url = assetUrl(project, rel, { library: true });
          return url ? contentHeightOf(url) : Promise.resolve(0);
        })
      );
      const tallest = Math.max(...heights);
      return tallest > 0 ? tallest : null;
    } catch {
      cache.delete(key);
      return null;
    }
  })();
  cache.set(key, job);
  return job;
}
