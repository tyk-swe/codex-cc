# Prompt Blocks

Use these blocks selectively when composing Codex task prompts.
Most prompts need only `task` and, when the answer's shape matters, an output contract.
Wrap each block in the XML tag shown in its heading.

## Core Wrapper

### `task`

Use in every prompt.

```xml
<task>
Describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## Output and Format

### `structured_output_contract`

Use when the response shape matters.

```xml
<structured_output_contract>
Return exactly the requested output shape and nothing else.
Put the highest-value findings or decisions first.
</structured_output_contract>
```

### `compact_output_contract`

Use when you want concise prose instead of a schema.

```xml
<compact_output_contract>
Keep the final answer compact and structured.
Do not include long scene-setting or repeated recap.
</compact_output_contract>
```

## Follow-Through

### `default_follow_through_policy`

Use when Codex should act without stopping for routine questions. Plugin runs are non-interactive, so a question mid-task only ends the run.

```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
Only stop to ask when a missing detail changes correctness, safety, or an irreversible action.
</default_follow_through_policy>
```

## Grounding and Missing Context

### `missing_context_gating`

Use when a wrong guess about the repository would be costly.

```xml
<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, retrieve it with tools or state exactly what remains unknown.
</missing_context_gating>
```

### `grounding_rules`

Use for review, research, or root-cause analysis.

```xml
<grounding_rules>
Ground every claim in the provided context or your tool outputs.
If a point is a hypothesis, label it clearly.
</grounding_rules>
```

### `citation_rules`

Use when external research or quotes matter.

```xml
<citation_rules>
Back important claims with explicit references to the sources you inspected.
Prefer primary sources.
</citation_rules>
```

## Safety and Scope

### `action_safety`

Use for write-capable or potentially broad tasks.

```xml
<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors, renames, or cleanup unless they are required for correctness.
Call out any risky or irreversible action before taking it.
</action_safety>
```

## Task-Specific Blocks

### `research_mode`

Use for exploration, comparisons, or recommendations.

```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Go deeper only where the evidence changes the recommendation.
</research_mode>
```

### `progress_updates`

Use when the run may take a while.

```xml
<progress_updates>
If you provide progress updates, keep them brief and outcome-based.
Mention only major phase changes or blockers.
</progress_updates>
```

## Opt-In Blocks

Current Codex models already follow through, test and check their own work. Add these only when the user explicitly asked for that behavior or the change is risky; otherwise they cause redundant test runs and longer turns.

### `verification_loop`

```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the changed files or tool outputs.
</verification_loop>
```

### `completeness_contract`

```xml
<completeness_contract>
Resolve the task fully before stopping, including follow-on fixes the change requires.
</completeness_contract>
```

### `dig_deeper_nudge`

```xml
<dig_deeper_nudge>
After the first plausible issue, check second-order failures, empty-state behavior, retries, stale state, and rollback paths.
</dig_deeper_nudge>
```
