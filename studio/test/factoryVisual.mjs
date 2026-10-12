/**
 * Headless 1920x1080 screenshots of the factory Assets page against a
 * rodney_test-shaped fixture. Run after worker + Studio are up:
 *   node studio/test/factoryVisual.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildRodneyTestProject } = require(path.join(repoRoot, "worker/test/helpers/rodneyTestProject.js"));

const OUT_DIR = process.env.FACTORY_VISUAL_OUT || "/opt/cursor/artifacts/screenshots";
const STUDIO_URL = process.env.STUDIO_URL || "http://127.0.0.1:3001";
const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:4100";
const PROJECT = "rodney_test";

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const projectDir = path.join(repoRoot, "projects", PROJECT);
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  buildRodneyTestProject(projectDir);

  const { chromium } = await import("playwright");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${STUDIO_URL}/p/${PROJECT}?tab=assets`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector('[data-testid="assets-factory"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="assets-row-Eyes"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const summary = path.join(OUT_DIR, "factory-front-summary.png");
  await page.screenshot({ path: summary, fullPage: false });

  const surprised = page.locator('[data-testid="assets-piece-eyes_front/surprised"]');
  await surprised.click();
  await page.waitForSelector('[data-testid="assets-inspector-bounds"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  const inspector = path.join(OUT_DIR, "factory-front-inspector.png");
  await page.screenshot({ path: inspector, fullPage: false });

  await page.locator('[data-testid="assets-view-back"]').click();
  await page.waitForSelector('[data-testid="assets-row-Head"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  const back = path.join(OUT_DIR, "factory-back.png");
  await page.screenshot({ path: back, fullPage: false });

  const labels = await page.locator(".studio-factory-row-title").allTextContents();
  const pills = await page.locator('[data-testid="assets-status-pills"]').innerText();
  const tabs = await page.locator('[data-testid="assets-view-tabs"]').innerText();
  const summaryVisible = await page.locator('[data-testid="assets-character-summary"]').count();
  await browser.close();

  const note = {
    studio: STUDIO_URL,
    worker: WORKER_URL,
    project: PROJECT,
    files: { summary, inspector, back },
    rowLabels: labels.map((item) => item.trim()).filter(Boolean),
    pills,
    tabs,
    inspectorIsSummaryWhenNothingSelected: summaryVisible === 0,
    torsoRows: labels.filter((item) => item.trim() === "Torso").length,
  };
  fs.writeFileSync(path.join(OUT_DIR, "factory-visual.json"), `${JSON.stringify(note, null, 2)}\n`);
  console.log(JSON.stringify(note, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
