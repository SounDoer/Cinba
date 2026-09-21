import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Fail an artifact build before publication when any nested macOS code is unsealed or malformed. */
export async function verifyMacosApplicationSignature(applicationPath: string): Promise<void> {
  await execute("codesign", ["--verify", "--deep", "--strict", applicationPath]);
}
