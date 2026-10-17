"use strict";

/**
 * Talking head from dialogue audio.
 *
 * An audio segment (a trimmed range of audio/<label>/001_<character>.wav) is
 * split into windows of <= 10 s on pauses (Grok clips are 4/6/8/10 s). One
 * head shot is generated per window. Window 1 starts from the character's
 * reference head; every later window starts from the frame of the previous
 * clip where its window ends ("last frame -> first frame"). Grok never hears
 * the audio, so each window's words go into the prompt and the clip is later
 * trimmed to the window's audio length.
 */

const fs = require("fs");
const path = require("path");
const {
  characterIdFromWavRel,
  wordsPathForWav,
  readWords,
  sliceWords,
  extractWavSlice,
} = require("./splitLongAudio");
const shotsModule = require("./shots");
const comfyCloud = require("./comfyCloud");
const { resolvePythonBin, PYTHON_DIR } = require("./pythonRuntime");
const { internals } = shotsModule;

const {
  runGrokShot,
  shotsDir,
  shotDir,
  readShotJson,
  writeShotJson,
  slugName,
  shotError,
  spawnCmd,
  BG_PROMPT_SUFFIX,
} = internals;

const CLIP_LENGTHS = [4, 6, 8, 10];
const MAX_WINDOW_SEC = 10;
const MIN_CUT_SEC = 3;
const MIN_GAP_SEC = 0.12;
const DEFAULT_TALK_PROMPT = "natural conversational delivery, subtle head movement, natural blinks";
const HEAD_ONLY_SUFFIX =
  "exactly the same character, art style, framing and crop as the starting image, head only from the jawline up, no neck, no collar, no clothing, no shoulders, no body, cut off cleanly at the jaw, static locked-off camera with no zoom, no push-in and no camera movement";

const running = new Set();
const chains = new Map();
const cancelled = new Set();
const START_DIR = "_starts";
const START_EXT = /\.(png|jpe?g|webp)$/i;

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function wordText(word) {
  return String((word && (word.word ?? word.text)) ?? "").trim();
}

function cleanWords(words) {
  return (Array.isArray(words) ? words : [])
    .filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
    .map((w) => ({ ...w, start: Number(w.start), end: Number(w.end) }))
    .sort((a, b) => a.start - b.start);
}

function pauseGaps(words, durationSec) {
  const gaps = [];
  let cursor = 0;
  for (const word of words) {
    if (word.start - cursor >= MIN_GAP_SEC) {
      gaps.push({ start: cursor, end: word.start, mid: (cursor + word.start) / 2, len: word.start - cursor });
    }
    cursor = Math.max(cursor, word.end);
  }
  if (durationSec - cursor >= MIN_GAP_SEC) {
    gaps.push({ start: cursor, end: durationSec, mid: (cursor + durationSec) / 2, len: durationSec - cursor });
  }
  return gaps;
}

function clipLengthFor(durationSec) {
  return CLIP_LENGTHS.find((len) => len >= durationSec - 0.01) || MAX_WINDOW_SEC;
}

/**
 * Split [0, durationSec) into windows of <= 10 s, cutting between words and
 * preferring pauses, with as few generated seconds as possible.
 */
function planWindows(words, durationSec) {
  const duration = Math.max(0, Number(durationSec) || 0);
  if (duration <= 0) return [];
  const list = cleanWords(words);
  if (duration <= MAX_WINDOW_SEC + 0.01) return describeRanges(list, [{ start: 0, end: duration }]);

  // Cut candidates: the middle of each pause (cheap to cut) and the end of
  // each word (fallback when speech runs on without pauses). A dynamic
  // program picks the cuts that generate the fewest Grok seconds, since
  // clips are billed as 4/6/8/10 s and chained one after another.
  const points = [{ t: 0, penalty: 0 }];
  for (const gap of pauseGaps(list, duration)) {
    if (gap.mid > 0.5 && gap.mid < duration - 0.5) points.push({ t: gap.mid, penalty: -Math.min(gap.len, 0.8) * 0.5 });
  }
  for (const word of list) {
    if (word.end > 0.5 && word.end < duration - 0.5) points.push({ t: word.end, penalty: 1.2 });
  }
  points.sort((x, y) => x.t - y.t);
  points.push({ t: duration, penalty: 0 });

  const best = new Array(points.length).fill(Infinity);
  const from = new Array(points.length).fill(-1);
  best[0] = 0;
  for (let j = 1; j < points.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const length = points[j].t - points[i].t;
      if (length > MAX_WINDOW_SEC + 0.01) break;
      if (length < 0.05 || best[i] === Infinity) continue;
      const cost = best[i] + clipLengthFor(length) + 0.5 + (length < MIN_CUT_SEC ? 2 : 0) + (j < points.length - 1 ? points[j].penalty : 0);
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
    }
  }

  const ranges = [];
  if (best[points.length - 1] === Infinity) {
    for (let t = 0; t < duration - 0.01; t += MAX_WINDOW_SEC) ranges.push({ start: t, end: Math.min(duration, t + MAX_WINDOW_SEC) });
  } else {
    let j = points.length - 1;
    while (j > 0) {
      ranges.unshift({ start: points[from[j]].t, end: points[j].t });
      j = from[j];
    }
  }
  return describeRanges(list, ranges);
}

