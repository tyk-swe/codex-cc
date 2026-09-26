import test from "node:test";
import assert from "node:assert/strict";

import { renderNativeReviewResult, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderNativeReviewResult only shows Codex stderr when the review failed", () => {
  const meta = { reviewLabel: "Review", targetLabel: "working tree diff" };
  const succeeded = renderNativeReviewResult(
    { status: 0, stdout: "No material issues found.", stderr: "ERROR codex_app_server: Codex could not find bubblewrap on PATH." },
    meta
  );
  assert.match(succeeded, /No material issues found\./);
  assert.doesNotMatch(succeeded, /stderr:/);
  assert.doesNotMatch(succeeded, /bubblewrap/);

  const failed = renderNativeReviewResult({ status: 1, stdout: "", stderr: "unexpected status 401 Unauthorized" }, meta);
  assert.match(failed, /Codex review failed\./);
  assert.match(failed, /stderr:/);
  assert.match(failed, /401 Unauthorized/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
