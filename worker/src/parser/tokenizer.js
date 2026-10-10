"use strict";

/**
 * Lexical pass over script.txt: strips comments/decoration and classifies
 * each remaining line by *kind*, carrying its original 1-based line number
 * through so every later error can cite it. Does not interpret tag bodies
 * (e.g. it doesn't parse "Hicks at=left" into key/value pairs) -- that's
 * scriptParser.js's job. Keeping this pass dumb makes each stage
 * independently testable.
 */

const { ScriptError } = require("./errors");

const BRACKET_TAG_RE = /^\[\s*([A-Za-z]+)\s*:\s*(.*?)\s*\]$/;
const DECORATIVE_RE = /^=+$/;
const DIALOGUE_RE = /^([A-Za-z][\w' -]*?)\s*:\s*(.+)$/;

function stripComment(line) {
  // Earliest of "#" or "//" starts a trailing comment. A line that is
  // *entirely* a comment becomes an empty string and is dropped below.
  const hashIdx = line.indexOf("#");
  const slashIdx = line.indexOf("//");
  let cut = -1;
  if (hashIdx !== -1 && slashIdx !== -1) cut = Math.min(hashIdx, slashIdx);
  else if (hashIdx !== -1) cut = hashIdx;
  else if (slashIdx !== -1) cut = slashIdx;
  return cut === -1 ? line : line.slice(0, cut);
}

/**
 * @param {string} scriptText Raw script.txt contents.
 * @returns {Array<{lineNumber: number, kind: string, tag?: string, body?: string, character?: string, text?: string, raw: string}>}
 */
function tokenize(scriptText) {
  const tokens = [];
  const rawLines = scriptText.split(/\r\n|\r|\n/);

  rawLines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    const withoutComment = stripComment(rawLine);
    const trimmed = withoutComment.trim();

    if (trimmed === "") return; // blank or fully-commented line

    if (DECORATIVE_RE.test(trimmed)) {
      tokens.push({ lineNumber, kind: "decorative", raw: rawLine });
      return;
    }

    const bracketMatch = trimmed.match(BRACKET_TAG_RE);
    if (bracketMatch) {
      const tag = bracketMatch[1].toLowerCase();
      const body = bracketMatch[2];
      const knownTags = [
        "scene",
        "location",
        "cast",
        "action",
        "prop",
        "layer",
        "pause",
        "move",
        "pose",
        "swing",
        "camera",
        "audio",
      ];
      if (!knownTags.includes(tag)) {
        throw new ScriptError(
          lineNumber,
          `Unknown tag "[${bracketMatch[1]}: ...]". Known tags: ${knownTags.map((t) => `[${t.charAt(0).toUpperCase() + t.slice(1)}: ...]`).join(", ")}.`
        );
      }
      tokens.push({ lineNumber, kind: tag, body, raw: rawLine });
      return;
    }

    if (trimmed.startsWith("[")) {
      throw new ScriptError(lineNumber, `Malformed tag (missing closing "]"?): ${trimmed}`);
    }

    const dialogueMatch = trimmed.match(DIALOGUE_RE);
    if (dialogueMatch) {
      tokens.push({
        lineNumber,
        kind: "dialogue",
        character: dialogueMatch[1].trim(),
        text: dialogueMatch[2].trim(),
        raw: rawLine,
      });
      return;
    }

    throw new ScriptError(
      lineNumber,
      `Unrecognized line (expected a "[Tag: ...]" line or "Character: dialogue"): ${trimmed}`
    );
  });

  return tokens;
}

module.exports = { tokenize };
