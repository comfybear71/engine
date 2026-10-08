#!/usr/bin/env node
"use strict";

/**
 * Minimal CLI: render a project once, or watch it for changes.
 *
 *   node src/cli.js <projectDir> [--codec h264|prores4444] [--output PATH]
 *   node src/cli.js <projectDir> --watch
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });

const { renderProject } = require("./render");
const { watchProject } = require("./watcher");

function parseArgs(argv) {
  const args = { projectDir: null, codec: undefined, output: undefined, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--codec") {
      args.codec = argv[++i];
    } else if (arg === "--output") {
      args.output = argv[++i];
    } else if (arg === "--watch") {
      args.watch = true;
    } else if (!args.projectDir) {
      args.projectDir = arg;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.projectDir) {
    console.error("Usage: node src/cli.js <projectDir> [--codec h264|prores4444] [--output PATH] [--watch]");
    process.exit(2);
  }

  if (args.watch) {
    watchProject(args.projectDir, { codec: args.codec, output: args.output });
    return; // keep process alive; chokidar holds the event loop open
  }

  try {
    await renderProject(args.projectDir, { codec: args.codec, output: args.output });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
