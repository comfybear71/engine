"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  planWindows,
  planTalkingHead,
  buildWindowPrompt,
  extractFrameAt,
  makeTalkingHead,
  resumeTalkingHead,
  markInterruptedTalkShots,
} = require("../src/talkingHead");
const { listShots } = require("../src/shots");

function speech(durationSec, { pauseEvery = 3.2, pauseLen = 0.5 } = {}) {
  const words = [];
  let t = 0;
  let n = 0;
  while (t < durationSec - 0.4) {
    words.push({ word: `w${n++}`, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.3) * 1000) / 1000 });
    t += 0.4;
    if (n % Math.round(pauseEvery / 0.4) === 0) t += pauseLen;
  }
  return words;
}

describe("planWindows", () => {
  test("keeps dialogue of 10 s or less as one window", () => {
    const windows = planWindows(speech(8), 8);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].clipSec, 8);
    assert.equal(windows[0].start, 0);
    assert.equal(windows[0].end, 8);
  });

  test("rounds a 5 s window up to a 6 s Grok clip", () => {
    const [win] = planWindows(speech(5), 5);
    assert.equal(win.clipSec, 6);
  });

  test("splits 33 s into balanced windows of 10 s or less cut on pauses", () => {
    const words = speech(33);
    const windows = planWindows(words, 33);
    assert.ok(windows.length >= 4 && windows.length <= 5);
    for (const win of windows) {
      assert.ok(win.duration <= 10.01, `window ${win.index} is ${win.duration}s`);
      assert.ok(win.duration >= 3, `window ${win.index} is too short: ${win.duration}s`);
    }
    for (let i = 1; i < windows.length; i++) assert.equal(windows[i].start, windows[i - 1].end);
    assert.equal(windows[windows.length - 1].end, 33);
    for (const win of windows.slice(0, -1)) {
      const inside = words.some((w) => w.start < win.end - 0.01 && w.end > win.end + 0.01);
      assert.equal(inside, false, `cut at ${win.end}s lands inside a word`);
    }
  });

  test("every word lands in exactly one window", () => {
    const words = speech(34);
    const windows = planWindows(words, 34);
    const joined = windows.map((w) => w.text).join(" ").split(" ").filter(Boolean);
    assert.deepEqual(joined, words.map((w) => w.word));
  });

  test("still splits at 10 s when there are no pauses to cut on", () => {
    const words = [];
    for (let i = 0; i < 80; i++) words.push({ word: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.4 });
    const windows = planWindows(words, 32);
    assert.ok(windows.length >= 4);
    assert.ok(windows.every((w) => w.duration <= 10.01));
  });

  test("returns nothing for empty audio", () => {
    assert.deepEqual(planWindows([], 0), []);
  });
});

describe("buildWindowPrompt", () => {
  test("includes the words, the head-only framing and continuity for later windows", () => {
    const first = buildWindowPrompt({ basePrompt: "calm", text: "hello there", index: 0 });
    assert.match(first, /"hello there"/);
    assert.match(first, /head only from jawline up/);
    assert.doesNotMatch(first, /continuing/);
    const later = buildWindowPrompt({ basePrompt: "calm", text: "more", index: 2 });
    assert.match(later, /continuing the same performance/);
  });
});

