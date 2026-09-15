const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export async function readLimitedResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Search response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Search response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readLimitedJsonResponse(
  response: Response,
  maxBytes?: number,
): Promise<unknown> {
  const text = await readLimitedResponseText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Search provider returned invalid JSON", { cause: error });
  }
}
