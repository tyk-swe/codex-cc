---
name: codex-prompting
description: Use inside codex:codex-rescue to turn the user's request into a compact Codex task prompt before forwarding it with `task`.
user-invocable: false
---

# Codex Prompting

Shape the forwarded prompt only. Do not inspect the repository or solve the task yourself.

Current Codex models (GPT-6 Astra, Sol and Luna) plan, read the code they need and check their own work without being told to. Prompts written for earlier models tend to over-steer them, so keep the prompt short and specific:

- Name the job and where to look: the failing command, file, error text or behavior.
- Say what done looks like and what must not change.
- Ask for a specific output shape only when it matters, for example findings first or a list of touched files.
- Keep the user's constraints and wording. Do not add requirements they did not ask for.
- Do not add "run the tests", "verify your work", "think harder" or "keep going" instructions unless the user asked for them or the change is risky. The model already does this, and extra nudges cause redundant test runs.
- Send one job per run. Split unrelated asks into separate `task` runs.
- For a follow-up on the same thread (`task --resume-last`), send only the new instruction.

Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt directly. Use the built-in `review` or `adversarial-review` commands for reviewing local git changes; they carry their own review contract.

Short XML-tagged blocks keep longer prompts unambiguous. Start with `<task>` and add only the blocks the job needs:

- [references/prompt-blocks.md](references/prompt-blocks.md): reusable blocks and when each one earns its place.
- [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md): small end-to-end templates.
- [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md): common ways Codex prompts go wrong.