function describeRanges(list, ranges) {
  return ranges.map((range, index) => {
    const text = list
      .filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= range.start && (mid < range.end || (index === ranges.length - 1 && mid <= range.end + 1e-6));
      })
      .map(wordText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1");
    const length = range.end - range.start;
    return {
      index,
      start: round3(range.start),
      end: round3(range.end),
      duration: round3(length),
      clipSec: clipLengthFor(length),
      text,
    };
  });
}

function validateAudioRel(rel) {
  const posix = String(rel || "").replace(/\\/g, "/");
  if (!posix.startsWith("audio/") || !/\.wav$/i.test(posix) || posix.includes("..")) {
    throw shotError("audioRel must be a project audio/<label>/<file>.wav path");
  }
  return posix;
}

/** Read the transcript for an audio range and plan its windows. */
function planTalkingHead(projectDir, body = {}) {
  const audioRel = validateAudioRel(body.audioRel);
  const wavAbs = path.join(projectDir, audioRel);
  if (!fs.existsSync(wavAbs)) throw shotError(`Audio file not found: ${audioRel}`, "ENOENT");
  const inSec = Math.max(0, Number(body.inSec) || 0);
  const durationSec = Math.max(0.2, Number(body.durationSec) || 0);
  const characterId = String(body.characterId || characterIdFromWavRel(audioRel) || "").trim();
  const words = sliceWords(readWords(path.join(projectDir, wordsPathForWav(audioRel))), inSec, inSec + durationSec);
  const windows = planWindows(words, durationSec);
  const transcript = windows.map((w) => w.text).filter(Boolean).join(" ");
  return {
    audioRel,
    inSec,
    durationSec,
    characterId,
    hasWords: words.length > 0,
    transcript,
    windows,
  };
}

const HEAD_BLACK_KEY = "head-black";

function normalizeEngine(value) {
  return String(value || "").toLowerCase() === "ltx" ? "ltx" : "grok";
}

function capitalizeName(id) {
  const word = String(id || "").trim().replace(/[_-]+/g, " ");
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "The character";
}

/**
 * The LTX prompt wording that produced real lip-sync and a locked camera in
 * hand-run Comfy Cloud tests (job e37d91b2). Other wordings (e.g. "lips synced
 * to the audio, saying ...") gave a closed mouth and a drifting camera, so keep
 * this structure and only swap the subject and the words.
 */
function buildLtxPrompt(talk) {
  const subject = String(talk.subject || "").trim() || capitalizeName(talk.characterId);
  const name = subject.split(",")[0].trim() || "The character";
  const words = String(talk.text || "").trim();
  const says = words ? `${name} says: "${words}".` : `${name} listens quietly, mouth closed.`;
  return (
    "Use the provided start image as the first frame. " +
    `${subject} is prominent, mouth and head move naturally while speaking, subtle gesture. ` +
    "Props and background stay exactly as the start image, nothing new enters frame. " +
    `${says} Only one person in the frame, plain black background. Static medium close-up shot. Fixed camera frame, zero camera movement. Same person and objects as the start image.`
  );
}

/**
 * Scale a start frame so the head matches the chain's head size, so a head that
 * shrank at the end of one clip does not start the next clip smaller. Best
 * effort: on any failure the frame is used unchanged.
 */
