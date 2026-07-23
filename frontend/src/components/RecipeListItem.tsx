/**
 * Official-style recipe row: pastel thumb + title + meta line.
 */

import type { ReactNode } from "react";
import type { RecipeContent } from "../api";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";
import { RecipeThumb } from "./ui";

export function recipeThumbMeta(content: RecipeContent | null | undefined): {
  label: string;
  pours: number;
} {
  if (!content) return { label: "—", pours: 0 };
  if (isCoffeeContent(content)) {
    const dripper = String(content.dripper || "Omni");
    const short = /xpod/i.test(dripper)
      ? "xPod"
      : /omni/i.test(dripper)
        ? "Omni"
        : "Other";
    return { label: short, pours: content.pours?.length ?? 0 };
  }
  return { label: "Tea", pours: (content as { pours?: unknown[] }).pours?.length ?? 0 };
}

export function recipeMetaLine(content: RecipeContent | null | undefined): string {
  if (!content) return "";
  if (isCoffeeContent(content)) {
    const ratio =
      content.ratio != null ? `1:${Number(content.ratio).toFixed(Number(content.ratio) % 1 ? 1 : 0)}` : "";
    const water = content.water_ml != null ? `${content.water_ml}ml` : "";
    const dose = content.dose_g != null ? `${content.dose_g}g` : "";
    const pours =
      content.pours?.length != null ? `${content.pours.length} pours` : "";
    return [ratio && water ? `${ratio}-${water}` : water || ratio, dose, pours]
      .filter(Boolean)
      .join(" · ");
  }
  const tea = content as { leaf_g?: number; pours?: unknown[] };
  return [`${tea.leaf_g ?? "?"}g leaf`, `${tea.pours?.length ?? 0} steeps`]
    .filter(Boolean)
    .join(" · ");
}

export function RecipeListItem({
  name,
  content,
  index,
  active,
  badge,
  onClick,
}: {
  name?: string;
  content: RecipeContent | null | undefined;
  index: number;
  active?: boolean;
  badge?: ReactNode;
  onClick: () => void;
}) {
  const thumb = recipeThumbMeta(content);
  const title = name || recipeDisplayName(content ?? { name: "Untitled", kind: "hot", dose_g: 0, grind: 0, pours: [] } as never);
  const meta = recipeMetaLine(content);

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors",
        active
          ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
          : "hover:bg-surface-2/70",
      ].join(" ")}
    >
      <RecipeThumb label={thumb.label} pours={thumb.pours} index={index} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        {meta ? (
          <div className="mt-0.5 truncate text-xs text-ink-faint">{meta}</div>
        ) : null}
      </div>
      {badge}
    </button>
  );
}
