// Live smoke test: drives the plugin's companion CLI against the *real*
// `codex app-server` found on PATH, with a local fake model backend, so it
// needs no network access, account or credits. Run with `npm run test:live`;
// set CODEX_LIVE_REQUIRED=1 to fail (instead of skip) when codex is missing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stripInheritedEnv } from "../helpers.mjs";
import { CANNED_REVIEW_ANSWER, CANNED_TASK_ANSWER, startFakeResponsesServer } from "./fake-responses-server.mjs";
import { listJobs, resolveStateDir } from "../../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
const codexAvailable = codexVersion.status === 0;
const liveRequired = process.env.CODEX_LIVE_REQUIRED === "1";
const skip = codexAvailable ? false : "codex CLI not found on PATH";

const ANSI_ESCAPE = /\u001b\[/;
const PATH_WARNING = /could not (create PATH aliases|update PATH)/;

const context = {
  fake: null,
  home: null,
  repo: null,
  pluginData: null,
  freshPluginData: null,
  claudeSession: null
};

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args) {
  const result = spawnSync("git", args, { cwd: context.repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function liveEnv(pluginData) {
  const env = stripInheritedEnv({ ...process.env });
  env.HOME = context.home;
  env.USERPROFILE = context.home;
  env.CODEX_HOME = path.join(context.home, ".codex");
  env.CLAUDE_PLUGIN_DATA = pluginData;
  return env;
}

// spawnSync would block the event loop that the in-process fake backend
// needs in order to answer Codex.
function runNode(script, args, { env, input = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: context.repo, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(input ?? undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function runCompanion(args, pluginData = context.pluginData, options = {}) {
  return runNode(SCRIPT, args, { ...options, env: liveEnv(pluginData) });
}

function withPluginData(pluginData, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function jobs(pluginData = context.pluginData) {
  return withPluginData(pluginData, () => listJobs(context.repo));
}

function brokerSessionFile(pluginData = context.pluginData) {
  return withPluginData(pluginData, () => path.join(resolveStateDir(context.repo), "broker.json"));
}

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}

function assertCleanOutput(text) {
  assert.doesNotMatch(text, ANSI_ESCAPE);
  assert.doesNotMatch(text, PATH_WARNING);
}

if (!codexAvailable && liveRequired) {
  test("codex CLI is installed for the live smoke test", () => {
    assert.fail(`CODEX_LIVE_REQUIRED=1 but \`codex --version\` failed: ${codexVersion.error?.message ?? codexVersion.stderr}`);
  });
}

before(async () => {
  if (!codexAvailable) {
    return;
  }
  context.fake = await startFakeResponsesServer();
  context.home = makeDir("codex-live-home-");
  const codexHome = path.join(context.home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "plugin-live"',
      "",
      "[model_providers.plugin-live]",
      'name = "Plugin live test"',
      `base_url = "http://127.0.0.1:${context.fake.port}/v1"`,
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
      // Skip the curated plugin sync (a ~100 MB download) and connected apps.
      "[features]",
      "plugins = false",
      "apps = false",
      ""
    ].join("\n")
  );

  context.repo = path.join(context.home, "repo");
  fs.mkdirSync(context.repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Codex Plugin Live Tests"]);
  git(["config", "user.email", "tests@example.com"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(context.repo, "app.mjs"), "export const answer = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(context.repo, "app.mjs"), "export const answer = 2;\n");

  const projectDir = path.join(context.home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  context.claudeSession = path.join(projectDir, "4f1c7a2e-1111-4222-8333-944455556666.jsonl");
  const sessionId = path.basename(context.claudeSession, ".jsonl");
  fs.writeFileSync(
    context.claudeSession,
    [
      {
        parentUuid: null,
        type: "user",
        cwd: context.repo,
        sessionId,
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        timestamp: "2026-09-26T06:00:00.000Z",
        message: { role: "user", content: "What does app.mjs export?" }
      },
      {
        parentUuid: "aaaaaaaa-0000-4000-8000-000000000001",
        type: "assistant",
        cwd: context.repo,
        sessionId,
        uuid: "aaaaaaaa-0000-4000-8000-000000000002",
        timestamp: "2026-09-26T06:00:05.000Z",
        message: { id: "msg_01", type: "message", role: "assistant", content: [{ type: "text", text: "It exports answer." }] }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );

  context.pluginData = makeDir("codex-live-plugin-data-");
  context.freshPluginData = makeDir("codex-live-plugin-data-");
});

after(async () => {
  if (!codexAvailable) {
    return;
  }
  for (const pluginData of [context.pluginData, context.freshPluginData]) {
    await runNode(SESSION_HOOK, ["SessionEnd"], {
      env: liveEnv(pluginData),
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: context.repo })
    });
  }
  await context.fake?.close();
  for (const dir of [context.home, context.pluginData, context.freshPluginData]) {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

let taskThreadId = null;

test("setup reports Codex ready through the configured provider", { skip }, async () => {
  const result = await runCompanion(["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.codex.available, true);
  assert.match(report.codex.detail, /codex-cli \d+\.\d+\.\d+/);
  assert.equal(report.auth.loggedIn, true, report.auth.detail);
  assert.match(report.auth.detail, /Plugin live test/);
});

test("task runs a real Codex turn over the shared broker", { skip }, async () => {
  const result = await runCompanion(["task", "--json", "Say hi."]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 0);
  assert.equal(payload.rawOutput, CANNED_TASK_ANSWER);
  taskThreadId = payload.threadId;
  assert.ok(taskThreadId);
  assert.ok(fs.existsSync(brokerSessionFile()), "commands should share one lazily started broker");
  assert.equal(context.fake.requests.at(-1).sandbox, "read-only");
});

test("task --resume-last --write resumes the same thread with the write sandbox", { skip }, async () => {
  const result = await runCompanion(["task", "--resume-last", "--write", "--json", "Continue."]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, taskThreadId);
  // With the thread still loaded in the broker, Codex ignores resume overrides
  // unless the previous run released the thread.
  assert.equal(context.fake.requests.at(-1).sandbox, "workspace-write");
});

test("task --resume-last finds the thread through Codex when no job is tracked", { skip }, async () => {
  const result = await runCompanion(["task", "--resume-last", "--json", "Once more."], context.freshPluginData);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, taskThreadId);
});

test("review renders the built-in reviewer's verdict", { skip }, async () => {
  const result = await runCompanion(["review"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Codex Review/);
  assert.match(result.stdout, new RegExp(CANNED_REVIEW_ANSWER.replace(/\./g, "\\.")));
  assertCleanOutput(result.stdout);
});

test("adversarial review renders structured output", { skip }, async () => {
  const result = await runCompanion(["adversarial-review"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.equal(context.fake.requests.at(-1).hasSchema, true);
  assertCleanOutput(result.stdout);
});

test("transfer imports the Claude session into a Codex thread", { skip }, async () => {
  const result = await runCompanion(["transfer", "--source", context.claudeSession, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.threadId);
  assert.equal(payload.resumeCommand, `codex resume ${payload.threadId}`);
});

test("cancel interrupts a running background task", { skip }, async () => {
  context.fake.setHang(true);
  try {
    const launched = await runCompanion(["task", "--background", "--json", "Take your time."]);
    assert.equal(launched.status, 0, launched.stderr);
    const { jobId } = JSON.parse(launched.stdout);

    await waitFor(() => {
      const job = jobs().find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.turnId ? job : null;
    });
    const cancel = await runCompanion(["cancel", jobId, "--json"]);

    assert.equal(cancel.status, 0, cancel.stderr);
    const payload = JSON.parse(cancel.stdout);
    assert.equal(payload.turnInterruptAttempted, true);
    assert.equal(payload.turnInterrupted, true);
  } finally {
    context.fake.setHang(false);
  }
});

test("cancel interrupts a running native review and keeps it cancelled", { skip }, async () => {
  context.fake.setHang(true);
  try {
    const review = runCompanion(["review", "--json"]);
    const job = await waitFor(() => {
      const candidate = jobs().find((entry) => entry.kindLabel === "review" && entry.status === "running");
      return candidate?.turnId ? candidate : null;
    });

    const cancel = await runCompanion(["cancel", job.id, "--json"]);

    assert.equal(cancel.status, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).turnInterrupted, true);
    await review;
    assert.equal(jobs().find((entry) => entry.id === job.id)?.status, "cancelled");
  } finally {
    context.fake.setHang(false);
  }
});

test("job logs show no Codex deprecation notices or raw stderr noise", { skip }, () => {
  const logFiles = [...jobs(), ...jobs(context.freshPluginData)].map((job) => job.logFile).filter(Boolean);
  assert.ok(logFiles.length > 0);
  for (const logFile of logFiles) {
    const log = fs.readFileSync(logFile, "utf8");
    assert.doesNotMatch(log, /deprecation notice/i, logFile);
    assertCleanOutput(log);
  }
});
