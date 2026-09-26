import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

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
