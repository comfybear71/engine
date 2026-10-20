"use strict";

/**
 * Test 3: send one Blender room render to Grok image edit and save the
 * restyled picture. Reads XAI_API_KEY from the engine .env (same as the
 * worker, .env wins over any Windows user variable). The key is only sent
 * as an Authorization header and is never printed.
 *
 *   node tools/grok/restyle_room.js --check            free: key name and status
 *   node tools/grok/restyle_room.js <input.png>         one edit, about $0.07
 *   options: --out <file.png>  --prompt "<text>"  --day
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const repoRoot = path.resolve(__dirname, "..", "..");
const { loadDotenv } = require(path.join(repoRoot, "worker", "src", "engineSettings.js"));

const MODEL = "grok-imagine-image-2.0";
const EDITS_URL = "https://api.x.ai/v1/images/edits";
const KEY_INFO_URL = "https://api.x.ai/v1/api-key";

const BASE_PROMPT =
  "Restyle this exact room as a richly painted, polished animated-film background. " +
  "Keep the layout, camera angle and every object in exactly the same place: striped back wall, " +
  "two windows, clock, sofa with two cushions, two table lamps, two wall lamps, coffee table, rug. " +
  "Add soft painterly texture, fabric and wood detail. No people, no text, no outlines. ";
const LIGHT_EVENING = "Keep the warm glowing lamp light.";
const LIGHT_DAY = "Keep the bright sunny daylight.";

function parseArgs(argv) {
  const args = { input: null, out: null, prompt: null, check: false, day: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--day") args.day = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (!a.startsWith("--")) args.input = a;
  }
  return args;
}

function keyFingerprint(key) {
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `length ${key.length}, fingerprint ${hash}`;
}

async function checkKey(key) {
  const res = await fetch(KEY_INFO_URL, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) {
    console.log(`Key check failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return false;
  }
  const j = JSON.parse(text);
  console.log(`Key name:        ${j.name}`);
  console.log(`Key ends with:   ${String(j.redacted_api_key || "").slice(-4)}`);
  console.log(`Key blocked:     ${j.api_key_blocked}`);
  console.log(`Team blocked:    ${j.team_blocked}  (true means out of credits or over the spending limit)`);
  return !j.api_key_blocked && !j.team_blocked;
}

async function restyle(key, args) {
  const input = path.resolve(args.input);
  if (!fs.existsSync(input)) {
    console.log(`Input picture not found: ${input}`);
    console.log("Run the glow room first: blender -b -P tools\\blender\\glow_room.py -- --out renders\\glow --mood evening");
    process.exit(1);
  }
  const prompt = args.prompt || BASE_PROMPT + (args.day ? LIGHT_DAY : LIGHT_EVENING);
  const out =
    path.resolve(args.out || path.join(repoRoot, "renders", "restyle", `${path.basename(input, ".png")}_grok.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`Sending ${input} to ${MODEL} (about $0.07)...`);
  const res = await fetch(EDITS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
      aspect_ratio: "16:9",
      image: { url: `data:image/png;base64,${fs.readFileSync(input).toString("base64")}`, type: "image_url" },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`xAI request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const row = (JSON.parse(text).data || [])[0];
  if (!row) {
    console.log("xAI returned no image.");
    process.exit(1);
  }
  if (row.b64_json) {
    fs.writeFileSync(out, Buffer.from(row.b64_json, "base64"));
  } else {
    const img = await fetch(row.url);
    fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  }
  console.log(`Saved ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotenv();
  const key = (process.env.XAI_API_KEY || "").trim();
  if (!key) {
    console.log("XAI_API_KEY is not set in the engine .env file.");
    process.exit(1);
  }
  console.log(`Using key from engine .env: ${keyFingerprint(key)}`);
  const ok = await checkKey(key);
  if (args.check) process.exit(ok ? 0 : 1);
  if (!ok) {
    console.log("Stopping: this key or its team is blocked, so nothing was sent.");
    process.exit(1);
  }
  if (!args.input) {
    console.log("Give an input picture, for example renders\\glow\\glow_evening.png");
    process.exit(1);
  }
  await restyle(key, args);
}

main().catch((err) => {
  console.log(`Error: ${err.message}`);
  process.exit(1);
});