async function normalizeHeadFrame(png, target, options = {}) {
  try {
    const pythonBin = options.pythonBin || resolvePythonBin();
    const { code } = await spawnCmd(
      pythonBin,
      ["-m", "compositor.head_size", "normalize", "--in", png, "--out", png, "--target", String(target)],
      { cwd: PYTHON_DIR }
    );
    return code === 0;
  } catch {
    return false;
  }
}

/** Head size (px) of a frame, or 0 when it cannot be measured. */
async function measureHeadSize(png, options = {}) {
  try {
    if (!fs.existsSync(png)) return 0;
    const pythonBin = options.pythonBin || resolvePythonBin();
    const { code, stdout } = await spawnCmd(pythonBin, ["-m", "compositor.head_size", "measure", "--in", png], { cwd: PYTHON_DIR });
    if (code !== 0) return 0;
    const parsed = JSON.parse(String(stdout).trim().split("\n").pop());
    return Number(parsed.size) > 0 ? Number(parsed.size) : 0;
  } catch {
    return 0;
  }
}

/**
 * Chains made before the size lock have no saved head size. Take it from the
 * first clip's opening frame so a redone or resumed later clip is held to the
 * chain's size instead of to whatever (possibly shrunk) frame it starts from.
 */
async function ensureChainHeadSize(shots, options = {}) {
  const first = shots[0];
  if (!first || Number(first.info.headSizeTarget) > 0 || first.info.status !== "ready") return;
  const size = await (options.measureHead || measureHeadSize)(path.join(first.dir, "raw", "f_0001.png"), options);
  if (size > 0) {
    first.info.headSizeTarget = Math.round(size * 100) / 100;
    writeShotJson(first.dir, first.info);
  }
}

const STASH_DIR = "_previous";
const STASH_ITEMS = ["source.mp4", "raw", "cut", "thumb", "poster.jpg", "preview.mp4"];

/** Move a finished clip's media aside so a redo can be undone. One level only. */
function stashClip(dir, info) {
  const stash = path.join(dir, STASH_DIR);
  fs.rmSync(stash, { recursive: true, force: true });
  fs.mkdirSync(stash, { recursive: true });
  const snapshot = { ...info };
  delete snapshot.hasPrevious;
  fs.writeFileSync(path.join(stash, "shot.json"), JSON.stringify(snapshot, null, 2));
  for (const item of STASH_ITEMS) {
    const from = path.join(dir, item);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(stash, item));
  }
  info.hasPrevious = true;
}

/** Put the stashed version back. Returns false when there is nothing to restore. */
function restoreClip(dir) {
  const stash = path.join(dir, STASH_DIR);
  const metaPath = path.join(stash, "shot.json");
  if (!fs.existsSync(metaPath)) return false;
  const previous = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  for (const item of STASH_ITEMS) {
    fs.rmSync(path.join(dir, item), { recursive: true, force: true });
    const from = path.join(stash, item);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, item));
  }
  fs.rmSync(stash, { recursive: true, force: true });
  delete previous.hasPrevious;
  delete previous.requestId;
  writeShotJson(dir, previous);
  return true;
}

function buildWindowPrompt(talk) {
  if (normalizeEngine(talk.engine) === "ltx") return buildLtxPrompt(talk);
  const base = String(talk.basePrompt || DEFAULT_TALK_PROMPT).trim();
  const words = String(talk.text || "").trim();
  const speaking = words
    ? `the character is speaking, mouth moving naturally in time with these exact words: "${words}"`
    : "the character is speaking naturally";
  const continuing = talk.index > 0 ? ", continuing the same performance without changing pose or lighting" : "";
  return `${base}, ${speaking}${continuing}, ${HEAD_ONLY_SUFFIX}`;
}

async function extractFrameAt(videoPath, outPng, seconds) {
  const attempt = async (args) => {
    try {
      fs.rmSync(outPng, { force: true });
    } catch {
      /* ignore */
    }
    const { code } = await spawnCmd("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, "-i", videoPath, "-frames:v", "1", outPng]);
    return code === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 0;
  };
  if (Number.isFinite(seconds) && seconds > 0 && (await attempt(["-ss", String(Math.max(0, seconds))]))) return outPng;
  if (await attempt(["-sseof", "-0.1"])) return outPng;
  throw shotError("Could not read a frame from the previous clip");
}

function groupShots(projectDir, characterId, group) {
  const root = shotsDir(projectDir, characterId);
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, "._deleted"))) continue;
    let info = null;
    try {
      info = readShotJson(dir);
    } catch {
      info = null;
    }
    if (info && info.status !== "deleted" && info.talk && info.talk.group === group) found.push({ dir, info });
  }
  return found.sort((a, b) => a.info.talk.index - b.info.talk.index);
}

