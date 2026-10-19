import { opaqueReach, sampleFrameIndexes } from "./clipFit";
import { assetUrl, loadClipFrames } from "./worker";

const cache = new Map<string, Promise<number | null>>();
const SAMPLE_MAX_PX = 540;
const PARALLEL_LOADS = 6;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the Action Shot frame"));
    img.src = src;
  });
}

async function reachOf(src: string): Promise<number> {
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
    const seen = opaqueReach(ctx.getImageData(0, 0, w, h).data, w, h);
    return seen > 0 ? seen / k : nativeH;
  } catch {
    return nativeH;
  }
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

/**
 * How far the character reaches up from the bottom of an Action Shot's baked
 * frames (native pixels): the highest point over frames spread across the whole
 * clip, so a hat that rises on some frames counts. It is a sample, not every
 * frame. Null if it cannot be measured.
 */
export function measureActionReach(project: string, characterId: string, actionId: string): Promise<number | null> {
  const key = `${project}/${characterId}/${actionId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    try {
      const { frames: rels } = await loadClipFrames(project, characterId, actionId);
      if (!rels.length) return null;
      const picks = sampleFrameIndexes(rels.length).map((i) => rels[i]);
      const reaches = await inBatches(picks, PARALLEL_LOADS, (rel) => {
        const url = assetUrl(project, rel, { library: true });
        return url ? reachOf(url) : Promise.resolve(0);
      });
      const highest = Math.max(...reaches);
      return highest > 0 ? highest : null;
    } catch {
      cache.delete(key);
      return null;
    }
  })();
  cache.set(key, job);
  return job;
}
