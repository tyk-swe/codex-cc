/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {{ threadId: string, turnId: string }} SubagentTurn
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null, subagentTurns?: SubagentTurn[] }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   newlyRegisteredThreads: string[],
 *   parkedNotifications: Array<{ threadId: string, message: AppServerNotification }>,
 *   replayingParked: boolean,
 *   trackDelegateTurn: boolean,
 *   interruptTurnId: string | null,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Map<string, string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   lastAsyncMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const QUIET_REQUEST_TIMEOUT_MS = 3000;

// CSI escape sequences; Codex colours its tracing output even when piped.
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// "…could not update PATH:" (older CLIs) and "…could not create PATH aliases:".
const PATH_WARNING_PREFIX = "WARNING: proceeding, even though we could not";

export function cleanCodexStderr(stderr) {
  return String(stderr ?? "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith(PATH_WARNING_PREFIX))
    .join("\n");
}

/**
 * Base notification handler for a run: records Codex deprecation notices and
 * connection-level warnings in the job log. `captureTurn` forwards every
 * notification it does not consume to this handler.
 */
function createNoticeLogger(onProgress) {
  return (message) => {
    if (message?.method === "deprecationNotice") {
      const details = message.params?.details ?? null;
      emitLogEvent(onProgress, {
        message: `Codex deprecation notice: ${message.params?.summary ?? ""}`.trim(),
        logTitle: details ? "Codex deprecation notice" : null,
        logBody: details
      });
      return;
    }
    if (message?.method === "warning" && !message.params?.threadId) {
      emitLogEvent(onProgress, { message: `Codex warning: ${message.params?.message ?? ""}`.trim() });
    }
  };
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  if (!state.threadIds.has(threadId)) {
    state.threadIds.add(threadId);
    // Lets captureTurn replay notifications that arrived before the thread was known.
    state.newlyRegisteredThreads.push(threadId);
  }
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

// Keyed by string so older protocol bindings (without the "completed" kind)
// still typecheck.
const SUBAGENT_ACTIVITY_MESSAGES = new Map([
  ["started", (label) => `Started subagent ${label}.`],
  ["interacted", (label) => `Messaged subagent ${label}.`],
  ["interrupted", (label) => `Interrupted subagent ${label}.`],
  ["completed", (label) => `Subagent ${label} completed.`]
]);

// "/root/design_challenger" -> "design_challenger"; nested paths keep their parents.
function formatAgentPath(agentPath) {
  const value = typeof agentPath === "string" ? agentPath.trim() : "";
  return value.replace(/^\/root\//, "") || value || null;
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      if (subagents.length === 0 && item.tool === "wait") {
        return { message: "Waiting for subagents.", phase: "investigating" };
      }
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    case "subAgentActivity": {
      // Only described on completion: Codex emits started/completed back to back.
      const describe = SUBAGENT_ACTIVITY_MESSAGES.get(String(item.kind));
      const label = labelForThread(state, item.agentThreadId) ?? formatAgentPath(item.agentPath) ?? item.agentThreadId;
      return describe ? { message: describe(label), phase: item.kind === "started" ? "investigating" : null } : null;
    }
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    newlyRegisteredThreads: [],
    parkedNotifications: [],
    replayingParked: false,
    trackDelegateTurn: Boolean(options.trackDelegateTurn),
    interruptTurnId: null,
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Map(),
    completionTimer: null,
    lastAgentMessage: "",
    lastAsyncMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
    if (turn.error && !state.error) {
      state.error = turn.error;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "subAgentActivity") {
    // Multi-agent v2 (all GPT-6 models) announces subagent threads only
    // through these items: no thread/started, no collab receiverThreadIds.
    registerThread(state, item.agentThreadId, { name: formatAgentPath(item.agentPath) });
    return;
  }

  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage" && item.delivery === "async") {
    // Mid-turn update from an async tool (send_message_to_user_async,
    // request_user_input_async). It can carry phase "final_answer" but is not
    // the turn's answer, so it must not end or become the captured output.
    if (lifecycle === "completed" && item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAsyncMessage = item.text;
      }
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel ? `Subagent ${sourceLabel} update: ${shorten(item.text, 96)}` : `Codex update: ${shorten(item.text, 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} update` : "Codex update",
        logBody: item.text
      });
    }
    return;
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.set(message.params.threadId, message.params.turn.id);
        emitProgress(
          state.onProgress,
          `Subagent ${labelForThread(state, message.params.threadId)} turn started (${message.params.turn.id}).`,
          null,
          { subagentTurns: snapshotSubagentTurns(state) }
        );
        break;
      }
      emitProgress(state.onProgress, `Turn started (${message.params.turn.id}).`, "starting", {
        threadId: message.params.threadId ?? null,
        turnId: message.params.turn.id ?? null
      });
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error": {
      const errorMessage = message.params.error?.message ?? "unknown error";
      if (message.params.willRetry) {
        // Transient stream retry ("Reconnecting... 2/5"); the turn goes on.
        emitProgress(state.onProgress, `Codex retrying: ${errorMessage}`);
        break;
      }
      const errorThreadId = message.params.threadId ?? null;
      if (errorThreadId && errorThreadId !== state.threadId) {
        // A subagent failing does not fail the task; the root turn decides.
        emitProgress(state.onProgress, `Subagent ${labelForThread(state, errorThreadId)} error: ${errorMessage}`);
        break;
      }
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${errorMessage}`, "failed");
      break;
    }
    case "warning": {
      const sourceLabel = labelForThread(state, message.params.threadId ?? null);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} warning: ${message.params.message}`
          : `Codex warning: ${message.params.message}`
      });
      break;
    }
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        // A subagent can run follow-up turns; accept its next turn id.
        state.threadTurnIds.delete(message.params.threadId);
        emitProgress(
          state.onProgress,
          `Subagent ${labelForThread(state, message.params.threadId)} turn ${message.params.turn?.status ?? "completed"}.`,
          null,
          { subagentTurns: snapshotSubagentTurns(state) }
        );
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

