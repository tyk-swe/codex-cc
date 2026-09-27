import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import { isProcessRunning, terminateProcessTree, waitForProcessExit } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

function esrch() {
  return Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

function psResult(stdout) {
  return { command: "ps", args: [], status: 0, signal: null, stdout, stderr: "", error: null };
}

test("terminateProcessTree signals a non-leader process that runs the expected command", () => {
  const signals = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    expectedCommand: /codex-companion\.mjs/,
    runCommandImpl: () => psResult("node /plugin/scripts/codex-companion.mjs review --json\n"),
    killImpl(pid, signal) {
      if (pid < 0) {
        throw esrch();
      }
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, [[4321, "SIGTERM"]]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree never signals a recycled pid that runs something else", () => {
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    expectedCommand: /codex-companion\.mjs/,
    runCommandImpl: () => psResult("/usr/sbin/some-daemon --foreground\n"),
    killImpl(pid) {
      if (pid < 0) {
        throw esrch();
      }
      throw new Error("must not signal an unrelated process");
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

function failWith(code) {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

test("isProcessRunning tells live, foreign, missing and unreaped processes apart", () => {
  assert.equal(isProcessRunning(Number.NaN), false);
  assert.equal(isProcessRunning(4321, { killImpl: failWith("ESRCH") }), false);
  assert.equal(isProcessRunning(4321, { killImpl: failWith("EPERM") }), true);
  assert.equal(isProcessRunning(4321, { killImpl: () => true, isZombieImpl: () => false }), true);
  assert.equal(isProcessRunning(4321, { killImpl: () => true, isZombieImpl: () => true }), false);
});

test("waitForProcessExit resolves when the process exits and gives up after the timeout", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore" });
  assert.equal(await waitForProcessExit(child.pid, 10000, { pollMs: 20 }), true);

  const started = Date.now();
  const alive = { killImpl: () => true, isZombieImpl: () => false, pollMs: 20 };
  assert.equal(await waitForProcessExit(4321, 150, alive), false);
  assert.ok(Date.now() - started >= 150);
});

test("waitForProcessExit sees an orphaned process exit even when nothing reaps it", async () => {
  // The launcher exits at once and orphans its detached child. Where init does
  // not reap orphans (some containers), the exited child lingers as a zombie.
  const launcher = spawnSync(
    process.execPath,
    [
      "-e",
      'const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { detached: true, stdio: "ignore" }); child.unref(); console.log(child.pid);'
    ],
    { encoding: "utf8" }
  );
  const pid = Number(launcher.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, launcher.stderr);

  assert.equal(await waitForProcessExit(pid, 10000, { pollMs: 20 }), true);
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
