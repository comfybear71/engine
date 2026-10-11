"use strict";

/**
 * Turn schema / compositor errors into a short lint-style sentence.
 * Raw jsonschema paths are not useful in Studio.
 */

function explainTimelineError(message) {
  const raw = String(message || "").trim();
  if (!raw) return "The timeline is invalid. Open Script and press Lint.";

  const slots = [];
  const seen = new Set();
  const re = /slots\/([^/\s]+)\/keyframes\/\d+/g;
  let match;
  while ((match = re.exec(raw))) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    slots.push(name);
  }

  const emptyFrame = /\{\s*['"]frame['"]\s*:\s*\d+\s*\}/.test(raw) && /not valid under any of the given schemas/i.test(raw);
  if (emptyFrame || (slots.length && /not valid under any of the given schemas/i.test(raw))) {
    const names = slots.length ? slots.join(", ") : "a slot";
    const sample = slots[0] || "right_hand";
    return (
      `Slot ${names} has a keyframe with no drawing or cycle. ` +
      `Set a default_drawing on the character, add [Action: Name ${sample}=<drawing>] on that script line, ` +
      `or use ${sample}=none to hide the slot.`
    );
  }

  if (/Python compositor exited/i.test(raw) || /failed schema validation/i.test(raw)) {
    const cleaned = raw
      .replace(/^Python compositor exited with code \d+:\s*/i, "")
      .replace(/^timeline\.json failed schema validation:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !/not valid under any of the given schemas/i.test(cleaned)) {
      return cleaned.length > 280 ? `${cleaned.slice(0, 277)}…` : cleaned;
    }
    return "The timeline is invalid. Open Script and press Lint for the line that needs a drawing or cycle.";
  }

  return raw;
}

module.exports = { explainTimelineError };