async function runChain(projectDir, characterId, group, startIndex, options = {}) {
  const key = `${characterId}/${group}`;
  if (running.has(key)) return;
  running.add(key);
  cancelled.delete(key);
  let finish;
  chains.set(key, new Promise((resolve) => { finish = resolve; }));
  const stopped = () => cancelled.has(key);
  options = { ...options, isCancelled: stopped };
  try {
    const shots = groupShots(projectDir, characterId, group);
    const extract = options.extractFrame || extractFrameAt;
    for (let i = startIndex; i < shots.length; i++) {
      if (stopped()) return;
      const { dir, info } = shots[i];
      if (info.status === "ready") continue;
      info.status = "making";
      delete info.error;
      writeShotJson(dir, info);

      let imageBase64 = null;
      if (i === 0) {
        const own = path.join(dir, "start_frame.png");
        const refAbs = info.refImage ? path.join(projectDir, info.refImage) : "";
        if (fs.existsSync(own)) imageBase64 = fs.readFileSync(own).toString("base64");
        else if (refAbs && fs.existsSync(refAbs)) imageBase64 = fs.readFileSync(refAbs).toString("base64");
      } else {
        const prev = shots[i - 1];
        const prevSource = path.join(prev.dir, "source.mp4");
        if (prev.info.status !== "ready" || !fs.existsSync(prevSource)) {
          info.status = "error";
          info.error = `Window ${i} is not ready, so this window cannot start from its last frame.`;
          writeShotJson(dir, info);
          return;
        }
        const startPng = path.join(dir, "start_frame.png");
        try {
          await extract(prevSource, startPng, prev.info.talk.windowSec);
          const headOnBlack = normalizeEngine(info.engine) === "ltx" || info.keyMode === HEAD_BLACK_KEY;
          if (headOnBlack) await ensureChainHeadSize(shots, options);
          const chainTarget = Number(shots[0].info.headSizeTarget) || 0;
          if (headOnBlack && chainTarget > 0) {
            await (options.normalizeStart || normalizeHeadFrame)(startPng, chainTarget, options);
          }
          imageBase64 = fs.readFileSync(startPng).toString("base64");
        } catch (err) {
          info.status = "error";
          info.error = err.message;
          writeShotJson(dir, info);
          return;
        }
      }
      if (!imageBase64) {
        info.status = "error";
        info.error = "No starting image: the character has no reference head.";
        writeShotJson(dir, info);
        return;
      }

      const ltx = normalizeEngine(info.engine) === "ltx";
      const headSizeTarget = ltx ? Number(shots[0].info.headSizeTarget) || 0 : 0;
      const fullPrompt = ltx
        ? buildWindowPrompt(info.talk)
        : `${buildWindowPrompt(info.talk)}, ${BG_PROMPT_SUFFIX[info.background] || BG_PROMPT_SUFFIX.green}`;
      await runGrokShot(dir, info, {
        engine: ltx ? "ltx" : "grok",
        audioFile: info.talk.audio,
        durationSec: Math.max(1, Math.round(info.talk.windowSec * 100) / 100),
        fullPrompt,
        imageBase64,
        headSizeTarget,
        lockHeadSize: ltx && i === 0 && headSizeTarget === 0,
        dur: info.talk.clipSec,
        jobKey: `${characterId}/${info.id}`,
        options,
        finalize: (done) => {
          done.in = 1;
          done.out = Math.max(1, Math.min(done.frameCount, Math.round(info.talk.windowSec * (done.fps || 24))));
        },
      });
      if (info.status !== "ready") return;
    }
  } finally {
    running.delete(key);
    chains.delete(key);
    finish();
  }
}

/**
 * Chains only run in this process. A queued/making window with no running
 * chain was interrupted (e.g. the engine restarted), so report its first
 * unfinished window as failed to let the UI offer a retry. Not persisted.
 */
