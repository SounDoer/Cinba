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

export type CommandId = "model" | "sessions" | "new" | "help";

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
  { id: "help", name: "help", summary: "list these commands" },
  { id: "model", name: "model", summary: "switch model, keeping this conversation" },
  { id: "new", name: "new", summary: "start a conversation here" },
  { id: "sessions", name: "sessions", summary: "switch to another conversation" },
];

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
  if (!isCommand(input)) return [];
  const typed = input.trimStart().slice(1).trim().toLowerCase();

  return COMMANDS.filter((command) => command.name.startsWith(typed)).sort((a, b) => {
    const exact = Number(b.name === typed) - Number(a.name === typed);
    return exact !== 0 ? exact : a.name.localeCompare(b.name);
  });
}
