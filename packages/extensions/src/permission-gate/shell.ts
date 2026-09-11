export type ShellInvocation = {
  name: string;
  args: string[];
};

function finishToken(tokens: string[], token: string): string {
  if (token !== "") tokens.push(token);
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
      const [name, ...args] = unwrapCommand(tokens);
      if (name) invocations.push({ name: executableName(name), args });
    }
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      token = finishToken(tokens, token);
      if (character === "\n" || character === "\r") finishInvocation();
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

function unwrapCommand(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const candidate = executableName(tokens[index]!);
    if (candidate !== "sudo" && candidate !== "command") break;
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
  }
  return tokens.slice(index);
}

function executableName(value: string): string {
  return value
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(exe|com)$/i, "")
    .toLowerCase();
}
