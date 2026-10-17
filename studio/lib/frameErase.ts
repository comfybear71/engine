/** "5-9, 12" -> [5,6,7,8,9,12], kept inside 1..frameCount, no repeats, in order. Returns null when the text is not a list of frames. */
export function parseFrameList(text: string, frameCount: number): number[] | null {
  const parts = text.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const found = new Set<number>();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] == null ? a : Number(m[2]);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    if (from < 1 || to > frameCount) return null;
    for (let n = from; n <= to; n += 1) found.add(n);
  }
  return [...found].sort((x, y) => x - y);
}

/** Frame numbers as short ranges for display: [1,2,3,7] -> "1-3, 7". */
export function formatFrameList(frames: number[]): string {
  const sorted = [...frames].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return out.join(", ");
}

/** Which file shows a frame's picture before any erase: the untouched copy once the frame has been erased. */
export function frameBaseRel(frame: number, erased: ReadonlySet<number>): string {
  const name = `f_${String(Math.max(1, frame)).padStart(4, "0")}.png`;
  return erased.has(frame) ? `cut_orig/${name}` : `cut/${name}`;
}

export function frameMaskRel(frame: number): string {
  return `erase/f_${String(Math.max(1, frame)).padStart(4, "0")}.png`;
}
