"use strict";

/**
 * Parses an `[Action: Name key=value key=value free text note]` tag body
 * (same key=value grammar is reused for [Move]/[Pose]/[Swing]).
 *
 * Grammar: the first word is the character name. Then zero or more
 * `key=value` tokens (no spaces inside a value) are consumed greedily.
 * The first token that does *not* match `key=value` ends the key/value
 * section; everything from there to the end of the line is kept verbatim
 * as a free-text `note` -- never an error, per the brief ("Free-text after
 * the key=value pairs is kept as a note/comment, not an error").
 */

const { ScriptError } = require("./errors");

const KEY_VALUE_RE = /^([A-Za-z_][\w]*)=(\S+)$/;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;
const XY_RE = /^([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)$/;
const SECONDS_RE = /^(\d+(?:\.\d+)?)s$/i;

function parseActionTag(body) {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { character: null, kv: {}, note: "" };
  }

  const character = words[0];
  const kv = {};
  let noteStartIdx = words.length;

  for (let i = 1; i < words.length; i++) {
    const match = words[i].match(KEY_VALUE_RE);
    if (!match) {
      noteStartIdx = i;
      break;
    }
    const [, key, value] = match;
    kv[key.toLowerCase()] = value;
  }

  // A bare "flip" flag (no "=") is also allowed, per the brief.
  if (noteStartIdx < words.length && words[noteStartIdx].toLowerCase() === "flip") {
    kv.flip = "true";
    noteStartIdx += 1;
  }

  const note = words.slice(noteStartIdx).join(" ");
  return { character, kv, note };
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
  parseCastList,
  parsePauseValue,
  parseSecondsSpec,
  parseEaseValue,
  parseWaitValue,
  parseNumberValue,
  parseXyPair,
  KEY_VALUE_RE,
};
