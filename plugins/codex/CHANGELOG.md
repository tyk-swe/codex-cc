# Changelog

## 1.1.0

First release of the community-maintained fork at [tyk-swe/codex-cc](https://github.com/tyk-swe/codex-cc), updated for Codex CLI 0.157 and the GPT-6 models. Install it with `/plugin marketplace add tyk-swe/codex-cc`; the plugin ID `codex@openai-codex` and the `/codex:*` commands are unchanged.

### Breaking

- Removed the `spark` model alias. Its target, `gpt-5.3-codex-spark`, has been retired. `--model` now passes any model ID through unchanged, for example `gpt-6-sol` or `gpt-6-luna`.

### Added

- GPT-6 support.
  - `--effort` accepts `max` and `ultra`.
  - Subagent progress from the multi-agent runtime shows up in job logs and `/codex:status`.
  - Subagents still running when Codex finishes are interrupted.
  - `/codex:cancel` stops a job's subagents as well as its main turn.
- Codex deprecation notices and warnings are written to the job log.
- `/codex:setup` suggests updating Codex when it is older than 0.157.0.
- `npm run test:live` drives the real `codex app-server` end to end against a local stand-in for the model API. Pull request CI runs it against the tested Codex version, and a weekly workflow runs it against the latest release.

### Fixed

- `--resume-last` finds the latest task thread even when the plugin has no job history for the repository.
- `--write` and `--model` take effect when resuming a thread that already ran in the same Claude session, including right after `/codex:cancel`.
- `codex resume <session-id>` works right after a run or a cancel, without failing with "already has an active writer". `/codex:cancel` now lets the interrupted run shut down cleanly, and only kills it if it does not stop within 10 seconds.
- Resuming a thread no longer triggers Codex's full-history deprecation notice. Older Codex versions still work.
- Background native reviews can be cancelled.
- Cancelled jobs stay `cancelled` instead of being marked `failed` or reverting to `running`.
- Job state is written atomically, so commands running at the same time never read or leave a half-written job file.
- Transient "Reconnecting…" errors that Codex retries no longer mark a job as failed.
- A subagent's error no longer fails the whole task.
- If the Codex app server exits mid-turn, the job fails right away instead of hanging.
- Mid-turn update messages no longer end a task early or replace its final answer.
- `/codex:transfer` reads the import result from Codex and reports Codex's reason when an import fails.
- Stderr from Codex is cleaned before it is shown: colour codes and the PATH alias warning are stripped. `/codex:review` shows stderr only when the review fails.
- Brokers no longer leak when they fail to start in time.
- Cancelling a job no longer leaves its process running when the process-group kill fails.
- The plugin no longer subscribes to streaming output it does not use.

### Changed

- The internal prompting skill is renamed from `gpt-5-4-prompting` to `codex-prompting` and rewritten for GPT-6, which needs fewer instructions.
- Documentation uses the GPT-6 models and points to this repository.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
