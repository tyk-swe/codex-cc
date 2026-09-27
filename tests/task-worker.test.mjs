import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { isProcessRunning } from "../plugins/codex/scripts/lib/process.mjs";
import { launchTaskWorker, waitForTaskWorkerStart } from "../plugins/codex/scripts/lib/task-worker.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const SCRIPT_URL = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
const SCRIPT = fileURLToPath(SCRIPT_URL);
const WORKER_URL = new URL("../plugins/codex/scripts/lib/task-worker.mjs", import.meta.url);

function makeWorkspace(t) {
  const workspace = makeTempDir();
  t.after(() => {
    fs.rmSync(resolveStateDir(workspace), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function workerFixture(t) {
  const workspace = makeTempDir();
  const readyFile = path.join(workspace, "ready");
  const recordFile = path.join(workspace, "record.json");
  const fixture = { workspace, readyFile, recordFile, child: null, closed: null };
  fixture.spawnImpl = (command, _args, options) => {
    const source = `
      import fs from "node:fs";
      import { waitForTaskWorkerStart } from ${JSON.stringify(WORKER_URL.href)};
      fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
      if (await waitForTaskWorkerStart()) {
        const record = JSON.parse(fs.readFileSync(${JSON.stringify(recordFile)}, "utf8"));
        if (record.pid !== process.pid) throw new Error("Worker PID was not saved before startup");
        fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ ...record, status: "completed" }));
      }
    `;
    fixture.child = spawn(command, ["--input-type=module", "-e", source], options);
    fixture.closed = new Promise((resolve) => fixture.child.once("close", resolve));
    return fixture.child;
  };
  t.after(async () => {
    if (fixture.child?.exitCode === null && fixture.child?.signalCode === null) {
      fixture.child.kill("SIGKILL");
    }
    await fixture.closed;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return fixture;
}

test("a worker waits for publication and an immediate completion is not overwritten", async (t) => {
  const fixture = workerFixture(t);
  await launchTaskWorker(fixture.workspace, "task-early", async (pid) => {
    // Force the worker to reach its gate before either record exists.
    await waitForFile(fixture.readyFile);
    assert.equal(fs.existsSync(fixture.recordFile), false);
    assert.equal(isProcessRunning(pid), true);
    fs.writeFileSync(fixture.recordFile, JSON.stringify({ status: "queued", pid }));
  }, { spawnImpl: fixture.spawnImpl });
  assert.equal(await fixture.closed, 0);
  assert.equal(JSON.parse(fs.readFileSync(fixture.recordFile, "utf8")).status, "completed");
});

test("a publication failure stops the waiting worker and preserves the original error", async (t) => {
  const fixture = workerFixture(t);
  const error = new Error("State store is unavailable");
  await assert.rejects(launchTaskWorker(fixture.workspace, "task-unpublished", async () => {
    await waitForFile(fixture.readyFile);
    throw error;
  }, { spawnImpl: fixture.spawnImpl }), (actual) => actual === error);
  assert.equal(isProcessRunning(fixture.child.pid), false);
  assert.equal(fs.existsSync(fixture.recordFile), false);
});

test("a spawn failure never publishes a queued job", async (t) => {
  const workspace = makeWorkspace(t);
  let published = false;
  await assert.rejects(launchTaskWorker(path.join(workspace, "missing"), "task-missing", () => {
    published = true;
  }), { code: "ENOENT" });
  assert.equal(published, false);
});

test("a broken startup pipe stops the worker instead of leaking it", async (t) => {
  const fixture = workerFixture(t);
  const error = Object.assign(new Error("Startup pipe closed"), { code: "EPIPE" });
  await assert.rejects(launchTaskWorker(fixture.workspace, "task-broken-pipe", async () => {
    await waitForFile(fixture.readyFile);
    fixture.child.stdin.end = (_token, callback) => {
      queueMicrotask(() => {
        callback(error);
        fixture.child.stdin.emit("error", error);
      });
    };
  }, { spawnImpl: fixture.spawnImpl }), (actual) => actual === error);
  assert.equal(isProcessRunning(fixture.child.pid), false);
});

test("the startup gate requires a complete token followed by EOF", async () => {
  for (const [chunks, expected] of [[[], false], [["sta"], false], [["wrong\n"], false], [["start\nextra"], false], [["st", "art\n"], true]]) {
    assert.equal(await waitForTaskWorkerStart(Readable.from(chunks)), expected);
  }
});

function storeQueuedJob(workspace, status = "queued") {
  const job = {
    id: "task-gated",
    workspaceRoot: workspace,
    title: "Codex Task",
    status,
    phase: status,
    pid: null,
    request: { cwd: workspace, prompt: "Do not run before startup is allowed" }
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  return job;
}

test("a worker whose launcher closes stdin without permission records a failed job", (t) => {
  const workspace = makeWorkspace(t);
  const job = storeQueuedJob(workspace);
  const result = run(process.execPath, [SCRIPT, "task-worker", "--job-id", job.id, "--wait-for-start"], {
    cwd: workspace, input: "", timeout: 5000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /launch was aborted before startup/);
  assert.equal(listJobs(workspace)[0].status, "failed");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).pid, null);
});

test("a cancelled worker never starts or rewrites its job, with or without a start token", (t) => {
  const workspace = makeWorkspace(t);
  const job = storeQueuedJob(workspace, "cancelled");
  for (const input of ["start\n", ""]) {
    const result = run(process.execPath, [SCRIPT, "task-worker", "--job-id", job.id, "--wait-for-start"], {
      cwd: workspace, input, timeout: 5000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(listJobs(workspace)[0].status, "cancelled");
    assert.deepEqual(readJobFile(resolveJobFile(workspace, job.id)), job);
  }
});

function runLauncherWithFault(workspace, prelude) {
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir);
  installFakeCodex(binDir);
  const source = `${prelude}
    process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, "task", "--background", "--json", "startup test"];
    await import(${JSON.stringify(SCRIPT_URL.href)});
  `;
  return run(process.execPath, ["--input-type=module", "-e", source], {
    cwd: workspace, env: buildEnv(binDir), timeout: 10000
  });
}

test("the launcher records a failed job when spawning its worker fails", (t) => {
  const workspace = makeWorkspace(t);
  const result = runLauncherWithFault(workspace, `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const spawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => spawn(command, args, { ...options, cwd: "missing-directory" });
    syncBuiltinESMExports();
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Could not start background task:.*ENOENT/);
  const [job] = listJobs(workspace);
  assert.equal(job.status, "failed");
  assert.equal(job.pid, null);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "failed");
});

test("a state-index write failure is reported and the launched worker is stopped", (t) => {
  const workspace = makeWorkspace(t);
  const result = runLauncherWithFault(workspace, `
    import fs from "node:fs";
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, contents, ...args) => {
      if (String(file).includes("state.json") && String(contents).includes('"status": "queued"')) {
        throw new Error("Injected state-index write failure");
      }
      if (String(file).endsWith(".tmp") && String(contents).includes('"status": "queued"')) {
        write("worker-pid", String(JSON.parse(contents).pid));
      }
      return write(file, contents, ...args);
    };
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Could not start background task: Injected state-index write failure/);
  const [job] = listJobs(workspace);
  assert.equal(job.status, "failed");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "failed");
  assert.equal(isProcessRunning(Number(fs.readFileSync(path.join(workspace, "worker-pid"), "utf8"))), false);
});

test("a launch failure after cancellation preserves the cancelled status", (t) => {
  const workspace = makeWorkspace(t);
  const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url);
  const result = runLauncherWithFault(workspace, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { listJobs, upsertJob, writeJobFile } from ${JSON.stringify(stateUrl.href)};
    const spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      const child = spawn(...args);
      child.stdin.end = (_token, callback) => {
        const [job] = listJobs(process.cwd());
        const cancelled = { ...job, status: "cancelled", phase: "cancelled", pid: null };
        writeJobFile(process.cwd(), job.id, cancelled);
        upsertJob(process.cwd(), cancelled);
        fs.writeFileSync("worker-pid", String(child.pid));
        queueMicrotask(() => callback(new Error("Worker cancelled during startup")));
      };
      return child;
    };
    syncBuiltinESMExports();
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Worker cancelled during startup/);
  const [job] = listJobs(workspace);
  assert.equal(job.status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
  assert.equal(isProcessRunning(Number(fs.readFileSync(path.join(workspace, "worker-pid"), "utf8"))), false);
});
