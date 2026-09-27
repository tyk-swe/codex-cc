import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WORKER_SCRIPT = fileURLToPath(new URL("../codex-companion.mjs", import.meta.url));
const START_TOKEN = "start\n";

export async function waitForTaskWorkerStart(input = process.stdin) {
  let received = "";
  for await (const chunk of input) {
    received += chunk.toString();
    if (received.length > START_TOKEN.length) {
      return false;
    }
  }
  return received === START_TOKEN;
}

// The worker cannot read or update its job until the launcher has published
// both records, including its PID. EOF without the token aborts startup if the
// launcher dies. There must be no launcher state writes after this returns.
export async function launchTaskWorker(cwd, jobId, publishJob, options = {}) {
  let child = null;
  try {
    child = (options.spawnImpl ?? spawn)(
      process.execPath,
      [WORKER_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId, "--wait-for-start"],
      { cwd, env: process.env, detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true }
    );
    // Spawn and pipe failures are reported below; keep late error events from
    // becoming uncaught exceptions while cleaning up a failed launch.
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    await once(child, "spawn");
    await publishJob(child.pid);
    await new Promise((resolve, reject) => {
      child.stdin.end(START_TOKEN, (error) => error ? reject(error) : resolve());
    });
    child.unref();
  } catch (error) {
    if (child) {
      child.stdin?.destroy();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close").catch(() => {});
        // This worker has not been released to start Codex, so it owns no
        // running task that needs graceful interruption.
        child.kill("SIGKILL");
        await closed;
      }
    }
    throw error;
  }
}