function markInterruptedTalkShots(characterId, shots) {
  const byGroup = new Map();
  for (const shot of shots) {
    if (!shot.talk) continue;
    if (!byGroup.has(shot.talk.group)) byGroup.set(shot.talk.group, []);
    byGroup.get(shot.talk.group).push(shot);
  }
  for (const [group, list] of byGroup) {
    if (running.has(`${characterId}/${group}`)) continue;
    list.sort((a, b) => a.talk.index - b.talk.index);
    const next = list.find((shot) => shot.status !== "ready");
    if (next && (next.status === "making" || next.status === "queued")) {
      next.status = "error";
      next.error = "Interrupted before this clip finished. Retry to continue the chain.";
    }
  }
  return shots;
}


function isInsideProject(projectDir, rel) {
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return false;
  const root = path.resolve(projectDir);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) && START_EXT.test(abs);
}

function startsDir(projectDir, characterId) {
  return path.join(shotsDir(projectDir, characterId), START_DIR);
}

/**
 * Images a talking head can start from, newest first within each kind.
 * Uploaded heads come first. The full-body character reference is listed
 * last and flagged, because starting from it makes Grok draw the body.
 */
function listTalkingHeadStarts(projectDir, characterId, referenceRel = "") {
  const out = [];
  const dir = startsDir(projectDir, characterId);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((name) => START_EXT.test(name));
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    for (const name of files) {
      out.push({
        kind: "uploaded",
        label: name,
        rel: `characters/${characterId}/shots/${START_DIR}/${name}`,
        thumb: `${START_DIR}/${name}`,
      });
    }
  }
  const root = shotsDir(projectDir, characterId);
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      let info = null;
      try {
        info = readShotJson(path.join(root, entry.name));
      } catch {
        info = null;
      }
      if (!info || info.status !== "ready" || info.talk || info.shotType !== "head") continue;
      if (!fs.existsSync(path.join(root, entry.name, "poster.jpg"))) continue;
      out.push({
        kind: "head-shot",
        label: info.name || info.id,
        rel: `characters/${characterId}/shots/${entry.name}/poster.jpg`,
        thumb: `${entry.name}/poster.jpg`,
      });
    }
  }
  if (referenceRel && fs.existsSync(path.join(projectDir, referenceRel))) {
    out.push({ kind: "reference", label: "Character reference (usually full body)", rel: referenceRel, thumb: "", fullBody: true });
  }
  return out;
}

/** Keep an uploaded start image on the character so it is picked again next time. */
function saveTalkingHeadStart(projectDir, characterId, body = {}) {
  const data = String(body.data || "").replace(/^data:[^,]+,/, "");
  if (!data) throw shotError("No image data");
  const buffer = Buffer.from(data, "base64");
  if (buffer.length < 100) throw shotError("That is not an image");
  const isPng = buffer.subarray(0, 4).toString("hex") === "89504e47";
  const isJpg = buffer.subarray(0, 2).toString("hex") === "ffd8";
  const isWebp = buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  if (!isPng && !isJpg && !isWebp) throw shotError("Use a PNG, JPG or WebP image");
  const ext = isPng ? "png" : isWebp ? "webp" : "jpg";
  const stem = slugName(path.basename(String(body.name || "head"), path.extname(String(body.name || ""))));
  const dir = startsDir(projectDir, characterId);
  fs.mkdirSync(dir, { recursive: true });
  let name = `${stem}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 999; i++) name = `${stem}_${i}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return { ok: true, rel: `characters/${characterId}/shots/${START_DIR}/${name}`, thumb: `${START_DIR}/${name}`, label: name };
}

/**
 * Stop a running chain (no new clip is sent to Grok; a clip already sent
 * is billed either way) and remove the clips that did not finish. With
 * removeAll the finished clips go too.
 */