describe("extractFrameAt", () => {
  const { spawnSync } = require("child_process");
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

  test("grabs the frame at the window end, falling back to the last frame past the end", { skip: !hasFfmpeg }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frameat-"));
    try {
      const video = path.join(dir, "clip.mp4");
      const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=160x120:rate=24", video]);
      assert.equal(made.status, 0);
      const atWindow = await extractFrameAt(video, path.join(dir, "a.png"), 2.5);
      assert.ok(fs.statSync(atWindow).size > 100);
      const pastEnd = await extractFrameAt(video, path.join(dir, "b.png"), 9);
      assert.ok(fs.statSync(pastEnd).size > 100);
      assert.notDeepEqual(fs.readFileSync(atWindow), fs.readFileSync(pastEnd));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("talking head chain", () => {
  let projectDir;
  let requests;
  let frameCalls;
  const savedKey = process.env.XAI_API_KEY;

  function writeAudio(durationSec) {
    const dir = path.join(projectDir, "audio", "take_one");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "001_rodney.wav"), Buffer.from("RIFF"));
    fs.writeFileSync(path.join(dir, "001_rodney.words.json"), JSON.stringify(speech(durationSec)));
  }

  function makeFetch({ failOn = null } = {}) {
    let n = 0;
    return async (url, init = {}) => {
      if (String(url).endsWith("/videos/generations")) {
        const body = JSON.parse(init.body);
        n += 1;
        requests.push({ n, body });
        if (failOn === n) return { ok: false, status: 500, text: async () => "boom" };
        return { ok: true, json: async () => ({ request_id: `req${n}` }) };
      }
      if (/\/v1\/videos\/req\d+$/.test(String(url))) {
        const id = String(url).split("/").pop();
        return { ok: true, json: async () => ({ status: "done", video: { url: `https://cdn.test/${id}.mp4` } }) };
      }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("mp4-bytes").buffer };
    };
  }

  function chainOptions(extra = {}) {
    return {
      fetchFn: makeFetch(extra),
      pollIntervalMs: 1,
      captureFn: async (_video, _dir, meta) => ({ fps: 24, frameCount: 24 * 10, meta }),
      extractFrame: async (_video, out, seconds) => {
        frameCalls.push(seconds);
        fs.writeFileSync(out, Buffer.from(`frame-at-${seconds}`));
        return out;
      },
      extractWavSlice: async (_src, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from("wav"));
      },
    };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "talkhead-"));
    requests = [];
    frameCalls = [];
    process.env.XAI_API_KEY = "test-key";
    fs.mkdirSync(path.join(projectDir, "characters", "rodney"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "characters", "rodney", "front_head.jpg"), Buffer.from("REFERENCE"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedKey;
  });

  test("planTalkingHead reads the trimmed range of words", () => {
    writeAudio(40);
    const plan = planTalkingHead(projectDir, { audioRel: "audio/take_one/001_rodney.wav", inSec: 10, durationSec: 20 });
    assert.equal(plan.characterId, "rodney");
    assert.equal(plan.hasWords, true);
    assert.ok(plan.windows.length >= 2);
    assert.ok(plan.windows.every((w) => w.duration <= 10.01));
    assert.equal(plan.windows[plan.windows.length - 1].end, 20);
  });

  test("chains windows: first from the reference, then from the previous clip's frame", async () => {
    writeAudio(24);
    const started = await makeTalkingHead(
      projectDir,
      "rodney",
      { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 24, prompt: "calm", refRel: "characters/rodney/front_head.jpg" },
      chainOptions()
    );
    assert.equal(started.shotIds.length, started.windows.length);
    assert.ok(started.shotIds.length >= 3);
    await started.completion;

    assert.equal(requests.length, started.windows.length);
    assert.equal(
      requests[0].body.image.url,
      `data:image/png;base64,${Buffer.from("REFERENCE").toString("base64")}`
    );
    for (let i = 1; i < requests.length; i++) {
      const prevWindow = started.windows[i - 1];
      assert.ok(requests[i].body.image.url.includes(Buffer.from(`frame-at-${prevWindow.duration}`).toString("base64")));
    }
    assert.deepEqual(frameCalls, started.windows.slice(0, -1).map((w) => w.duration));
    for (let i = 0; i < requests.length; i++) {
      assert.equal(requests[i].body.duration, started.windows[i].clipSec);
      assert.match(requests[i].body.prompt, new RegExp(started.windows[i].text.split(" ")[0]));
    }

    const shots = listShots(projectDir, "rodney").sort((a, b) => a.talk.index - b.talk.index);
    assert.equal(shots.length, started.windows.length);
    shots.forEach((shot, i) => {
      assert.equal(shot.status, "ready");
      assert.equal(shot.shotType, "head");
      assert.equal(shot.in, 1);
      assert.equal(shot.out, Math.round(started.windows[i].duration * 24));
      assert.equal(shot.talk.audio, "audio.wav");
      assert.ok(fs.existsSync(path.join(projectDir, "characters", "rodney", "shots", shot.id, "audio.wav")));
    });
  });

  test("a short line is a single clip with no chaining", async () => {
    writeAudio(7);
    const started = await makeTalkingHead(
      projectDir,
      "rodney",
      { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 7, refRel: "characters/rodney/front_head.jpg" },
      chainOptions()
    );
    await started.completion;
    assert.equal(started.shotIds.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(frameCalls.length, 0);
  });

  test("a failed window stops the chain and resume continues from it", async () => {
    writeAudio(24);
    const started = await makeTalkingHead(
      projectDir,
      "rodney",
      { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 24, refRel: "characters/rodney/front_head.jpg" },
      chainOptions({ failOn: 2 })
    );
    await started.completion;
    let shots = listShots(projectDir, "rodney").sort((a, b) => a.talk.index - b.talk.index);
    assert.equal(shots[0].status, "ready");
    assert.equal(shots[1].status, "error");
    assert.match(shots[1].error, /boom/);
    assert.equal(shots[2].status, "queued");
    assert.equal(requests.length, 2);

    const resumed = await resumeTalkingHead(projectDir, "rodney", started.group, chainOptions());
    assert.equal(resumed.fromWindow, 2);
    await resumed.completion;
    shots = listShots(projectDir, "rodney").sort((a, b) => a.talk.index - b.talk.index);
    assert.ok(shots.every((s) => s.status === "ready"));
  });

  test("a chain left unfinished with nothing running is reported as failed so it can be retried", async () => {
    writeAudio(24);
    const started = await makeTalkingHead(
      projectDir,
      "rodney",
      { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 24, refRel: "characters/rodney/front_head.jpg" },
      chainOptions()
    );
    await started.completion;
    const shots = listShots(projectDir, "rodney").sort((a, b) => a.talk.index - b.talk.index);
    shots[1].status = "making";
    shots[2].status = "queued";
    const reported = markInterruptedTalkShots("rodney", shots);
    assert.equal(reported[0].status, "ready");
    assert.equal(reported[1].status, "error");
    assert.match(reported[1].error, /Interrupted/);
    assert.equal(reported[2].status, "queued");
  });

  test("refuses audio with no transcript", async () => {
    const dir = path.join(projectDir, "audio", "take_one");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "001_rodney.wav"), Buffer.from("RIFF"));
    await assert.rejects(
      makeTalkingHead(
        projectDir,
        "rodney",
        { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 12, refRel: "characters/rodney/front_head.jpg" },
        chainOptions()
      ),
      /No transcript/
    );
  });

  test("refuses when the character has no reference head", async () => {
    writeAudio(8);
    await assert.rejects(
      makeTalkingHead(projectDir, "rodney", { audioRel: "audio/take_one/001_rodney.wav", inSec: 0, durationSec: 8, refRel: "characters/rodney/missing.jpg" }, chainOptions()),
      /reference/
    );
  });
});
