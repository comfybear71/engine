"use strict";

/**
 * Show folders at <repo>/shows/<show-id>/: show.json, shared characters /
 * backgrounds / props, episodes/ (each an existing-style project), and
 * final/cut.json plus concatenated mp4s. Moving a flat project into a
 * show is a rename, not a copy or delete.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  isSafeFolderName,
  createEmptyProject,
  duplicateProject,
  renameProject,
  describeProjectContents,
  summarizeProjectCached,
  listScriptFiles,
  renderOutputName,
  DEFAULT_SCRIPT,
  SKIP_COPY_NAMES,
} = require("./studioProjects");
const { resolveAsset, listKnownCharacterIds, listKnownLocations, resolveGlobalAssetsDir } = require("./parser/assetLibrary");
const { listCharacters, listStaging } = require("./studioLibrary");
const { buildFinalCutConcatArgs, estimateFinalDurationSeconds } = require("./finalCut");
const { readMp4DurationSeconds } = require("./parser/mp4Duration");
const { probeDurationSeconds } = require("./parser/ffprobeDuration");

const SHOW_JSON = "show.json";
const FINAL_DIR = "final";
const CUT_FILENAME = "cut.json";
const TRASH_META = "engine-trash.json";
const RESERVED_SHOW_NAMES = new Set(["_trash", "_global_assets"]);

function isSafeShowId(name) {
  return isSafeFolderName(name) && !RESERVED_SHOW_NAMES.has(name);
}

function slugifyShowId(name) {
  const slug = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return isSafeShowId(slug) ? slug : "";
}

function resolveInside(root, name) {
  if (!isSafeShowId(name)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, name);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    return null;
  }
  return resolved;
}

function showsRoot(showsDir) {
  return path.resolve(showsDir);
}

function emptyShowRecord(id) {
  return { name: id, description: "", thumbnail: null };
}

function readShowJson(showDir) {
  const file = path.join(showDir, SHOW_JSON);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : path.basename(showDir),
      description: typeof raw.description === "string" ? raw.description : "",
      thumbnail: typeof raw.thumbnail === "string" && raw.thumbnail.trim() ? raw.thumbnail.trim() : null,
    };
  } catch {
    return { ...emptyShowRecord(path.basename(showDir)) };
  }
}

function writeShowJson(showDir, record) {
  const next = {
    name: record.name,
    description: record.description || "",
    thumbnail: record.thumbnail || null,
  };
  fs.writeFileSync(path.join(showDir, SHOW_JSON), JSON.stringify(next, null, 2) + "\n");
  return next;
}

function defaultFinalCut() {
  return { name: "final", gapSeconds: 0, fadeSeconds: 0, items: [] };
}

function readFinalCut(showDir) {
  const file = path.join(showDir, FINAL_DIR, CUT_FILENAME);
  if (!fs.existsSync(file)) return defaultFinalCut();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === "object") : [];
    return {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "final",
      gapSeconds: Number.isFinite(Number(raw.gapSeconds)) ? Math.max(0, Number(raw.gapSeconds)) : 0,
      fadeSeconds: Number.isFinite(Number(raw.fadeSeconds)) ? Math.max(0, Number(raw.fadeSeconds)) : 0,
      items,
    };
  } catch {
    return defaultFinalCut();
  }
}

function writeFinalCut(showDir, cut) {
  const dir = path.join(showDir, FINAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const next = {
    name: cut.name || "final",
    gapSeconds: Math.max(0, Number(cut.gapSeconds) || 0),
    fadeSeconds: Math.max(0, Number(cut.fadeSeconds) || 0),
    items: Array.isArray(cut.items) ? cut.items : [],
  };
  fs.writeFileSync(path.join(dir, CUT_FILENAME), JSON.stringify(next, null, 2) + "\n");
  return next;
}

function assertShow(showsDir, showId) {
  if (!isSafeShowId(showId)) {
    const err = new Error("Invalid show name");
    err.code = "EINVAL";
    throw err;
  }
  const showDir = resolveInside(showsDir, showId);
  if (!showDir || !fs.existsSync(showDir) || !fs.statSync(showDir).isDirectory()) {
    const err = new Error(`Show not found: ${showId}`);
    err.code = "ENOENT";
    throw err;
  }
  if (!fs.existsSync(path.join(showDir, SHOW_JSON))) {
    const err = new Error(`Show not found: ${showId}`);
    err.code = "ENOENT";
    throw err;
  }
  return showDir;
}

function episodesDir(showDir) {
  return path.join(showDir, "episodes");
}

function resolveEpisodeDir(showsDir, showId, episodeId) {
  if (!isSafeShowId(showId) || !isSafeFolderName(episodeId) || RESERVED_SHOW_NAMES.has(episodeId)) {
    return null;
  }
  const showDir = resolveInside(showsDir, showId);
  if (!showDir) return null;
  const resolved = path.resolve(showDir, "episodes", episodeId);
  const rel = path.relative(path.resolve(showDir, "episodes"), resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    return null;
  }
  return resolved;
}

function listEpisodeIds(showDir) {
  const dir = episodesDir(showDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafeFolderName(entry.name) && !RESERVED_SHOW_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function summarizeEpisode(showDir, episodeId, showId) {
  const projectDir = path.join(episodesDir(showDir), episodeId);
  const globalAssetsDir = resolveGlobalAssetsDir(projectDir);
  const summary = await summarizeProjectCached(projectDir, episodeId, globalAssetsDir);
  return { ...summary, showId };
}

async function summarizeShow(showsDir, showId) {
  const showDir = assertShow(showsDir, showId);
  const record = readShowJson(showDir) || emptyShowRecord(showId);
  const episodeIds = listEpisodeIds(showDir);
  const episodes = [];
  for (const episodeId of episodeIds) {
    episodes.push(await summarizeEpisode(showDir, episodeId, showId));
  }
  let durationSeconds = 0;
  let lastRenderAt = null;
  let thumbRel = record.thumbnail;
  let thumbMtime = null;
  for (const episode of episodes) {
    if (episode.durationSeconds) durationSeconds += episode.durationSeconds;
    if (episode.lastRenderAt && (!lastRenderAt || episode.lastRenderAt > lastRenderAt)) {
      lastRenderAt = episode.lastRenderAt;
    }
    if (!thumbRel && episode.thumbRel) {
      thumbRel = episode.thumbRel;
      thumbMtime = episode.thumbMtime;
    }
  }
  if (record.thumbnail) {
    const resolved = resolveAsset(showDir, resolveGlobalAssetsDir(showDir), record.thumbnail);
    if (resolved) {
      try {
        thumbMtime = Math.round(fs.statSync(resolved.absPath).mtimeMs);
      } catch {
        thumbMtime = null;
      }
    }
  }
  return {
    id: showId,
    name: record.name,
    description: record.description,
    thumbnail: record.thumbnail,
    thumbRel,
    thumbMtime,
    episodeCount: episodes.length,
    durationSeconds: durationSeconds > 0 ? Math.round(durationSeconds * 10) / 10 : null,
    lastRenderAt,
    episodes,
  };
}

function listShowIds(showsDir) {
  const root = showsRoot(showsDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafeShowId(entry.name) && fs.existsSync(path.join(root, entry.name, SHOW_JSON)))
    .map((entry) => entry.name)
    .sort();
}

async function listShows(showsDir) {
  const summaries = [];
  for (const id of listShowIds(showsDir)) {
    summaries.push(await summarizeShow(showsDir, id));
  }
  return summaries;
}

function ensureShowLayout(showDir) {
  fs.mkdirSync(path.join(showDir, "characters"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "backgrounds"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "props"), { recursive: true });
  fs.mkdirSync(path.join(showDir, "episodes"), { recursive: true });
  fs.mkdirSync(path.join(showDir, FINAL_DIR), { recursive: true });
}

function createShow(showsDir, rawName, options = {}) {
  const displayName = String(options.displayName || rawName || "").trim() || String(rawName || "").trim();
  const id = options.id || slugifyShowId(rawName) || slugifyShowId(displayName);
  if (!isSafeShowId(id)) {
    const err = new Error("Invalid show name");
    err.code = "EINVAL";
    throw err;
  }
  const showDir = resolveInside(showsDir, id);
  if (!showDir) {
    const err = new Error("Invalid show name");
    err.code = "EINVAL";
    throw err;
  }
  if (fs.existsSync(showDir)) {
    const err = new Error(`Show already exists: ${id}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.mkdirSync(showDir, { recursive: true });
  ensureShowLayout(showDir);
  writeShowJson(showDir, {
    name: displayName || id,
    description: options.description || "",
    thumbnail: null,
  });
  writeFinalCut(showDir, defaultFinalCut());
  return { id, showDir };
}

function nextCopyName(parentDir, name) {
  const base = `${name}-copy`;
  if (!fs.existsSync(path.join(parentDir, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(path.join(parentDir, candidate))) return candidate;
  }
  const err = new Error("Too many copies");
  err.code = "EINVAL";
  throw err;
}

function duplicateShow(showsDir, showId) {
  const showDir = assertShow(showsDir, showId);
  const copyId = nextCopyName(showsDir, showId);
  const dest = resolveInside(showsDir, copyId);
  if (!dest) {
    const err = new Error("Invalid show name");
    err.code = "EINVAL";
    throw err;
  }
  fs.cpSync(showDir, dest, {
    recursive: true,
    filter: (src) => !SKIP_COPY_NAMES.has(path.basename(src)),
  });
  const record = readShowJson(dest) || emptyShowRecord(copyId);
  writeShowJson(dest, { ...record, name: `${record.name} copy` });
  return { id: copyId, showDir: dest };
}

function renameShow(showsDir, showId, newId, options = {}) {
  const showDir = assertShow(showsDir, showId);
  const record = readShowJson(showDir) || emptyShowRecord(showId);
  if (options.displayName) record.name = String(options.displayName).trim() || record.name;
  if (!newId || newId === showId) {
    writeShowJson(showDir, record);
    return { id: showId, showDir };
  }
  const dest = resolveInside(showsDir, newId);
  if (!dest) {
    const err = new Error("Invalid show name");
    err.code = "EINVAL";
    throw err;
  }
  if (fs.existsSync(dest)) {
    const err = new Error(`Show already exists: ${newId}`);
    err.code = "EEXIST";
    throw err;
  }
  if (record.name === showId) record.name = newId;
  fs.renameSync(showDir, dest);
  writeShowJson(dest, record);
  return { id: newId, showDir: dest };
}

function createEpisode(showsDir, showId, episodeId) {
  const showDir = assertShow(showsDir, showId);
  if (!isSafeFolderName(episodeId) || RESERVED_SHOW_NAMES.has(episodeId)) {
    const err = new Error("Invalid episode name");
    err.code = "EINVAL";
    throw err;
  }
  return { id: episodeId, projectDir: createEmptyProject(episodesDir(showDir), episodeId) };
}

function duplicateEpisode(showsDir, showId, episodeId) {
  const showDir = assertShow(showsDir, showId);
  const copied = duplicateProject(episodesDir(showDir), episodeId);
  return { id: copied.name, projectDir: copied.projectDir };
}

function renameEpisode(showsDir, showId, episodeId, newId) {
  const showDir = assertShow(showsDir, showId);
  const renamed = renameProject(episodesDir(showDir), episodeId, newId);
  return { id: renamed.name, projectDir: renamed.projectDir };
}

function moveProjectIntoShow(projectsDir, showsDir, projectName, showId, options = {}) {
  if (!isSafeFolderName(projectName)) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  const src = path.resolve(projectsDir, projectName);
  const rel = path.relative(path.resolve(projectsDir), src);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    const err = new Error(`Project not found: ${projectName}`);
    err.code = "ENOENT";
    throw err;
  }
  let showDir;
  if (options.create) {
    try {
      ({ showDir } = createShow(showsDir, showId, { displayName: options.displayName || showId }));
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      showDir = assertShow(showsDir, showId);
    }
  } else {
    showDir = assertShow(showsDir, showId);
  }
  const dest = path.join(episodesDir(showDir), projectName);
  if (fs.existsSync(dest)) {
    const err = new Error(`Episode already exists: ${projectName}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.mkdirSync(episodesDir(showDir), { recursive: true });
  fs.renameSync(src, dest);
  return { showId: path.basename(showDir), episodeId: projectName, projectDir: dest };
}

function moveEpisodeToExperiments(projectsDir, showsDir, showId, episodeId) {
  const showDir = assertShow(showsDir, showId);
  const src = resolveEpisodeDir(showsDir, showId, episodeId);
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    const err = new Error(`Episode not found: ${episodeId}`);
    err.code = "ENOENT";
    throw err;
  }
  const dest = path.resolve(projectsDir, episodeId);
  const rel = path.relative(path.resolve(projectsDir), dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !isSafeFolderName(episodeId)) {
    const err = new Error("Invalid project name");
    err.code = "EINVAL";
    throw err;
  }
  if (fs.existsSync(dest)) {
    const err = new Error(`Project already exists: ${episodeId}`);
    err.code = "EEXIST";
    throw err;
  }
  fs.renameSync(src, dest);
  return { name: episodeId, projectDir: dest, showId };
}

function writeTrashMeta(folder, meta) {
  fs.writeFileSync(path.join(folder, TRASH_META), JSON.stringify(meta, null, 2) + "\n");
}

function readTrashMeta(folder) {
  const file = path.join(folder, TRASH_META);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listShowLevelProps(showDir) {
  const dir = path.join(showDir, "props");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const props = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(png|jpe?g|webp)$/i.test(entry)) continue;
    const id = entry.replace(/\.(png|jpe?g|webp)$/i, "");
    const rel = `props/${entry}`;
    let mtime = null;
    try {
      mtime = Math.round(fs.statSync(path.join(dir, entry)).mtimeMs);
    } catch {
      mtime = null;
    }
    props.push({ id, location: null, z: 0, x: null, y: null, scale: 1, anchor: "bottom-center", thumbRel: rel, mtime, source: "show" });
  }
  return props;
}

function describeShowAssets(showDir) {
  const globalAssetsDir = resolveGlobalAssetsDir(showDir);
  const characterIds = listKnownCharacterIds(showDir, globalAssetsDir).filter((id) => {
    const resolved = resolveAsset(showDir, globalAssetsDir, `characters/${id}/character.json`);
    return resolved && (resolved.source === "show" || resolved.source === "project");
  });
  const localChars = fs.existsSync(path.join(showDir, "characters"))
    ? fs.readdirSync(path.join(showDir, "characters")).filter((name) =>
        fs.statSync(path.join(showDir, "characters", name)).isDirectory()
      )
    : [];
  const ids = [...new Set([...characterIds, ...localChars])].sort();
  const characters = listCharacters(showDir, globalAssetsDir, { ids }).map((character) => ({
    ...character,
    source: character.source === "project" ? "show" : character.source,
  }));
  const locationIds = listKnownLocations(showDir, globalAssetsDir).filter((id) => {
    const bg = resolveAsset(showDir, globalAssetsDir, `backgrounds/${id}/bg.png`);
    const staging = resolveAsset(showDir, globalAssetsDir, `backgrounds/${id}/staging.json`);
    return (bg && bg.source === "show") || (staging && staging.source === "show");
  });
  const staging = listStaging(showDir, globalAssetsDir, { locationIds });
  return {
    characters,
    backgrounds: staging.backgrounds,
    props: [...staging.props, ...listShowLevelProps(showDir)],
  };
}

function newestEpisodeRender(projectDir, scriptName) {
  const file = renderOutputName(scriptName || DEFAULT_SCRIPT);
  const abs = path.join(projectDir, "renders", file);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { file, abs };
  const fallback = path.join(projectDir, "renders", "output.mp4");
  if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) return { file: "output.mp4", abs: fallback };
  return null;
}

function scriptIsNewerThan(projectDir, scriptName, fileAbs) {
  try {
    const scriptMtime = fs.statSync(path.join(projectDir, scriptName)).mtimeMs;
    const renderMtime = fs.statSync(fileAbs).mtimeMs;
    return renderMtime < scriptMtime;
  } catch {
    return true;
  }
}

async function durationOfFile(abs) {
  const header = readMp4DurationSeconds(abs);
  if (Number.isFinite(header) && header > 0) return Math.round(header * 10) / 10;
  try {
    const probed = await probeDurationSeconds(abs);
    if (Number.isFinite(probed) && probed > 0) return Math.round(probed * 10) / 10;
  } catch {
    /* ignore */
  }
  return null;
}

