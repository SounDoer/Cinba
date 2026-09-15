// The catalogue of slash commands: which ones exist, what they are called,
// what they mean.
//
// One copy, imported by every frontend. What each end *does* with a command
// differs and should — opening the conversation list is a modal in a browser
// and a list at the bottom of a terminal — but if each end also decided which
// commands exist, the two would quietly stop being able to do the same things.
// That is the failure this whole package exists to prevent.
//
// These are Cinba's own commands. Pi has a second, separate set of its own
// (extension commands, prompt templates, skills, reachable through its
// get_commands call) which are per-session and would have to arrive over the
// wire rather than be listed here.

export type CommandId =
  | "compact"
  | "model"
  | "sessions"
  | "thinking"
  | "new"
  | "name"
  | "providers"
  | "login"
  | "logout"
  | "webtools"
  | "help";

export type Command = {
  id: CommandId;
  /** Typed after the slash. */
  name: string;
  summary: string;
};

/**
 * Order here is not the order shown — matchCommands sorts — so it is kept
 * alphabetical to match, rather than looking like a ranking that does nothing.
 */
export const COMMANDS: readonly Command[] = [
  { id: "compact", name: "compact", summary: "summarize older context now" },
  { id: "help", name: "help", summary: "list these commands" },
  { id: "model", name: "model", summary: "switch model, keeping this conversation" },
  { id: "name", name: "name", summary: "name this conversation, e.g. /name parser work" },
  { id: "login", name: "login", summary: "give a provider an API key" },
  { id: "logout", name: "logout", summary: "forget a provider's API key" },
  { id: "new", name: "new", summary: "start a conversation here" },
  { id: "providers", name: "providers", summary: "which providers are configured" },
  { id: "sessions", name: "sessions", summary: "switch to another conversation" },
  { id: "thinking", name: "thinking", summary: "set reasoning effort for this conversation" },
  { id: "webtools", name: "webtools", summary: "manage web search and fetch" },
];

/** The command word: what follows the slash, up to the first space. */
function commandWord(input: string): string {
  return input.trimStart().slice(1).trim().toLowerCase().split(/\s+/)[0] ?? "";
}

/**
 * Whatever followed the command word, trimmed. Empty when nothing did.
 *
 * "/name parser work" gives "parser work", and the spacing inside it is kept:
 * only the ends are trimmed, because the rest is the user's text.
 */
export function commandArgument(input: string): string {
  const rest = input.trimStart().slice(1).trim();
  const space = rest.search(/\s/);
  return space === -1 ? "" : rest.slice(space + 1).trim();
}

/** Does this input line look like a command rather than something to say? */
export function isCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/**
 * The commands matching what has been typed so far, best first.
 *
 * A bare "/" matches everything, which is what makes the list a menu: type the
 * slash and the options appear. An exact name sorts ahead of the merely
 * prefixed, so "/new" cannot be beaten by a longer command starting with it.
 *
 * The first is what Enter takes. On a bare slash that is /help, which is the
 * right thing for the one case where the user has expressed no intent yet.
 */
export function matchCommands(input: string): Command[] {
  if (!isCommand(input)) {
    return [];
  }
  // Only the first word names the command; the rest is its argument, so
  // "/name parser work" keeps matching "name" as it is typed.
  const typed = commandWord(input);

  return COMMANDS.filter((command) => command.name.startsWith(typed)).toSorted((a, b) => {
    const exact = Number(b.name === typed) - Number(a.name === typed);
    return exact !== 0 ? exact : a.name.localeCompare(b.name);
  });
}
