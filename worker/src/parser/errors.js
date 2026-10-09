"use strict";

/**
 * A parse/validation error that always carries the originating script.txt
 * line number, so every failure the parser or lint command reports can
 * point a human straight at the offending line -- never a bare stack trace.
 */
class ScriptError extends Error {
  constructor(lineNumber, message) {
    super(lineNumber != null ? `Line ${lineNumber}: ${message}` : message);
    this.name = "ScriptError";
    this.lineNumber = lineNumber;
  }
}

module.exports = { ScriptError };