/** @returns {SubagentTurn[]} */
function snapshotSubagentTurns(state) {
  return [...state.activeSubagentTurns].map(([threadId, turnId]) => ({ threadId, turnId }));
}

// Notifications for threads we do not know yet may belong to a subagent whose
// subAgentActivity item has not arrived: Codex does not order them.
const PARKABLE_METHODS = new Set(["turn/started", "turn/completed", "item/started", "item/completed", "error", "warning"]);
const MAX_PARKED_NOTIFICATIONS = 500;

function parkNotification(state, threadId, message) {
  state.parkedNotifications.push({ threadId, message });
  if (state.parkedNotifications.length > MAX_PARKED_NOTIFICATIONS) {
    state.parkedNotifications.shift();
  }
}

function replayParkedNotifications(state, dispatch) {
  if (state.replayingParked) {
    return;
  }
  state.replayingParked = true;
  try {
    // Replaying can register further threads (grandchildren); keep going.
    while (state.newlyRegisteredThreads.length > 0) {
      const threadId = state.newlyRegisteredThreads.shift();
      const ready = [];
      state.parkedNotifications = state.parkedNotifications.filter((entry) => {
        if (entry.threadId !== threadId) {
          return true;
        }
        ready.push(entry.message);
        return false;
      });
      for (const message of ready) {
        dispatch(message);
      }
    }
  } finally {
    state.replayingParked = false;
  }
}

// An inline review runs in a delegate turn: turn/started carries the
// delegate's id, which is the only id turn/interrupt accepts, while items and
// turn/completed carry the review/start response id.
function isReviewDelegateTurnStart(state, message) {
  return (
    state.trackDelegateTurn &&
    message.method === "turn/started" &&
    message.params?.threadId === state.threadId &&
    Boolean(state.turnId) &&
    Boolean(message.params?.turn?.id) &&
    message.params.turn.id !== state.turnId
  );
}

/**
 * GPT-6 subagents can still be running when the root turn completes; nothing
 * would read their results. Interrupt them so no Codex work keeps changing the
 * workspace after the run reports completion.
 */
