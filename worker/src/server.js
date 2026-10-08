"use strict";

/**
 * Minimal Express server exposing the render worker over HTTP, for when the
 * future Studio app wants to trigger renders remotely instead of via CLI.
 * Intentionally tiny: one route, no auth, no queue -- add those when the
 * Studio actually needs them.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });

const express = require("express");

const { renderProject } = require("./render");

const app = express();
app.use(express.json());

const PORT = process.env.WORKER_PORT || 4100;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  const { projectDir, codec, output } = req.body || {};
  if (!projectDir) {
    return res.status(400).json({ error: "projectDir is required" });
  }
  try {
    await renderProject(projectDir, { codec, output });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Render worker listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
