"use strict";

/**
 * Parses an `[Action: Name key=value key=value free text note]` tag body
 * (same key=value grammar is reused for [Move]/[Pose]/[Swing]/[Camera]).
 *
 * Grammar: the first word is the character name. Then zero or more
 * `key=value` tokens (no spaces inside a value) are consumed, with bare
 * flags (`flip`) allowed anywhere among them. The first token that is
 * neither `key=value` nor a bare flag ends the key/value section;
 * everything from there to the end of the line is kept verbatim as a
 * free-text `note` -- never an error. If that note itself contains a
 * `key=value` token, the parser warns (it was almost certainly meant as
 * an assignment and got swallowed).
 */

const { ScriptError } = require("./errors");

const KEY_VALUE_RE = /^([A-Za-z_][\w]*)=(\S+)$/;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;
const XY_RE = /^([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)$/;
const SECONDS_RE = /^(\d+(?:\.\d+)?)s$/i;
const HEAD_VIEWS = ["front", "left_34", "left_side", "right_34", "right_side", "up", "down"];

function parseActionTag(body, options = {}) {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { character: null, kv: {}, note: "" };
  }

  const extraBare = new Set((options.bareFlags || []).map((flag) => String(flag).toLowerCase()));
  const character = words[0];
  const kv = {};
  let i = 1;
  for (; i < words.length; i++) {
    const match = words[i].match(KEY_VALUE_RE);
    if (match) {
      const [, key, value] = match;
      kv[key.toLowerCase()] = value;
      continue;
    }
    // Bare flags may sit anywhere among key=value tokens (not only at the end).
    const word = words[i].toLowerCase();
    if (word === "flip" || extraBare.has(word)) {
      kv[word] = "true";
      continue;
    }
    break;
  }

  const note = words.slice(i).join(" ");
  return { character, kv, note };
}

/**
 * Same key=value / bare-flag grammar as parseActionTag, but with no
 * leading character name -- used by [Camera: zoom=1.3 over=8s].
 */
function parseKvTag(body, options = {}) {
  const extraBare = new Set((options.bareFlags || []).map((flag) => String(flag).toLowerCase()));
  const words = body.trim().split(/\s+/).filter(Boolean);
  const kv = {};
  let i = 0;
  for (; i < words.length; i++) {
    const match = words[i].match(KEY_VALUE_RE);
    if (match) {
      const [, key, value] = match;
      kv[key.toLowerCase()] = value;
      continue;
    }
    const word = words[i].toLowerCase();
    if (extraBare.has(word)) {
      kv[word] = "true";
      continue;
    }
    break;
  }
  const note = words.slice(i).join(" ");
  return { kv, note };
}

/** True if a free-text note contains a token that looks like `key=value`. */
function noteHasKeyValue(note) {
  if (!note) return false;
  return note.split(/\s+/).some((word) => KEY_VALUE_RE.test(word));
}

function parseCastList(body) {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "12" -> {frames: 12}; "0.5s" -> {seconds: 0.5} */
function parsePauseValue(body, lineNumber) {
  const trimmed = body.trim();
  const secondsMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  if (secondsMatch) {
    return { seconds: parseFloat(secondsMatch[1]) };
  }
  const framesMatch = trimmed.match(/^(\d+)$/);
  if (framesMatch) {
    return { frames: parseInt(framesMatch[1], 10) };
  }
  throw new ScriptError(lineNumber, `Invalid [Pause: ${body}] -- expected a frame count ("12") or seconds ("0.5s").`);
}

/**
 * Optional explicit start for timed tags and dialogue: "2s" / "0.5s" /
 * "48" (frames). Zero is allowed (scene start). Used by at_time= / start=.
 */
function parseAtTimeSpec(value, lineNumber, label = "at_time") {
  if (value === undefined || value === "") {
    throw new ScriptError(lineNumber, `${label} is required (e.g. "2s" or "48").`);
  }
  const trimmed = String(value).trim();
  const secondsMatch = trimmed.match(/^(\d+(?:\.\d+)?)s$/i);
  if (secondsMatch) {
    const seconds = parseFloat(secondsMatch[1]);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ScriptError(lineNumber, `Invalid ${label} "${value}" -- must be 0 or greater.`);
    }
    return { seconds };
  }
  const framesMatch = trimmed.match(/^(\d+)$/);
  if (framesMatch) {
    return { frames: parseInt(framesMatch[1], 10) };
  }
  throw new ScriptError(
    lineNumber,
    `Invalid ${label} "${value}" -- expected seconds like "2s" or a frame count like "48".`
  );
}

/** "1s" / "0.5s" -> seconds. Used by [Move]/[Pose]/[Swing] duration fields. */
function parseSecondsSpec(value, lineNumber, label) {
  if (value === undefined || value === "") {
    throw new ScriptError(lineNumber, `${label} is required (e.g. "1s" or "0.5s").`);
  }
  const trimmed = String(value).trim();
  const match = trimmed.match(SECONDS_RE);
  if (!match) {
    throw new ScriptError(lineNumber, `Invalid ${label} "${value}" -- expected seconds like "1s" or "0.5s".`);
  }
  const seconds = parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ScriptError(lineNumber, `Invalid ${label} "${value}" -- must be greater than 0.`);
  }
  return seconds;
}

function parseViewValue(value, lineNumber) {
  if (value === undefined || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (!HEAD_VIEWS.includes(v)) {
    throw new ScriptError(
      lineNumber,
      `Invalid view "${value}". Expected: ${HEAD_VIEWS.join(", ")}.`
    );
  }
  return v;
}

function parseEaseValue(value, lineNumber) {
  if (value === undefined) return "linear";
  const v = String(value).toLowerCase();
  if (v !== "linear" && v !== "inout") {
    throw new ScriptError(lineNumber, `Invalid ease "${value}" -- expected "linear" or "inout".`);
  }
  return v;
}

function parseWaitValue(value, lineNumber) {
  if (value === undefined) return true;
  const v = String(value).toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ScriptError(lineNumber, `Invalid wait "${value}" -- expected true or false.`);
}

function parseNumberValue(value, lineNumber, label) {
  const trimmed = String(value).trim();
  if (!NUMBER_RE.test(trimmed)) {
    throw new ScriptError(lineNumber, `Invalid ${label} "${value}" -- expected a number.`);
  }
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n)) {
    throw new ScriptError(lineNumber, `Invalid ${label} "${value}" -- expected a number.`);
  }
  return n;
}

/** "400,1080" -> {x,y}; anything else -> null (caller treats it as a mark name). */
function parseXyPair(value) {
  const match = String(value).trim().match(XY_RE);
  if (!match) return null;
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
}

module.exports = {
  parseActionTag,
  parseKvTag,
  noteHasKeyValue,
  parseCastList,
  parsePauseValue,
  parseAtTimeSpec,
  parseViewValue,
  parseSecondsSpec,
  HEAD_VIEWS,
  parseEaseValue,
  parseWaitValue,
  parseNumberValue,
  parseXyPair,
  KEY_VALUE_RE,
};
