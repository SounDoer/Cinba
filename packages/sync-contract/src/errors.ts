import { booleanAt, oneOf, strictObject, stringAt, versionOne } from "./schemas.ts";

export const SYNC_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "unsupported_version",
  "unavailable",
  "internal_error",
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export type SyncErrorResponse = {
  version: 1;
  error: {
    code: SyncErrorCode;
    message: string;
    retryable: boolean;
  };
};

export function parseSyncErrorResponse(value: unknown): SyncErrorResponse {
  const object = strictObject(value, ["version", "error"], "response");
  versionOne(object, "response");
  const error = strictObject(object.error, ["code", "message", "retryable"], "response.error");
  return {
    version: 1,
    error: {
      code: oneOf(error.code, SYNC_ERROR_CODES, "response.error.code"),
      message: stringAt(error.message, "response.error.message", 512),
      retryable: booleanAt(error.retryable, "response.error.retryable"),
    },
  };
}
