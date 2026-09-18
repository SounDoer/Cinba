export type MacosInstallHandoff = {
  parentProcessId: number;
};

const PARENT_PROCESS_ID = "CINBA_MACOS_INSTALL_PARENT_PID";

export function parseMacosInstallHandoff(
  environment: Readonly<Record<string, string | undefined>>,
): MacosInstallHandoff | undefined {
  const raw = environment[PARENT_PROCESS_ID];
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${PARENT_PROCESS_ID} must be a positive process id`);
  }
  const parentProcessId = Number(raw);
  if (!Number.isSafeInteger(parentProcessId)) {
    throw new Error(`${PARENT_PROCESS_ID} must be a positive process id`);
  }
  return { parentProcessId };
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForMacosInstallerExit(
  handoff: MacosInstallHandoff,
  options: {
    exists?: (processId: number) => boolean;
    delay?: (milliseconds: number) => Promise<void>;
    attempts?: number;
  } = {},
): Promise<void> {
  const exists = options.exists ?? processExists;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts ?? 300;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!exists(handoff.parentProcessId)) {
      return;
    }
    await delay(100);
  }
  throw new Error("the macOS installer application did not exit in time");
}

export const MACOS_INSTALL_PARENT_PROCESS_ID = PARENT_PROCESS_ID;
