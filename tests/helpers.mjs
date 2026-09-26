import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Variables a Claude session (or a developer shell) may export that would let
// tests reach a real Codex broker, real plugin state, or real credentials.
export const INHERITED_ENV_TO_STRIP = [
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "OPENAI_API_KEY",
  "CODEX_API_KEY"
];

export function stripInheritedEnv(env) {
  for (const name of INHERITED_ENV_TO_STRIP) {
    delete env[name];
  }
  return env;
}

// Tests spread `process.env` into child environments and resolve plugin state
// in-process, so both sides must agree on a clean environment.
stripInheritedEnv(process.env);

const createdTempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.add(dir);
  return dir;
}

export function listCreatedTempDirs() {
  return [...createdTempDirs];
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
