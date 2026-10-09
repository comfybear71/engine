#!/usr/bin/env node
"use strict";

/**
 * CLI entry point. Subcommands:
 *
 *   node src/cli.js parse  <projectDir> [--script script.txt] [--out timeline.json]
 *   node src/cli.js lint   <projectDir> [--script script.txt]
 *   node src/cli.js render <projectDir> [--codec h264|prores4444] [--output PATH] [--from-script] [--script script.txt]
 *   node src/cli.js watch  <projectDir> [--codec h264|prores4444] [--output PATH] [--from-script] [--script script.txt]
 *
 * `render` parses script.txt first (then renders) when --from-script is
 * given, or automatically when the project has a script.txt but no
 * timeline.json yet. `watch` re-parses (if applicable) and re-renders
 * whenever script.txt or timeline.json changes.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { renderProject } = require("./render");
const { watchProject } = require("./watcher");
const { parseProjectToFiles } = require("./parser");

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function printUsageAndExit() {
  console.error(
    [
      "Usage:",
      "  node src/cli.js parse  <projectDir> [--script script.txt] [--out timeline.json]",
      "  node src/cli.js lint   <projectDir> [--script script.txt]",
      "  node src/cli.js render <projectDir> [--codec h264|prores4444] [--output PATH] [--from-script] [--script script.txt]",
      "  node src/cli.js watch  <projectDir> [--codec h264|prores4444] [--output PATH] [--from-script] [--script script.txt]",
    ].join("\n")
  );
  process.exit(2);
}

async function reportParseResult(result) {
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  console.log(`Parsed -> ${result.timelinePath}`);
  console.log(`Lines manifest -> ${result.linesPath} (${result.lines.length} line(s))`);
  const missing = result.lines.filter((l) => l.status === "missing");
  if (missing.length > 0) {
    console.log(`  ${missing.length} line(s) have no audio yet (estimated duration used) -- see lines.json.`);
  }
  if (result.validation.ok) {
    console.log(`Schema/load validation: ${result.validation.message}`);
  } else {
    console.error(`Schema/load validation FAILED:\n${result.validation.message}`);
  }
  return result.validation.ok;
}

async function cmdParse(flags) {
  const projectDir = flags._[0];
  if (!projectDir) printUsageAndExit();
  const result = await parseProjectToFiles(projectDir, { script: flags.script, out: flags.out });
  const ok = await reportParseResult(result);
  if (!ok) process.exit(1);
}

async function cmdLint(flags) {
  const projectDir = flags._[0];
  if (!projectDir) printUsageAndExit();
  // lint == parse to a throwaway file + validate, without disturbing any
  // committed timeline.json/lines.json in the project.
  const tmpOut = ".lint-timeline.json";
  try {
    const result = await parseProjectToFiles(projectDir, { script: flags.script, out: tmpOut });
    const ok = await reportParseResult(result);
    if (!ok) process.exit(1);
    console.log("Lint OK: no errors.");
  } finally {
    const tmpPath = path.join(projectDir, tmpOut);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    const tmpLines = path.join(projectDir, "lines.json");
    void tmpLines; // lines.json is useful output; left in place intentionally
  }
}

async function cmdRender(flags) {
  const projectDir = flags._[0];
  if (!projectDir) printUsageAndExit();

  const timelinePath = path.join(projectDir, "timeline.json");
  const scriptPath = path.join(projectDir, flags.script || "script.txt");
  const shouldParseFirst = flags["from-script"] || (!fs.existsSync(timelinePath) && fs.existsSync(scriptPath));

  if (shouldParseFirst) {
    const result = await parseProjectToFiles(projectDir, { script: flags.script });
    const ok = await reportParseResult(result);
    if (!ok) process.exit(1);
  }

  try {
    await renderProject(projectDir, { codec: flags.codec, output: flags.output });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function cmdWatch(flags) {
  const projectDir = flags._[0];
  if (!projectDir) printUsageAndExit();
  watchProject(projectDir, {
    codec: flags.codec,
    output: flags.output,
    fromScript: !!flags["from-script"],
    script: flags.script,
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "parse":
      return cmdParse(flags);
    case "lint":
      return cmdLint(flags);
    case "render":
      return cmdRender(flags);
    case "watch":
      return cmdWatch(flags);
    default:
      printUsageAndExit();
  }
}

main();
