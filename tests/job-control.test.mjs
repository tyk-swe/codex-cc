import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import { resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveStateDir, saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

function workspaceWithJobs(t, jobs) {
  const workspace = makeTempDir();
  saveState(workspace, { jobs });
  t.after(() => {
    fs.rmSync(resolveStateDir(workspace), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

test("result reports the status of explicit active jobs and unique prefixes", (t) => {
  const workspace = workspaceWithJobs(t, [
    { id: "task-running", status: "running" },
    { id: "task-queued", status: "queued" },
    { id: "task-running-finished", status: "completed" }
  ]);
  for (const reference of ["task-running", "task-queued", "task-q"]) {
    assert.throws(() => resolveResultJob(workspace, reference), /Job task-(running|queued) is still (running|queued)/);
  }
  assert.throws(() => resolveResultJob(workspace, "task-r"), /ambiguous/);
  assert.throws(() => resolveResultJob(workspace, "missing"), /No job found for "missing"/);
});

test("result resolves each finished status by ID and prefix", (t) => {
  const workspace = workspaceWithJobs(t, [
    { id: "task-done", status: "completed" },
    { id: "task-failed", status: "failed" },
    { id: "task-cancelled", status: "cancelled" }
  ]);
  for (const [reference, id] of [["task-done", "task-done"], ["task-f", "task-failed"], ["task-c", "task-cancelled"]]) {
    assert.equal(resolveResultJob(workspace, reference).job.id, id);
  }
});

test("implicit result selects the latest finished job in the current session", (t) => {
  const workspace = workspaceWithJobs(t, [
    { id: "task-current-old", status: "failed", sessionId: "current", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "task-current", status: "completed", sessionId: "current", updatedAt: "2026-01-02T00:00:00Z" },
    { id: "task-other", status: "completed", sessionId: "other", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "task-active", status: "running", sessionId: "current", updatedAt: "2026-01-04T00:00:00Z" }
  ]);
  const previousSession = process.env[SESSION_ID_ENV];
  t.after(() => {
    if (previousSession === undefined) {
      delete process.env[SESSION_ID_ENV];
    } else {
      process.env[SESSION_ID_ENV] = previousSession;
    }
  });
  process.env[SESSION_ID_ENV] = "current";
  assert.equal(resolveResultJob(workspace).job.id, "task-current");
  assert.equal(resolveResultJob(workspace, "task-other").job.id, "task-other");
  delete process.env[SESSION_ID_ENV];
  assert.equal(resolveResultJob(workspace).job.id, "task-other");
});

test("implicit result distinguishes active jobs from empty history", (t) => {
  const workspace = workspaceWithJobs(t, [{ id: "task-active", status: "queued" }]);
  assert.throws(() => resolveResultJob(workspace), /Job task-active is still queued/);
  saveState(workspace, { jobs: [] });
  assert.throws(() => resolveResultJob(workspace), /No finished Codex jobs/);
});
