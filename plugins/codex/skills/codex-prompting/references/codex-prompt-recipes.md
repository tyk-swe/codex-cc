# Codex Prompt Recipes

Use these as starting templates for Codex task prompts.
Copy the smallest recipe that fits the task, then trim anything you do not need.
In `codex:codex-rescue`, run diagnosis and fix-oriented recipes in write mode by default unless the user explicitly asked for read-only behavior.

## Diagnosis

```xml
<task>
Diagnose why the failing test or command is breaking in this repository.
Identify the most likely root cause from the available repository context and tools.
</task>

<compact_output_contract>
Return a compact diagnosis with:
1. most likely root cause
2. evidence
3. smallest safe next step
</compact_output_contract>

<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, state exactly what remains unknown.
</missing_context_gating>
```

## Narrow Fix

```xml
<task>
Implement the smallest safe fix for the identified issue in this repository.
Apply the fix; do not stop at the diagnosis.
Preserve existing behavior outside the failing path.
</task>

<structured_output_contract>
Return:
1. summary of the fix
2. touched files
3. verification performed
4. residual risks or follow-ups
</structured_output_contract>

<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
</default_follow_through_policy>

<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors or cleanup.
</action_safety>
```

## Root-Cause Review

```xml
<task>
Analyze this change for the most likely correctness or regression issues.
Focus on the provided repository context only.
</task>

<structured_output_contract>
Return:
1. findings ordered by severity
2. supporting evidence for each finding
3. brief next steps
</structured_output_contract>

<grounding_rules>
Ground every claim in the repository context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```

Add `dig_deeper_nudge` only when the user asked for an especially thorough pass.

## Research Or Recommendation

```xml
<task>
Research the available options and recommend the best path for this task.
</task>

<structured_output_contract>
Return:
1. observed facts
2. reasoned recommendation
3. tradeoffs
4. open questions
</structured_output_contract>

<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Go deeper only where the evidence changes the recommendation.
</research_mode>

<citation_rules>
Back important claims with explicit references to the sources you inspected.
Prefer primary sources.
</citation_rules>
```

## Prompt-Patching

```xml
<task>
Diagnose why this existing prompt is underperforming with current Codex models and propose the smallest high-leverage changes to improve it.
</task>

<structured_output_contract>
Return:
1. failure modes
2. root causes in the current prompt
3. a revised prompt
4. why the revision should work better
</structured_output_contract>

<grounding_rules>
Base your diagnosis on the prompt text and the failure examples provided.
Do not invent failure modes that are not supported by the examples.
</grounding_rules>
```
