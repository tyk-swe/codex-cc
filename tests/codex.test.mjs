import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanCodexStderr,
  isCodexVersionBelow,
  parseCodexVersion,
  TESTED_CODEX_VERSION
} from "../plugins/codex/scripts/lib/codex.mjs";

test("cleanCodexStderr strips ANSI colours and the Codex PATH warnings", () => {
  const raw = [
    'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"',
    "WARNING: proceeding, even though we could not update PATH: permission denied",
    "\u001b[2m2026-09-26T06:19:56.615844Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_api::endpoint::responses_websocket\u001b[0m\u001b[2m:\u001b[0m failed to connect to websocket",
    "",
    "plain line   "
  ].join("\n");

  assert.equal(
    cleanCodexStderr(raw),
    "2026-09-26T06:19:56.615844Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket\nplain line"
  );
});

test("cleanCodexStderr tolerates missing stderr", () => {
  assert.equal(cleanCodexStderr(undefined), "");
  assert.equal(cleanCodexStderr(""), "");
});

test("parseCodexVersion reads `codex --version` output and compares against the tested version", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.157.1; advanced runtime available"), {
    major: 0,
    minor: 157,
    patch: 1,
    raw: "0.157.1"
  });
  assert.equal(parseCodexVersion("codex-cli test"), null);
  assert.equal(isCodexVersionBelow(parseCodexVersion("codex-cli 0.142.5")), true);
  assert.equal(isCodexVersionBelow(parseCodexVersion(`codex-cli ${TESTED_CODEX_VERSION}`)), false);
  assert.equal(isCodexVersionBelow(parseCodexVersion("codex-cli 1.0.0")), false);
  assert.equal(isCodexVersionBelow(null), false);
});