async function stopTalkingHead(projectDir, characterId, group, { removeAll = false } = {}) {
  const key = `${characterId}/${group}`;
  const members = groupShots(projectDir, characterId, group);
  if (!members.length) throw shotError("Talking head not found", "ENOENT");
  if (running.has(key)) {
    cancelled.add(key);
    const finished = chains.get(key);
    if (finished) {
      let timer;
      await Promise.race([finished, new Promise((resolve) => { timer = setTimeout(resolve, 20000); })]);
      clearTimeout(timer);
    }
  }
  let removed = 0;
  for (const { dir, info } of groupShots(projectDir, characterId, group)) {
    if (!removeAll && info.status === "ready") continue;
    if (!removeAll && info.hasPrevious) {
      try {
        if (restoreClip(dir)) continue;
      } catch {
        /* fall through and remove it */
      }
    }
    try {
      shotsModule.deleteShot(projectDir, characterId, info.id);
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  cancelled.delete(key);
  return { ok: true, group, removed };
}

function uniqueGroupId(projectDir, characterId, base) {
  const root = shotsDir(projectDir, characterId);
  const taken = (id) => fs.existsSync(path.join(root, `${id}_01`));
  if (!taken(base)) return base;
  for (let i = 2; i < 999; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

/**
 * Create one shot per window (queued) and start the chain in the background.
 * The returned object has a non-enumerable `completion` promise (tests await it).
 */
async function makeTalkingHead(projectDir, characterId, body = {}, options = {}) {
  const plan = planTalkingHead(projectDir, body);
  const char = String(characterId || plan.characterId || "").trim();
  if (!char) throw shotError("character is required");
  if (!plan.hasWords || !plan.windows.length) {
    throw shotError("No transcript found for this audio. Re-import it with transcription so the words are known.");
  }
  const refRel = String(body.refRel || "").trim().replace(/\\/g, "/");
  const refB64 = body.refBase64 ? String(body.refBase64) : "";
  if (refRel && !isInsideProject(projectDir, refRel)) throw shotError("Invalid start image path");
  if (!refB64 && !(refRel && fs.existsSync(path.join(projectDir, refRel)))) {
    throw shotError("Choose a start image: a head shot of the character with no neck or collar.");
  }

  const engine = normalizeEngine(body.engine);
  if (engine === "ltx" && !comfyCloud.resolveCredentials()) {
    throw shotError("COMFY_CLOUD_API_KEY is not configured. Add it to the engine .env file, then restart the engine.", "ENOKEY");
  }
  const basePrompt = String(body.prompt || "").trim() || DEFAULT_TALK_PROMPT;
  const subject = String(body.subject || "").trim().slice(0, 300);
  const label = path.posix.basename(path.posix.dirname(plan.audioRel));
  const group = uniqueGroupId(projectDir, char, `talk_${slugName(label)}`);
  const wavAbs = path.join(projectDir, plan.audioRel);
  const extractAudio = options.extractWavSlice || extractWavSlice;
  const total = plan.windows.length;
  const shotIds = [];

  for (const win of plan.windows) {
    const id = `${group}_${String(win.index + 1).padStart(2, "0")}`;
    const dir = shotDir(projectDir, char, id);
    fs.mkdirSync(dir, { recursive: true });
    await extractAudio(wavAbs, path.join(dir, "audio.wav"), plan.inSec + win.start, win.duration);
    if (win.index === 0 && refB64) fs.writeFileSync(path.join(dir, "start_frame.png"), Buffer.from(refB64, "base64"));
    writeShotJson(dir, {
      id,
      name: `${group} (${win.index + 1}/${total})`,
      filename: "",
      prompt: buildWindowPrompt({ basePrompt, text: win.text, index: win.index, engine, subject, characterId: char }),
      refImage: refRel,
      engine,
      ...(engine === "ltx" ? { keyMode: HEAD_BLACK_KEY } : {}),
      background: engine === "ltx" ? "black" : "green",
      fps: 0,
      frameCount: 0,
      in: 1,
      out: 0,
      category: "head_moves",
      shotType: "head",
      createdAt: new Date(Date.now() + win.index).toISOString(),
      status: "queued",
      talk: {
        group,
        index: win.index,
        total,
        text: win.text,
        basePrompt,
        startSec: win.start,
        endSec: win.end,
        windowSec: win.duration,
        clipSec: win.clipSec,
        audioRel: plan.audioRel,
        audioInSec: plan.inSec + win.start,
        audio: "audio.wav",
        engine,
        subject,
        characterId: char,
      },
    });
    shotIds.push(id);
  }

  const completion = runChain(projectDir, char, group, 0, options);
  const result = { ok: true, group, shotIds, windows: plan.windows };
  Object.defineProperty(result, "completion", { value: completion, enumerable: false });
  return result;
}

/** Continue a stopped chain from its first window that is not ready. */
async function resumeTalkingHead(projectDir, characterId, group, options = {}) {
  const shots = groupShots(projectDir, characterId, group);
  if (!shots.length) throw shotError("Talking head not found", "ENOENT");
  if (running.has(`${characterId}/${group}`)) throw shotError("This talking head is already generating.");
  const startIndex = shots.findIndex((shot) => shot.info.status !== "ready");
  if (startIndex < 0) return { ok: true, group, resumed: false };
  for (let i = startIndex; i < shots.length; i++) {
    const { dir, info } = shots[i];
    info.status = "queued";
    delete info.error;
    writeShotJson(dir, info);
  }
  const completion = runChain(projectDir, characterId, group, startIndex, options);
  const result = { ok: true, group, resumed: true, fromWindow: startIndex + 1 };
  Object.defineProperty(result, "completion", { value: completion, enumerable: false });
  return result;
}

/**
 * Re-point one clip at another engine, e.g. Grok when LTX failed to lip-sync.
 * Clips in a head-on-black chain keep the black backdrop and head keying so the
 * new clip still composites with its neighbours.
 */
function switchClipEngine(info, engine) {
  info.engine = engine;
  info.talk = { ...info.talk, engine };
  if (engine === "ltx") {
    info.keyMode = HEAD_BLACK_KEY;
    info.background = "black";
  }
  info.prompt = buildWindowPrompt(info.talk);
}

/**
 * Regenerate one clip with a new seed. By default only that clip is redone and
 * the later clips are kept; with cascade the later clips are redone too so
 * each still starts from the previous clip's last frame.
 */
async function redoTalkingHeadClip(projectDir, characterId, group, index, options = {}) {
  const shots = groupShots(projectDir, characterId, group);
  if (!shots.length) throw shotError("Talking head not found", "ENOENT");
  if (running.has(`${characterId}/${group}`)) throw shotError("This talking head is already generating.");
  const target = Number(index);
  if (!Number.isInteger(target) || target < 0 || target >= shots.length) throw shotError("That clip does not exist");
  const last = options.cascade === true ? shots.length - 1 : target;
  const engineOverride = options.engine ? normalizeEngine(options.engine) : "";
  if (options.engine && String(options.engine).toLowerCase() !== engineOverride) throw shotError("Unknown engine");
  if (engineOverride === "ltx" && !comfyCloud.resolveCredentials()) {
    throw shotError("COMFY_CLOUD_API_KEY is not configured. Add it to the engine .env file, then restart the engine.", "ENOKEY");
  }
  for (let i = target; i <= last; i++) {
    const { dir, info } = shots[i];
    if (info.status === "ready") stashClip(dir, info);
    if (engineOverride && i === target) switchClipEngine(info, engineOverride);
    info.status = "queued";
    delete info.error;
    delete info.requestId;
    writeShotJson(dir, info);
  }
  const completion = runChain(projectDir, characterId, group, target, options);
  const result = { ok: true, group, redone: target + 1, cascade: options.cascade === true };
  Object.defineProperty(result, "completion", { value: completion, enumerable: false });
  return result;
}

/** Bring back the clip a redo replaced. */
async function undoTalkingHeadRedo(projectDir, characterId, group, index) {
  const shots = groupShots(projectDir, characterId, group);
  if (!shots.length) throw shotError("Talking head not found", "ENOENT");
  if (running.has(`${characterId}/${group}`)) throw shotError("Wait for this talking head to finish generating, or stop it first.");
  const target = Number(index);
  if (!Number.isInteger(target) || target < 0 || target >= shots.length) throw shotError("That clip does not exist");
  if (!restoreClip(shots[target].dir)) throw shotError("There is no earlier version of that clip to restore");
  return { ok: true, group, restored: target + 1 };
}

module.exports = {
  CLIP_LENGTHS,
  MAX_WINDOW_SEC,
  DEFAULT_TALK_PROMPT,
  planWindows,
  planTalkingHead,
  buildWindowPrompt,
  extractFrameAt,
  makeTalkingHead,
  resumeTalkingHead,
  redoTalkingHeadClip,
  undoTalkingHeadRedo,
  markInterruptedTalkShots,
  listTalkingHeadStarts,
  saveTalkingHeadStart,
  stopTalkingHead,
};