async function planFinalCut(showsDir, showId) {
  const showDir = assertShow(showsDir, showId);
  const cut = readFinalCut(showDir);
  const planned = [];
  for (const item of cut.items) {
    const episodeId = item.episodeId;
    const script = item.script || DEFAULT_SCRIPT;
    const projectDir = resolveEpisodeDir(showsDir, showId, episodeId);
    if (!projectDir || !fs.existsSync(projectDir)) {
      planned.push({
        id: item.id,
        kind: item.kind || "episode",
        episodeId,
        script,
        label: episodeId || "(missing)",
        stale: true,
        missing: true,
        willRender: false,
        durationSeconds: null,
        inputPath: null,
        trimInSec: item.trimIn != null ? Number(item.trimIn) : 0,
        trimOutSec: item.trimOut != null ? Number(item.trimOut) : null,
      });
      continue;
    }
    const render = newestEpisodeRender(projectDir, script);
    const stale = !render || scriptIsNewerThan(projectDir, script, render.abs);
    const durationSeconds = render ? await durationOfFile(render.abs) : null;
    planned.push({
      id: item.id,
      kind: item.kind || "episode",
      episodeId,
      script,
      sceneId: item.sceneId || null,
      label: item.kind === "scene" && item.sceneId ? `${episodeId} · ${item.sceneId}` : episodeId,
      stale,
      missing: false,
      willRender: stale,
      durationSeconds,
      inputPath: render ? render.abs : null,
      renderFile: render ? render.file : renderOutputName(script),
      trimInSec: item.trimIn != null ? Number(item.trimIn) : 0,
      trimOutSec: item.trimOut != null ? Number(item.trimOut) : null,
    });
  }
  const staleCount = planned.filter((item) => item.willRender).length;
  const missingCount = planned.filter((item) => item.missing).length;
  const concatItems = planned.filter((item) => !item.missing);
  const estimatedSeconds = estimateFinalDurationSeconds(
    concatItems.map((item) => ({
      trimInSec: item.trimInSec,
      trimOutSec: item.trimOutSec,
      durationSec: item.durationSeconds,
    })),
    cut
  );
  return {
    cut,
    items: planned,
    staleCount,
    missingCount,
    estimatedSeconds,
    note:
      staleCount > 0
        ? `Will render ${staleCount} stale episode${staleCount === 1 ? "" : "s"} first, then concatenate ${planned.length} item${planned.length === 1 ? "" : "s"} (~${estimatedSeconds || "?"}s). ElevenLabs is not called.`
        : `Concatenate ${planned.length} item${planned.length === 1 ? "" : "s"} (~${estimatedSeconds || "?"}s). No episode re-render. ElevenLabs is not called.`,
  };
}

function spawnFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: "", stderr: "" };
    child.stdout.on("data", (d) => {
      chunks.stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      chunks.stderr += d.toString();
    });
    child.on("error", (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(chunks);
      else reject(new Error(chunks.stderr.trim().split("\n").pop() || `ffmpeg exited ${code}`));
    });
  });
}

async function renderFinalCut(showsDir, showId, options = {}) {
  const showDir = assertShow(showsDir, showId);
  const plan = await planFinalCut(showsDir, showId);
  if (plan.items.length === 0) {
    const err = new Error("Final cut is empty. Add episodes first.");
    err.code = "EINVAL";
    throw err;
  }
  if (plan.missingCount > 0) {
    const err = new Error("Final cut points at a missing episode.");
    err.code = "ENOENT";
    throw err;
  }
  const stillStale = plan.items.filter((item) => item.willRender);
  if (stillStale.length && !options.allowStale) {
    return { ok: false, needsRender: true, plan };
  }
  const ready = [];
  for (const item of plan.items) {
    if (!item.inputPath) {
      const err = new Error(`No render yet for ${item.episodeId}. Render that episode first.`);
      err.code = "ENOENT";
      throw err;
    }
    ready.push({
      inputPath: item.inputPath,
      trimInSec: item.trimInSec,
      trimOutSec: item.trimOutSec,
      durationSec: item.durationSeconds,
    });
  }
  const cut = plan.cut;
  const fileStem = String(options.name || cut.name || "final")
    .replace(/\.mp4$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "final";
  if (!isSafeFolderName(`${fileStem}.mp4`.replace(/\.mp4$/, "x"))) {
    const err = new Error("Invalid final-cut name");
    err.code = "EINVAL";
    throw err;
  }
  const outputPath = path.join(showDir, FINAL_DIR, `${fileStem}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = buildFinalCutConcatArgs(ready, outputPath, cut);
  if (options.buildOnly) return { ok: true, args, outputPath, plan };
  await spawnFfmpeg(args);
  return { ok: true, outputPath, file: `${fileStem}.mp4`, plan, args };
}

function describeShowContents(showDir) {
  const episodes = listEpisodeIds(showDir);
  let total = describeProjectContents(showDir);
  for (const id of episodes) {
    const extra = describeProjectContents(path.join(episodesDir(showDir), id));
    total = {
      scripts: [...total.scripts, ...extra.scripts.map((name) => `${id}/${name}`)],
      scriptBytes: total.scriptBytes + extra.scriptBytes,
      audio: { files: total.audio.files + extra.audio.files, bytes: total.audio.bytes + extra.audio.bytes },
      renders: { files: total.renders.files + extra.renders.files, bytes: total.renders.bytes + extra.renders.bytes },
      localAssets: {
        files: total.localAssets.files + extra.localAssets.files,
        bytes: total.localAssets.bytes + extra.localAssets.bytes,
      },
      libraryJsonBytes: total.libraryJsonBytes + extra.libraryJsonBytes,
      totalBytes: total.totalBytes + extra.totalBytes,
    };
  }
  return { ...total, episodes };
}

module.exports = {
  SHOW_JSON,
  FINAL_DIR,
  CUT_FILENAME,
  TRASH_META,
  RESERVED_SHOW_NAMES,
  isSafeShowId,
  slugifyShowId,
  resolveInside,
  resolveEpisodeDir,
  episodesDir,
  assertShow,
  readShowJson,
  writeShowJson,
  readFinalCut,
  writeFinalCut,
  defaultFinalCut,
  listShowIds,
  listShows,
  listEpisodeIds,
  summarizeShow,
  summarizeEpisode,
  createShow,
  duplicateShow,
  renameShow,
  createEpisode,
  duplicateEpisode,
  renameEpisode,
  moveProjectIntoShow,
  moveEpisodeToExperiments,
  writeTrashMeta,
  readTrashMeta,
  describeShowAssets,
  describeShowContents,
  planFinalCut,
  renderFinalCut,
  listScriptFiles,
};
