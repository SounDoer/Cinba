import type { ModelCandidate, ModelRef } from "@cinba/sync-contract";
import { SyncClientError } from "@cinba/sync-client";

export type Page = "overview" | "settings" | "credentials" | "cores" | "history" | "backup";

export const SHARED_CREDENTIAL_PROVIDERS = [
  { id: "anthropic", name: "Anthropic", kind: "model" },
  { id: "ant-ling", name: "Ant Ling", kind: "model" },
  { id: "azure-openai-responses", name: "Azure OpenAI Responses", kind: "model" },
  { id: "baseten", name: "Baseten", kind: "model" },
  { id: "cerebras", name: "Cerebras", kind: "model" },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", kind: "model" },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", kind: "model" },
  { id: "deepseek", name: "DeepSeek", kind: "model" },
  { id: "fireworks", name: "Fireworks", kind: "model" },
  { id: "google", name: "Google Gemini", kind: "model" },
  { id: "google-vertex", name: "Google Vertex AI", kind: "model" },
  { id: "groq", name: "Groq", kind: "model" },
  { id: "huggingface", name: "Hugging Face", kind: "model" },
  { id: "kimi-coding", name: "Kimi Coding", kind: "model" },
  { id: "minimax", name: "MiniMax", kind: "model" },
  { id: "minimax-cn", name: "MiniMax CN", kind: "model" },
  { id: "mistral", name: "Mistral", kind: "model" },
  { id: "moonshotai", name: "Moonshot AI", kind: "model" },
  { id: "moonshotai-cn", name: "Moonshot AI CN", kind: "model" },
  { id: "nvidia", name: "NVIDIA", kind: "model" },
  { id: "opencode", name: "OpenCode", kind: "model" },
  { id: "opencode-go", name: "OpenCode Go", kind: "model" },
  { id: "openai", name: "OpenAI", kind: "model" },
  { id: "openrouter", name: "OpenRouter", kind: "model" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", kind: "model" },
  {
    id: "qwen-token-plan-individual",
    name: "Qwen Token Plan Individual",
    kind: "model",
  },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan CN", kind: "model" },
  { id: "radius", name: "Radius", kind: "model" },
  { id: "together", name: "Together AI", kind: "model" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", kind: "model" },
  { id: "xai", name: "xAI", kind: "model" },
  { id: "xiaomi", name: "Xiaomi", kind: "model" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan AMS", kind: "model" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan CN", kind: "model" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan SGP", kind: "model" },
  { id: "zai", name: "Z.AI", kind: "model" },
  { id: "zai-coding-cn", name: "Z.AI Coding CN", kind: "model" },
  { id: "brave", name: "Brave Search", kind: "search" },
  { id: "exa", name: "Exa", kind: "search" },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  kind: "model" | "search";
}>;

export const MANUAL_MODEL_SELECTION = "__manual__";

export function initialModelSelection(
  current: ModelRef | undefined,
  candidates: ModelCandidate[],
): string {
  if (!current) {
    return "";
  }
  return candidates.some(
    (candidate) =>
      candidate.model.provider === current.provider && candidate.model.id === current.id,
  )
    ? `${current.provider}\0${current.id}`
    : MANUAL_MODEL_SELECTION;
}

export function errorMessage(error: unknown): string {
  if (error instanceof SyncClientError) {
    if (error.status === 401) {
      return "Your session has expired. Sign in again.";
    }
    if (error.code === "conflict") {
      return "Settings changed on another device. Reload the latest revision before saving.";
    }
    if (error.retryable) {
      return "The Sync Server is temporarily unreachable. Try again.";
    }
  }
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function modelLabel(candidate: ModelCandidate, connectedCoreCount: number): string {
  const base = `${candidate.model.provider}/${candidate.model.id}`;
  if (connectedCoreCount === 0) {
    return `${base} · no connected Cores`;
  }
  if (candidate.unsupportedCoreIds.length === 0) {
    return `${base} · all Cores`;
  }
  return `${base} · ${candidate.supportedCoreIds.length}/${connectedCoreCount} Cores`;
}

export function manualModel(provider: string, id: string): ModelRef | undefined {
  const normalizedProvider = provider.trim();
  const normalizedId = id.trim();
  return normalizedProvider && normalizedId
    ? { provider: normalizedProvider, id: normalizedId }
    : undefined;
}

export function consumeCredentialDraft(draft: string, clear: () => void): string | undefined {
  const credential = draft.trim();
  clear();
  return credential || undefined;
}
