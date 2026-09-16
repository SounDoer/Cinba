export type Parser<T> = (value: unknown) => T;

export class SyncSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SyncSchemaError";
    this.path = path;
  }
}

export function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncSchemaError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

export function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  const object = objectAt(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new SyncSchemaError(`${path}.${key}`, "unexpected field");
    }
  }
  return object;
}

export function versionOne(object: Record<string, unknown>, path: string): 1 {
  if (object.version !== 1) {
    throw new SyncSchemaError(`${path}.version`, "unsupported schema version");
  }
  return 1;
}

export function stringAt(value: unknown, path: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new SyncSchemaError(path, `expected a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

export function optionalStringAt(
  value: unknown,
  path: string,
  maxLength = 512,
): string | undefined {
  return value === undefined ? undefined : stringAt(value, path, maxLength);
}

export function integerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SyncSchemaError(path, "expected a non-negative safe integer");
  }
  return value as number;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new SyncSchemaError(path, "expected a boolean");
  }
  return value;
}

export function arrayAt<T>(
  value: unknown,
  path: string,
  parser: (item: unknown, path: string) => T,
  maxLength = 1_000,
): T[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new SyncSchemaError(path, `expected an array with at most ${maxLength} entries`);
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new SyncSchemaError(path, `expected one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

export type ModelRef = { provider: string; id: string };

export function modelRefAt(value: unknown, path: string): ModelRef {
  const object = strictObject(value, ["provider", "id"], path);
  return {
    provider: stringAt(object.provider, `${path}.provider`, 128),
    id: stringAt(object.id, `${path}.id`, 256),
  };
}
