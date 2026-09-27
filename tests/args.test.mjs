import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const OPTIONS = {
  valueOptions: ["source", "cwd", "prompt-file"],
  booleanOptions: ["json"],
  aliasMap: { C: "cwd" }
};

test("inline option values retain equals signs and empty values", () => {
  assert.deepEqual(parseArgs(["--source=run=a=b.jsonl", "--cwd=/tmp/project=a", "--prompt-file="], OPTIONS), {
    options: { source: "run=a=b.jsonl", cwd: "/tmp/project=a", "prompt-file": "" },
    positionals: []
  });
});

test("raw arguments preserve literal backslashes in single and double quotes", () => {
  for (const quote of ["'", '"']) {
    const raw = `--source ${quote}C:\\Users\\me\\my session.jsonl${quote}`;
    assert.deepEqual(parseArgs(splitRawArgumentString(raw), OPTIONS), {
      options: { source: "C:\\Users\\me\\my session.jsonl" },
      positionals: []
    });
  }
  assert.deepEqual(splitRawArgumentString(String.raw`'one\\two\"three'`), [String.raw`one\\two\"three`]);
});

test("raw arguments keep empty quoted values and concatenate adjacent quoted text", () => {
  assert.deepEqual(parseArgs(splitRawArgumentString(`--source '' --prompt-file "" --cwd=pre"fix" --json`), OPTIONS), {
    options: { source: "", "prompt-file": "", cwd: "prefix", json: true },
    positionals: []
  });
  assert.deepEqual(splitRawArgumentString(`'' ""`), ["", ""]);
});

test("raw argument escapes follow quote context without expanding shell expressions", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`one\ two "say \"hi\"" "one\\two" "\$HOME" '\$(whoami)'`), [
    "one two", 'say "hi"', "one\\two", "$HOME", "\\$(whoami)"
  ]);
  assert.deepEqual(splitRawArgumentString("trailing\\"), ["trailing\\"]);
});

test("option aliases, booleans, unknown arguments and the separator retain their behavior", () => {
  assert.deepEqual(parseArgs(["-C", "repo=a", "--json=false", "--unknown=a=b", "--", "--source=literal", "-"], OPTIONS), {
    options: { cwd: "repo=a", json: false },
    positionals: ["--unknown=a=b", "--source=literal", "-"]
  });
  assert.throws(() => parseArgs(["--source"], OPTIONS), /Missing value for --source/);
});
