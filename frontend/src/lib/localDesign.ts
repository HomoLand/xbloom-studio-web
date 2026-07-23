/**
 * Browser-side design via OpenAI-compatible Chat Completions + vision.
 * Supports streaming so the UI can show a live "thinking" transcript.
 */

import type { RecipeContent } from "../api";
import { isAiConfigured, readAiConfig, type AiConfig } from "./aiConfig";
import { defaultCoffeeRecipe } from "./recipeDomain";

export type LocalDesignResult = {
  content: RecipeContent;
  rationale: string;
  rawText: string;
  model: string;
  /** Streaming / stage transcript for the UI */
  streamLog: string;
};

export type DesignProgressEvent =
  | { kind: "stage"; message: string }
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function systemPrompt(locale: string): string {
  const zh = locale.startsWith("zh");
  if (zh) {
    return `你是 xBloom Studio 手冲配方设计师。用户可能附带多张图片（豆袋封面 + 官方冲泡卡等）。
综合所有图片：豆袋看产地/处理法/风味，冲泡卡看官方参数（若有）。
**输出主语言必须是简体中文**：配方 name、各段 pours[].label、note、rationale 以及你的思考过程都用中文。
kind / pattern / vibration 等枚举字段保持英文机器值不变。
你可以先用中文简短推理，最后只输出一个 JSON 对象（不要 markdown 代码围栏）：
{
  "name": string（中文）,
  "kind": "hot" | "flash-brew",
  "dripper": "Omni Dripper 2",
  "dose_g": number,
  "grind": number (1-80 或 0 表示不研磨),
  "ratio": number,
  "water_ml": number,
  "hot_water_ml": number,
  "ice_g": number | null,
  "note": string（中文）,
  "pours": [
    {
      "label": string（中文，如「闷蒸」「主注」「收尾」）,
      "ml": number,
      "temp_c": number,
      "pattern": "spiral" | "circular" | "center" | "ring",
      "vibration": "none" | "before" | "after" | "both",
      "pause_s": number,
      "rpm": number,
      "flow_ml_s": number
    }
  ],
  "rationale": string（中文设计依据）
}
首杯偏保守。各段 ml 之和应接近 hot_water_ml。以 JSON 对象结尾。`;
  }
  return `You are an xBloom Studio pour-over recipe designer.
The user may attach multiple images (e.g. bean-bag front + brew/recipe card).
Use all images together. You may briefly reason, then return ONLY one JSON object
(no markdown fences) with name/labels/note/rationale in English:
{
  "name": string,
  "kind": "hot" | "flash-brew",
  "dripper": "Omni Dripper 2",
  "dose_g": number,
  "grind": number,
  "ratio": number,
  "water_ml": number,
  "hot_water_ml": number,
  "ice_g": number | null,
  "note": string,
  "pours": [{ "label": string, "ml": number, "temp_c": number, "pattern": "spiral"|"circular"|"center"|"ring", "vibration": "none"|"before"|"after"|"both", "pause_s": number, "rpm": number, "flow_ml_s": number }],
  "rationale": string
}
Prefer conservative first cups. Sum of pour ml ≈ hot_water_ml.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Prefer last JSON object in the stream (after optional reasoning text).
    const start = trimmed.lastIndexOf("{");
    if (start < 0) throw new Error("Model did not return JSON");
    let depth = 0;
    let end = -1;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return JSON");
  }
}

function toContent(obj: Record<string, unknown>): RecipeContent {
  const base = defaultCoffeeRecipe();
  const poursRaw = Array.isArray(obj.pours) ? obj.pours : base.pours;
  const pours = poursRaw.map((p: unknown, i: number) => {
    const row = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const bp = base.pours[Math.min(i, base.pours.length - 1)]!;
    return {
      label: String(row.label ?? bp.label ?? `Pour ${i + 1}`),
      ml: Number(row.ml ?? bp.ml),
      temp_c: (row.temp_c as number | "RT" | "BP") ?? bp.temp_c,
      pattern: (row.pattern as typeof bp.pattern) ?? bp.pattern,
      vibration: (row.vibration as typeof bp.vibration) ?? bp.vibration ?? "none",
      pause_s: Number(row.pause_s ?? bp.pause_s),
      rpm: Number(row.rpm ?? bp.rpm),
      flow_ml_s: Number(row.flow_ml_s ?? bp.flow_ml_s),
    };
  });
  return {
    name: String(obj.name ?? base.name),
    kind: obj.kind === "flash-brew" ? "flash-brew" : "hot",
    dripper: String(obj.dripper ?? "Omni Dripper 2"),
    dose_g: Number(obj.dose_g ?? base.dose_g),
    grind: Number(obj.grind ?? base.grind),
    ratio: Number(obj.ratio ?? base.ratio),
    water_ml: Number(obj.water_ml ?? base.water_ml),
    hot_water_ml: Number(obj.hot_water_ml ?? obj.water_ml ?? base.hot_water_ml),
    ice_g: obj.ice_g != null ? Number(obj.ice_g) : undefined,
    note: String(obj.note ?? obj.rationale ?? ""),
    pours,
  };
}

function deltaFromChunk(json: Record<string, unknown>): {
  content?: string;
  reasoning?: string;
} {
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const choice0 = choices?.[0];
  if (!choice0) return {};
  // Streaming chat.completion.chunk
  const delta = choice0.delta as Record<string, unknown> | undefined;
  if (delta) {
    const content =
      typeof delta.content === "string"
        ? delta.content
        : Array.isArray(delta.content)
          ? delta.content
              .map((p) =>
                p && typeof p === "object" && "text" in p
                  ? String((p as { text?: string }).text ?? "")
                  : "",
              )
              .join("")
          : undefined;
    const reasoning =
      (typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : undefined) ??
      (typeof delta.reasoning === "string" ? delta.reasoning : undefined) ??
      (typeof (delta as { thinking?: string }).thinking === "string"
        ? (delta as { thinking: string }).thinking
        : undefined);
    return { content, reasoning };
  }
  // Non-stream message
  const message = choice0.message as Record<string, unknown> | undefined;
  if (message) {
    const content =
      typeof message.content === "string" ? message.content : undefined;
    const reasoning =
      (typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : undefined) ??
      (typeof message.reasoning === "string" ? message.reasoning : undefined);
    return { content, reasoning };
  }
  return {};
}

async function readSseStream(
  res: Response,
  onProgress?: (ev: DesignProgressEvent) => void,
): Promise<{ content: string; reasoning: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as Record<string, unknown>;
        const d = deltaFromChunk(json);
        if (d.reasoning) {
          reasoning += d.reasoning;
          onProgress?.({ kind: "reasoning", text: d.reasoning });
        }
        if (d.content) {
          content += d.content;
          onProgress?.({ kind: "delta", text: d.content });
        }
      } catch {
        /* ignore partial JSON lines */
      }
    }
  }
  return { content, reasoning };
}

export async function designWithLocalAi(opts: {
  text: string;
  images?: File[];
  image?: File | null;
  config?: AiConfig;
  /** UI language; defaults to zh-CN for Chinese recipe output. */
  locale?: string;
  onProgress?: (ev: DesignProgressEvent) => void;
}): Promise<LocalDesignResult> {
  const cfg = opts.config ?? readAiConfig();
  if (!isAiConfigured(cfg)) {
    throw new Error(
      "Configure an OpenAI-compatible multimodal API in Settings first.",
    );
  }
  const locale = opts.locale ?? "zh-CN";
  const zh = locale.startsWith("zh");
  const system = systemPrompt(locale);
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const onProgress = opts.onProgress;

  const files: File[] = [];
  if (opts.images?.length) files.push(...opts.images);
  else if (opts.image) files.push(opts.image);

  onProgress?.({
    kind: "stage",
    message: files.length
      ? zh
        ? `准备 ${files.length} 张图片…`
        : `Preparing ${files.length} image(s)…`
      : zh
        ? "准备请求（无图，纯文字）…"
        : "Preparing text-only request…",
  });

  const userContent: Array<Record<string, unknown>> = [];
  const prompt =
    opts.text.trim() ||
    (files.length
      ? zh
        ? "请根据附图（豆袋和/或冲泡卡）设计一份 xBloom Studio 手冲配方；名称、段名、备注、设计依据请用简体中文。"
        : "Design an xBloom Studio pour-over from the attached image(s) (bag and/or brew card)."
      : zh
        ? "请设计一份 15g 均衡热冲 Omni Dripper 2 配方；名称、段名、备注、设计依据请用简体中文。"
        : "Design a balanced 15g hot pour-over for xBloom Studio Omni Dripper 2.");
  userContent.push({ type: "text", text: prompt });
  for (let i = 0; i < files.length; i++) {
    onProgress?.({
      kind: "stage",
      message: zh
        ? `编码图片 ${i + 1}/${files.length}…`
        : `Encoding image ${i + 1}/${files.length}…`,
    });
    const dataUrl = await fileToDataUrl(files[i]!);
    userContent.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }

  onProgress?.({
    kind: "stage",
    message: zh
      ? `调用模型 ${cfg.model}（流式）…`
      : `Calling model ${cfg.model} (stream)…`,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.4,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    // Fall back to non-stream if proxy rejects stream.
    if (res.status === 400 || res.status === 422) {
      onProgress?.({
        kind: "stage",
        message: zh
          ? "流式不可用，改为一次性响应…"
          : "Stream unavailable; using one-shot response…",
      });
      return designWithLocalAiNonStream({
        cfg,
        url,
        system,
        userContent,
        onProgress,
        locale,
      });
    }
    const body = await res.text().catch(() => "");
    throw new Error(
      `AI API ${res.status}: ${body.slice(0, 280) || res.statusText}. If this is a CORS error, use a proxy that allows browser origins.`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  let rawText = "";
  let reasoningText = "";
  let streamLog = "";

  const collectProgress = (ev: DesignProgressEvent) => {
    if (ev.kind === "stage") streamLog += `\n▸ ${ev.message}\n`;
    else if (ev.kind === "reasoning") streamLog += ev.text;
    else streamLog += ev.text;
    onProgress?.(ev);
  };

  if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
    const streamed = await readSseStream(res, collectProgress);
    rawText = streamed.content;
    reasoningText = streamed.reasoning;
  } else {
    // Some proxies ignore stream and return JSON.
    const data = (await res.json()) as Record<string, unknown>;
    const d = deltaFromChunk({
      choices: (data.choices as unknown[]) ?? [],
    });
    // Non-stream uses message not delta
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    rawText =
      (typeof msg?.content === "string" ? msg.content : "") ||
      d.content ||
      "";
    reasoningText =
      (typeof msg?.reasoning_content === "string"
        ? msg.reasoning_content
        : "") ||
      (typeof msg?.reasoning === "string" ? msg.reasoning : "") ||
      d.reasoning ||
      "";
    if (reasoningText) {
      collectProgress({ kind: "reasoning", text: reasoningText });
    }
    if (rawText) collectProgress({ kind: "delta", text: rawText });
  }

  if (!rawText && reasoningText) {
    // Some models put everything in reasoning; try parse there.
    rawText = reasoningText;
  }
  if (!rawText) throw new Error("Empty model response");

  const doneParse = zh ? "解析配方 JSON…" : "Parsing recipe JSON…";
  const doneMsg = zh ? "完成" : "Done";
  onProgress?.({ kind: "stage", message: doneParse });
  const parsed = extractJson(rawText) as Record<string, unknown>;
  const content = toContent(parsed);
  const note =
    "note" in content && content.note != null ? String(content.note) : "";
  const rationale = String(parsed.rationale ?? note);
  onProgress?.({ kind: "stage", message: doneMsg });

  return {
    content,
    rationale,
    rawText,
    model: cfg.model,
    streamLog: streamLog.trim(),
  };
}

async function designWithLocalAiNonStream(opts: {
  cfg: AiConfig;
  url: string;
  system: string;
  userContent: Array<Record<string, unknown>>;
  onProgress?: (ev: DesignProgressEvent) => void;
  locale?: string;
}): Promise<LocalDesignResult> {
  const { cfg, url, system, userContent, onProgress, locale } = opts;
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.4,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `AI API ${res.status}: ${body.slice(0, 280) || res.statusText}`,
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
  };
  const msg = data.choices?.[0]?.message ?? {};
  const rawText = typeof msg.content === "string" ? msg.content : "";
  const reasoning =
    (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "") ||
    (typeof msg.reasoning === "string" ? msg.reasoning : "");
  let streamLog = "";
  if (reasoning) {
    streamLog += reasoning;
    onProgress?.({ kind: "reasoning", text: reasoning });
  }
  if (rawText) {
    streamLog += rawText;
    onProgress?.({ kind: "delta", text: rawText });
  }
  if (!rawText && !reasoning) throw new Error("Empty model response");
  onProgress?.({
    kind: "stage",
    message: zh ? "解析配方 JSON…" : "Parsing recipe JSON…",
  });
  const parsed = extractJson(rawText || reasoning) as Record<string, unknown>;
  const content = toContent(parsed);
  const note =
    "note" in content && content.note != null ? String(content.note) : "";
  return {
    content,
    rationale: String(parsed.rationale ?? note),
    rawText: rawText || reasoning,
    model: cfg.model,
    streamLog: streamLog.trim(),
  };
}
