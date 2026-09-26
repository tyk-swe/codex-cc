# Codex Prompt Anti-Patterns

Avoid these when prompting Codex.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing end state

Bad:

```text
Debug this failure.
```

Better:

```xml
<task>
Find why `npm test` fails in packages/api and apply the smallest fix.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## Over-steering a capable model

Current Codex models plan, read the code they need, and check their own work. Scripting every step, or piling on "verify everything twice", leads to redundant test runs and slower, noisier turns.

Bad:

```text
Before doing anything, read every file in src/, run the full test suite, fix the bug, run the full test suite again, then double-check every change.
```

Better:

```xml
<task>
Fix the crash in src/cache.ts when the cache is empty. Keep the public API unchanged.
</task>
```

## Asking for more reasoning instead of a better contract

Bad:

```text
Think harder and be very smart.
```

Better: state the end state and the output you need. If the task genuinely needs more reasoning, let the user choose a higher `--effort` instead of adding prompt text.

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

## Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```
