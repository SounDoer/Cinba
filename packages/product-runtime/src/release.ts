import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PayloadRelease, parsePayloadRelease } from "@cinba/installer";

export type ProductRelease = PayloadRelease;

export function parseProductRelease(value: unknown): ProductRelease {
  return parsePayloadRelease(value);
}

export async function readProductRelease(payloadRoot: string): Promise<ProductRelease> {
  return parseProductRelease(
    JSON.parse(await readFile(join(payloadRoot, "release.json"), "utf8")) as unknown,
  );
}
