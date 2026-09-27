export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const rawKey = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of raw) {
    if (escaping) {
      // Within double quotes, backslashes only escape shell-special characters.
      // Single quotes preserve every backslash literally.
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(character)) {
        current += "\\";
      }
      if (character !== "\n") {
        current += character;
        tokenStarted = true;
      }
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
    tokenStarted = true;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}
