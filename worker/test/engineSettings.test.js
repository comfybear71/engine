"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadDotenv } = require("../src/engineSettings");

describe("engine .env loading", () => {
  test("XAI_API_KEY from .env wins over a stale process env value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-dotenv-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "XAI_API_KEY=from-dotenv-file\nOTHER_KEEP=file-value\n");
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "stale-user-env-key";
    try {
      loadDotenv({ envPath });
      assert.equal(process.env.XAI_API_KEY, "from-dotenv-file");
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
