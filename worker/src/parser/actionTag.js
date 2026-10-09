"use strict";

/**
 * Parses an `[Action: Name key=value key=value free text note]` tag body.
 *
 * Grammar: the first word is the character name. Then zero or more
 * `key=value` tokens (no spaces inside a value) are consumed greedily.
 * The first token that does *not* match `key=value` ends the key/value
 * section; everything from there to the end of the line is kept verbatim
 * as a free-text `note` -- never an error, per the brief ("Free-text after
 * the key=value pairs is kept as a note/comment, not an error").
 */

const KEY_VALUE_RE = /^([A-Za-z_][\w]*)=(\S+)$/;

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
  const { ScriptError } = require("./errors");
  throw new ScriptError(lineNumber, `Invalid [Pause: ${body}] -- expected a frame count ("12") or seconds ("0.5s").`);
}

module.exports = { parseActionTag, parseCastList, parsePauseValue, KEY_VALUE_RE };
