export type ShellInvocation = {
  name: string;
  args: string[];
  wrappers: string[];
};

function finishToken(tokens: string[], token: string): string {
  if (token !== "") {
    tokens.push(token);
  }
  return "";
}

/**
 * Split enough shell syntax to identify command names and literal arguments.
 * This is deliberately not a full Bash or PowerShell parser; uncertain input
 * remains eligible for an Ask rule rather than being treated as a sandbox.
 */
export function parseShellInvocations(command: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;

  const finishInvocation = () => {
    token = finishToken(tokens, token);
    if (tokens.length > 0) {
      const unwrapped = unwrapCommand(tokens);
      const [name, ...args] = unwrapped.tokens;
      if (name) {
        invocations.push({ name: executableName(name), args, wrappers: unwrapped.wrappers });
      }
    }
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      token = finishToken(tokens, token);
      if (character === "\n" || character === "\r") {
        finishInvocation();
      }
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      finishInvocation();
      continue;
    }
    token += character;
  }

  finishInvocation();
  return invocations;
}

function unwrapCommand(tokens: string[]): { tokens: string[]; wrappers: string[] } {
  let index = 0;
  const wrappers: string[] = [];
  while (index < tokens.length) {
    const candidate = executableName(tokens[index]!);
    if (candidate !== "sudo" && candidate !== "command") {
      break;
    }
    if (candidate === "command" && ["-v", "-V"].includes(tokens[index + 1] ?? "")) {
      break;
    }
    wrappers.push(candidate);
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return { tokens: tokens.slice(index), wrappers };
}

const OUTPUT_SINKS = new Set(["/dev/null", "nul", "nul:", "$null"]);

/** Whether output is redirected to something that may be a real file. */
export function hasRiskyOutputRedirection(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== ">") {
      continue;
    }

    let cursor = index + 1;
    if (command[cursor] === ">") {
      cursor += 1;
    }
    while (/\s/.test(command[cursor] ?? "")) {
      cursor += 1;
    }

    // File-descriptor duplication such as 2>&1 does not write a file.
    if (command[cursor] === "&") {
      while (cursor < command.length && !/[\s;|]/.test(command[cursor]!)) {
        cursor += 1;
      }
      index = cursor - 1;
      continue;
    }

    let target = "";
    const targetQuote = command[cursor];
    if (targetQuote === "'" || targetQuote === '"') {
      cursor += 1;
      while (cursor < command.length && command[cursor] !== targetQuote) {
        target += command[cursor]!;
        cursor += 1;
      }
      if (command[cursor] === targetQuote) {
        cursor += 1;
      }
    } else {
      while (cursor < command.length && !/[\s;|&]/.test(command[cursor]!)) {
        target += command[cursor]!;
        cursor += 1;
      }
    }

    if (!OUTPUT_SINKS.has(target.toLowerCase())) {
      return true;
    }
    index = cursor - 1;
  }
  return false;
}

function executableName(value: string): string {
  return value
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(exe|com)$/i, "")
    .toLowerCase();
}