async function stopLeftoverSubagents(client, state) {
  if (state.activeSubagentTurns.size === 0) {
    return;
  }
  const stopped = [];
  for (const [threadId, turnId] of [...state.activeSubagentTurns]) {
    const outcome = await requestQuietly(client, "turn/interrupt", { threadId, turnId });
    if (outcome.ok) {
      // Codex answers before it sends turn/completed, which may never reach us.
      state.activeSubagentTurns.delete(threadId);
      stopped.push(labelForThread(state, threadId) ?? threadId);
    }
  }
  if (stopped.length > 0) {
    emitProgress(
      state.onProgress,
      `Interrupted ${stopped.length} subagent(s) still running when Codex finished: ${stopped.join(", ")}.`,
      null,
      { subagentTurns: [] }
    );
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  const dispatch = (message) => {
    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      replayParkedNotifications(state, dispatch);
      return;
    }

    if (isReviewDelegateTurnStart(state, message)) {
      state.interruptTurnId = message.params.turn.id;
      emitProgress(state.onProgress, `Turn started (${state.interruptTurnId}).`, "starting", {
        threadId: state.threadId,
        turnId: state.interruptTurnId
      });
      return;
    }

    const messageThreadId = extractThreadId(message);
    if (messageThreadId && !state.threadIds.has(messageThreadId) && PARKABLE_METHODS.has(message.method)) {
      parkNotification(state, messageThreadId, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      previousHandler?.(message);
      return;
    }

    applyTurnNotification(state, message);
    replayParkedNotifications(state, dispatch);
  };

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }
    dispatch(message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications.splice(0)) {
      dispatch(message);
    }

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    await waitForTurnOrExit(client, state);
    await stopLeftoverSubagents(client, state);
    // The connection is subscribed to every subagent thread; release them so
    // they unload instead of accumulating in the shared broker. The caller
    // releases the root thread.
    for (const subagentThreadId of state.threadIds) {
      if (subagentThreadId !== state.threadId) {
        await releaseThread(client, subagentThreadId);
      }
    }
    return state;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

// A turn only ends with turn/completed; if the connection to Codex goes away
// first, fail instead of waiting forever.
function waitForTurnOrExit(client, state) {
  const exited = client.exitPromise.then(() => {
    if (state.completed) {
      return state;
    }
    const stderr = cleanCodexStderr(client.stderr);
    throw client.exitError ?? new Error(`codex app-server exited before the turn completed.${stderr ? `\n${stderr}` : ""}`);
  });
  exited.catch(() => {});
  return Promise.race([state.completion, exited]);
}

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

// Completions from older CLIs carry no importId (or no params at all).
function isCompletionForImport(completion, importId) {
  return !completion?.importId || !importId || completion.importId === importId;
}

/** Resolves with the matching `externalAgentConfig/import/completed` params. */
async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let importId = null;
  let responded = false;
  const earlyCompletions = [];
  /** @type {(completion: any) => void} */
  let resolveCompleted = () => {};
  /** @type {(error: Error) => void} */
  let rejectCompleted = () => {};
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      const completion = message.params ?? {};
      if (!responded) {
        // Can arrive before the response that tells us our importId.
        earlyCompletions.push(completion);
      } else if (isCompletionForImport(completion, importId)) {
        resolveCompleted(completion);
      }
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    const response = await client.request("externalAgentConfig/import", params);
    importId = response?.importId ?? null;
    responded = true;
    const earlyMatch = earlyCompletions.find((completion) => isCompletionForImport(completion, importId));
    if (earlyMatch) {
      resolveCompleted(earlyMatch);
    }
    return await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

function realpathOrSelf(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Picks the imported thread (success `target`) or the failure for this Claude
 * session out of an `import/completed` payload.
 */
function readImportedSessionResult(completion, sourcePath) {
  const results = Array.isArray(completion?.itemTypeResults) ? completion.itemTypeResults : [];
  const sessionResults = results.filter((result) => result?.itemType === "SESSIONS");
  const relevant = sessionResults.length > 0 ? sessionResults : results;
  const successes = relevant.flatMap((result) => (Array.isArray(result?.successes) ? result.successes : []));
  const failures = relevant.flatMap((result) => (Array.isArray(result?.failures) ? result.failures : []));
  const canonicalSource = realpathOrSelf(sourcePath);
  const isThisSession = (entry) =>
    typeof entry?.source === "string" &&
    (entry.source === sourcePath || entry.source === canonicalSource || realpathOrSelf(entry.source) === canonicalSource);
  const hasTarget = (entry) => typeof entry?.target === "string" && entry.target.length > 0;
  const success = successes.find((entry) => hasTarget(entry) && isThisSession(entry)) ?? successes.find(hasTarget) ?? null;
  const failure = failures.find(isThisSession) ?? failures[0] ?? null;
  return { threadId: success?.target ?? null, failure };
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

function isUnsupportedExcludeTurnsError(error) {
  return /excludeTurns/.test(String(error?.message ?? ""));
}

async function resumeThread(client, threadId, cwd, options = {}) {
  const params = buildResumeParams(threadId, cwd, options);
  try {
    // The plugin never reads thread.turns, and full-history hydration is
    // deprecated for paginated threads.
    return await client.request("thread/resume", { ...params, excludeTurns: true });
  } catch (error) {
    // Older Codex CLIs (e.g. 0.142) gate excludeTurns behind experimentalApi.
    if (!isUnsupportedExcludeTurnsError(error)) {
      throw error;
    }
    return client.request("thread/resume", params);
  }
}

/**
 * Best-effort request that never throws and never waits longer than
 * `timeoutMs`. Used after a turn has finished, where a failure must not make
 * `withAppServer` retry (and re-run) the whole task, and where `turn/interrupt`
 * only answers once the turn has actually aborted.
 */
async function requestQuietly(client, method, params, timeoutMs = QUIET_REQUEST_TIMEOUT_MS) {
  let timer = null;
  const request = Promise.resolve()
    .then(() => client.request(method, params))
    .then(
      (result) => ({ ok: true, result, error: null }),
      (error) => ({ ok: false, result: null, error })
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, result: null, error: new Error(`${method} timed out after ${timeoutMs}ms.`) }),
      timeoutMs
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Release this connection's subscription so the thread can unload. While a
 * thread stays loaded (always the case behind the shared broker), a later
 * `thread/resume` silently ignores its sandbox and model overrides.
 */
async function releaseThread(client, threadId) {
  if (threadId) {
    await requestQuietly(client, "thread/unsubscribe", { threadId });
  }
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

// Oldest Codex CLI this plugin is tested against (GPT-6 models, excludeTurns).
// Older CLIs keep working through fallbacks; /codex:setup suggests updating.
export const TESTED_CODEX_VERSION = "0.157.0";

/** Parses "codex-cli 0.157.1" (as printed by `codex --version`). */
export function parseCodexVersion(text) {
  const match = /\bcodex-cli\s+v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  if (!match) {
    return null;
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

export function isCodexVersionBelow(version, minimum = TESTED_CODEX_VERSION) {
  const floor = parseCodexVersion(`codex-cli ${minimum}`);
  if (!version || !floor) {
    return false;
  }
  for (const key of ["major", "minor", "patch"]) {
    if (version[key] !== floor[key]) {
      return version[key] < floor[key];
    }
  }
  return false;
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

const INTERRUPT_TIMEOUT_MS = 5000;

/**
 * Interrupts several turns over one connection, in order. `turn/interrupt`
 * only answers once the turn has aborted, so every call is bounded.
 */
export async function interruptAppServerTurns(cwd, targets) {
  const turns = (Array.isArray(targets) ? targets : []).filter((target) => target?.threadId && target?.turnId);
  if (turns.length === 0) {
    return [];
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return turns.map(({ threadId, turnId }) => ({
      threadId,
      turnId,
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    }));
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
  } catch (error) {
    return turns.map(({ threadId, turnId }) => ({
      threadId,
      turnId,
      attempted: true,
      interrupted: false,
      transport: null,
      detail: error instanceof Error ? error.message : String(error)
    }));
  }

  const results = [];
  try {
    for (const { threadId, turnId } of turns) {
      const outcome = await requestQuietly(client, "turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS);
      results.push({
        threadId,
        turnId,
        attempted: true,
        interrupted: outcome.ok,
        transport: client.transport,
        detail: outcome.ok
          ? `Interrupted ${turnId} on ${threadId}.`
          : outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
      });
    }
  } finally {
    await client.close().catch(() => {});
  }
  return results;
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }
  const [result] = await interruptAppServerTurns(cwd, [{ threadId, turnId }]);
  return {
    attempted: result.attempted,
    interrupted: result.interrupted,
    transport: result.transport,
    detail: result.detail
  };
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    client.setNotificationHandler(createNoticeLogger(options.onProgress));
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });

    let turnState;
    try {
      turnState = await captureTurn(
        client,
        sourceThreadId,
        () =>
          client.request("review/start", {
            threadId: sourceThreadId,
            // Detached delivery is deprecated; inline reviews run on this thread.
            delivery: "inline",
            target: options.target
          }),
        {
          onProgress: options.onProgress,
          trackDelegateTurn: true,
          onResponse(response, state) {
            if (response.reviewThreadId) {
              state.threadIds.add(response.reviewThreadId);
            }
          }
        }
      );
    } finally {
      await releaseThread(client, sourceThreadId);
    }

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    client.setNotificationHandler(createNoticeLogger(options.onProgress));
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    let completion;
    try {
      completion = await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const imported = readImportedSessionResult(completion, options.sourcePath);
    if (!imported.threadId && imported.failure) {
      const stage = imported.failure.failureStage ? ` (${imported.failure.failureStage})` : "";
      throw new Error(`Codex could not import the Claude session${stage}: ${imported.failure.message ?? "unknown error"}`);
    }
    // Older CLIs complete without results; their import ledger records the thread.
    const threadId = imported.threadId ?? importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    client.setNotificationHandler(createNoticeLogger(options.onProgress));
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      await releaseThread(client, threadId);
      throw new Error("A prompt is required for this Codex run.");
    }

    let turnState;
    try {
      turnState = await captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: buildTurnInput(prompt),
            model: options.model ?? null,
            effort: options.effort ?? null,
            outputSchema: options.outputSchema ?? null
          }),
        { onProgress: options.onProgress }
      );
    } finally {
      await releaseThread(client, threadId);
    }

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      // A turn that ends without a regular answer still reports its last update.
      finalMessage: turnState.lastAgentMessage || turnState.lastAsyncMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      // `codex app-server` records the threads it creates with the "vscode"
      // source; "appServer" is kept in case that ever changes.
      sourceKinds: ["vscode", "appServer"],
      // Without this, only threads from the current default provider are listed.
      modelProviders: [],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
