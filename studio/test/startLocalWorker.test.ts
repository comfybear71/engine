import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENGINE_NOT_ON_THIS_COMPUTER,
  ENGINE_START_FAILED,
  isHostedStudio,
  resolveWorkerDir,
  workerHealthUrl,
} from "../lib/startLocalWorker.ts";

describe("startLocalWorker", () => {
  test("resolves the worker folder from studio/ or the repo root", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fromStudio = resolveWorkerDir(path.join(here, ".."));
    const fromRoot = resolveWorkerDir(path.join(here, "..", ".."));
    assert.ok(fromStudio && fromStudio.endsWith("worker"));
    assert.ok(fromRoot && fromRoot.endsWith("worker"));
  });

  test("health URL is loopback, and copy never mentions a shell command", () => {
    assert.equal(workerHealthUrl(4100), "http://127.0.0.1:4100/health");
    assert.equal(isHostedStudio(), false);
    assert.match(ENGINE_START_FAILED, /desktop shortcut/);
    assert.doesNotMatch(ENGINE_START_FAILED, /npm|cd worker|terminal/i);
    assert.doesNotMatch(ENGINE_NOT_ON_THIS_COMPUTER, /npm|cd worker/i);
  });
});
