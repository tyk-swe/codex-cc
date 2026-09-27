// A tiny stand-in for the OpenAI Responses API, so the live smoke test can run
// the real `codex app-server` end to end without network access or an account.
import http from "node:http";

export const CANNED_TASK_ANSWER = "Handled the requested task.";
export const CANNED_REVIEW_ANSWER = "No material issues found.";

const STRUCTURED_REVIEW = {
  verdict: "approve",
  summary: CANNED_REVIEW_ANSWER,
  findings: [],
  next_steps: []
};

const NATIVE_REVIEW = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: CANNED_REVIEW_ANSWER,
  overall_confidence_score: 0.9
};

function answerFor(request) {
  if (request.text?.format) {
    // turn/start outputSchema (adversarial review) arrives as text.format.
    return JSON.stringify(STRUCTURED_REVIEW);
  }
  const input = JSON.stringify(request.input ?? "");
  if (/Review the current code changes|against the base branch/.test(input)) {
    return JSON.stringify(NATIVE_REVIEW);
  }
  return CANNED_TASK_ANSWER;
}

function sseEvents(answer) {
  const id = `resp_${Math.random().toString(36).slice(2)}`;
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", id: `msg_${id}`, content: [{ type: "output_text", text: answer }] }
    },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 15
        }
      }
    }
  ];
}

/**
 * @returns {Promise<{ port: number, requests: Array<{ model: string | null, effort: string | null, sandbox: string | null, hasSchema: boolean }>, setHang: (value: boolean) => void, close: () => Promise<void> }>}
 */
export async function startFakeResponsesServer() {
  const requests = [];
  let hang = false;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let request = {};
      try {
        request = JSON.parse(body || "{}");
      } catch {
        request = {};
      }
      requests.push({
        model: request.model ?? null,
        effort: request.reasoning?.effort ?? null,
        // Codex describes the active sandbox in its permission instructions;
        // a resumed thread replays earlier turns' instructions first.
        sandbox: [...body.matchAll(/`sandbox_mode` is `([a-z-]+)`/g)].at(-1)?.[1] ?? null,
        hasSchema: Boolean(request.text?.format)
      });

      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hang) {
        // Keep the turn in flight so it can be interrupted.
        return;
      }
      for (const event of sseEvents(answerFor(request))) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    requests,
    setHang(value) {
      hang = Boolean(value);
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
