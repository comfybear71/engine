"use strict";

/**
 * PNG import for Studio Assets + tiles: props land in a location's
 * staging.json, backgrounds become backgrounds/<id>/bg.png (cover thumbs).
 */

const fs = require("fs");
const path = require("path");

const { decodeImageBuffer, posixJoin } = require("./assetIngest");
const { listKnownCharacterIds, listKnownLocations, loadStaging } = require("./parser/assetLibrary");
const { isSafeFolderName, readLibrary, writeLibrary } = require("./studioProjects");
const { REFERENCE_DIR, characterDir, writeCharacterJson, imageExtension } = require("./characterLocal");

function stillError(message, code) {
  const err = new Error(message);
  err.code = code || "EINVAL";
  return err;
}

function slugName(raw, fallback) {
  const cleaned = String(raw || "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || fallback || "image";
}

function uniqueId(existing, base) {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function writePng(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

function importCharacter(projectDir, globalAssetsDir, body, buf) {
  const display = String((body && body.name) || "").trim().replace(/\.[^.]+$/, "");
  if (!display) throw stillError("Give the character a name");
  const ids = new Set(listKnownCharacterIds(projectDir, globalAssetsDir));
  const id = uniqueId(ids, slugName(display, "character"));
  if (!isSafeFolderName(id)) throw stillError("Invalid character name");
  const filename = `full${imageExtension(buf)}`;
  const reference = posixJoin(REFERENCE_DIR, filename);
  const dir = characterDir(projectDir, id);
  fs.mkdirSync(path.join(dir, REFERENCE_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, REFERENCE_DIR, filename), buf);
  writeCharacterJson(projectDir, id, {
    id,
    display_name: display,
    aliases: [display],
    z: 10,
    asset: reference,
    reference,
    slots: {},
  });
  const library = readLibrary(projectDir);
  if (!library.characters.includes(id)) {
    library.characters.push(id);
    writeLibrary(projectDir, library);
  }
  return { ok: true, kind: "character", id, rel: posixJoin("characters", id, reference) };
}

function importStill(projectDir, globalAssetsDir, body) {
  const kind = body && body.kind;
  const buf = decodeImageBuffer(body);
  if (kind === "character") return importCharacter(projectDir, globalAssetsDir, body, buf);
  if (kind === "background") {
    const locations = new Set(listKnownLocations(projectDir, globalAssetsDir));
    const id = uniqueId(locations, slugName(body.name, "background"));
    if (!isSafeFolderName(id)) throw stillError("Invalid background name");
    const rel = posixJoin("backgrounds", id, "bg.png");
    writePng(path.join(projectDir, rel), buf);
    const stagingAbs = path.join(projectDir, "backgrounds", id, "staging.json");
    if (!fs.existsSync(stagingAbs)) {
      fs.writeFileSync(
        stagingAbs,
        `${JSON.stringify({ marks: { centre: { x: 960, y: 1080, scale: 1 } }, auto_order: ["centre"], props: {} }, null, 2)}\n`
      );
    }
    return { ok: true, kind, id, rel };
  }
  if (kind === "prop") {
    const locations = listKnownLocations(projectDir, globalAssetsDir);
    const location = String(body.location || locations[0] || "").trim();
    if (!location || !isSafeFolderName(location)) throw stillError("Need a location to put this prop in");
    const stagingPath = path.join(projectDir, "backgrounds", location, "staging.json");
    let staging = { marks: { centre: { x: 960, y: 1080, scale: 1 } }, auto_order: ["centre"], props: {} };
    if (fs.existsSync(stagingPath)) {
      try {
        staging = JSON.parse(fs.readFileSync(stagingPath, "utf8")) || staging;
      } catch {
        /* keep default */
      }
    } else {
      const live = loadStaging(projectDir, globalAssetsDir, location);
      staging.marks = live.marks || staging.marks;
      staging.auto_order = live.autoOrder || staging.auto_order;
      staging.props = live.props || {};
    }
    staging.props = staging.props && typeof staging.props === "object" ? staging.props : {};
    const id = uniqueId(new Set(Object.keys(staging.props)), slugName(body.name, "prop"));
    if (!isSafeFolderName(id)) throw stillError("Invalid prop name");
    const rel = posixJoin("backgrounds", location, "props", `${id}.png`);
    writePng(path.join(projectDir, rel), buf);
    staging.props[id] = { asset: `props/${id}.png`, z: 1, x: 960, y: 900, scale: 1, anchor: "bottom-center" };
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, `${JSON.stringify(staging, null, 2)}\n`);
    return { ok: true, kind, id, location, rel };
  }
  throw stillError(`Unknown import kind: ${kind}`);
}

module.exports = { importStill, slugName };
