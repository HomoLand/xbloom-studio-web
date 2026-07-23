/**
 * User-configured multimodal LLM (OpenAI-compatible) for static Design.
 * Credentials live in localStorage until the user clears site data.
 */

const KEY = "xbloom.aiConfig.v1";

export type AiConfig = {
  /** e.g. https://api.openai.com/v1 or a CORS-enabled proxy */
  baseUrl: string;
  apiKey: string;
  /** Chat model id with vision, e.g. gpt-4o-mini, grok-2-vision */
  model: string;
};

const DEFAULTS: AiConfig = {
  baseUrl: "",
  apiKey: "",
  model: "gpt-4o-mini",
};

export function readAiConfig(): AiConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseUrl: String(parsed.baseUrl ?? "").trim(),
      apiKey: String(parsed.apiKey ?? "").trim(),
      model: String(parsed.model ?? DEFAULTS.model).trim() || DEFAULTS.model,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAiConfig(cfg: AiConfig): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    KEY,
    JSON.stringify({
      baseUrl: cfg.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim() || DEFAULTS.model,
    }),
  );
}

export function clearAiConfig(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}

export function isAiConfigured(cfg: AiConfig = readAiConfig()): boolean {
  return Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);
}
