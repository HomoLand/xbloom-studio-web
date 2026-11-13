import type { DesignResult, DesignSource } from "../api.ts";

export type DesignEvent =
  | { kind: "stage"; stage: string; query?: string }
  | { kind: "draft"; rationale?: string; name?: string }
  | { kind: "sources"; sources: DesignSource[] };

export async function readDesignStream(response: Response, onEvent: (event: DesignEvent) => void): Promise<DesignResult> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("The server did not return a design stream");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty design stream");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1_000_000) throw new Error("Design stream exceeded limit");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5)) as DesignEvent | { kind: "result"; result: DesignResult } | { kind: "error"; error?: { message?: string } };
        if (event.kind === "error") throw new Error(event.error?.message || "Recipe generation failed");
        if (event.kind === "result") {
          if (event.result?.validation?.valid !== true || !event.result.recipe_candidate) {
            throw new Error("Recipe validation failed; please regenerate");
          }
          return event.result;
        }
        if (event.kind === "stage" || event.kind === "draft" || event.kind === "sources") onEvent(event);
      }
      if (done) throw new Error("Connection ended before recipe validation completed");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Preserve multi-image input with one bounded contact sheet for the host API. */
export async function designImage(files: File[]): Promise<File | null> {
  if (!files.length) return null;
  if (files.length === 1 && files[0]!.size <= 5 * 1024 * 1024 && /image\/(png|jpeg|webp)$/.test(files[0]!.type)) return files[0]!;
  const cols = files.length === 1 ? 1 : 2;
  const cell = files.length === 1 ? 1536 : 1024;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = Math.ceil(files.length / cols) * cell;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image preparation is unavailable");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < files.length; i++) {
    const bitmap = await createImageBitmap(files[i]!);
    try {
      const scale = Math.min(cell / bitmap.width, cell / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      context.drawImage(bitmap, (i % cols) * cell + (cell - width) / 2, Math.floor(i / cols) * cell + (cell - height) / 2, width, height);
    } finally { bitmap.close(); }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob || blob.size > 5 * 1024 * 1024) throw new Error("Images are too large; please select fewer images");
  return new File([blob], "reference-images.jpg", { type: "image/jpeg" });
}
