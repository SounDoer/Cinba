export const PROVIDER_ENVIRONMENT = {
  anthropic: "ANTHROPIC_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  openai: "OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  radius: "RADIUS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  baseten: "BASETEN_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
} as const satisfies Record<string, string>;

const SECRET_ENVIRONMENT = new Set([
  ...Object.values(PROVIDER_ENVIRONMENT),
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
]);

export function providerEnvironmentVariable(providerId: string): string | undefined {
  return PROVIDER_ENVIRONMENT[providerId as keyof typeof PROVIDER_ENVIRONMENT];
}

export function localProviderEnvironmentCredential(
  providerId: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const variable = providerEnvironmentVariable(providerId);
  return variable ? environment[variable] : undefined;
}

export function buildProviderEnvironment(options: {
  providerId: string;
  apiKey?: string;
  baseEnvironment?: Record<string, string | undefined>;
}): Record<string, string | undefined> {
  const environment = { ...(options.baseEnvironment ?? process.env) };
  for (const variable of SECRET_ENVIRONMENT) {
    delete environment[variable];
  }
  if (options.apiKey !== undefined) {
    const variable = providerEnvironmentVariable(options.providerId);
    if (!variable) {
      throw new Error(
        `Provider ${options.providerId} does not support API-key environment injection`,
      );
    }
    environment[variable] = options.apiKey;
  }
  return environment;
}
