import type { ReactNode } from "react";
import { Coffee, Leaf, Snowflake } from "lucide-react";
import type { RecipeContent } from "../api";
import { useI18n } from "../i18n/I18nContext";
import { isCoffeeContent, recipeDisplayName } from "../lib/recipeDomain";

export function RecipeCard({ content, name, badge, subtitle, compact = false, children }: {
  content: RecipeContent;
  name?: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const coffee = isCoffeeContent(content);
  const flash = coffee && content.kind === "flash-brew";
  const Icon = coffee ? flash ? Snowflake : Coffee : Leaf;
  const temperature = (value: number | string) => typeof value === "number" ? `${value}°C` : value;
  return <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" data-testid="recipe-card">
    <header className="border-b border-line bg-surface-2 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5"><Icon size={16} aria-hidden />{coffee ? t(flash ? "editor.flash" : "design.coffee") : t("design.tea")}</span>
        {badge}
      </div>
      <h3 className={`break-words font-semibold leading-snug text-ink ${compact ? "min-h-12 text-base" : "text-xl"}`}>{name || recipeDisplayName(content)}</h3>
      <p className="mt-2 text-xs text-ink-faint">{coffee ? `${content.dripper || "—"}${content.ratio != null ? ` · 1:${content.ratio}` : ""}` : t("recipeCard.teaBasket")}</p>
      {subtitle ? <div className="mt-1 break-words text-xs text-ink-faint">{subtitle}</div> : null}
    </header>
    <div className="flex flex-1 flex-col gap-4 p-5">
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div><dt className="text-xs text-ink-muted">{t(coffee ? "design.dose" : "design.leaves")}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{coffee ? content.dose_g : content.leaf_g} <span className="text-xs font-normal">g</span></dd></div>
        <div><dt className="text-xs text-ink-muted">{t(coffee ? "design.water" : "design.perSteep")}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{coffee ? content.water_ml : content.output_ml_per_steep} <span className="text-xs font-normal">ml</span></dd></div>
        <div><dt className="text-xs text-ink-muted">{t(coffee ? "design.grind" : "design.steeps")}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{coffee ? content.grind : content.pours.length}</dd></div>
      </dl>
      {coffee && (content.hot_water_ml != null || content.bypass_ml != null || content.bypass_temp_c != null || content.ice_g != null || content.time) ? <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
        {content.hot_water_ml != null && (!compact || flash) ? <div><dt className="inline">{t("editor.hotWater")} </dt><dd className="inline">{content.hot_water_ml}</dd></div> : null}
        {content.bypass_ml != null || content.bypass_temp_c != null ? <div><dt className="inline">Bypass </dt><dd className="inline">{content.bypass_ml != null ? `${content.bypass_ml} ml` : ""}{content.bypass_temp_c != null ? ` · ${temperature(content.bypass_temp_c)}` : ""}</dd></div> : null}
        {content.ice_g != null ? <div><dt className="inline">{t("recipeCard.ice")} </dt><dd className="inline">{content.ice_g} g</dd></div> : null}
        {content.time ? <div><dt className="sr-only">{t("recipeCard.time")}</dt><dd>{content.time}</dd></div> : null}
      </dl> : null}
      <div>
        <p className="mb-2 text-xs text-ink-faint">{t(coffee ? "recipes.pours" : "design.steeps")} · {content.pours.length}</p>
        <ol className={compact ? "flex flex-wrap gap-1.5" : "space-y-2"}>
          {content.pours.map((pour, index) => compact ? <li key={index} className="min-w-12 flex-1 rounded-xl bg-surface-2 px-2 py-2 text-center text-xs">
            <span className="block font-medium tabular-nums">{pour.ml} ml</span><span className="mt-1 block text-ink-muted">{temperature(pour.temp_c)}</span>
          </li> : <li key={index} className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-xs text-ink-faint">{index + 1}.</span><span className="min-w-0 flex-1 break-words">{pour.label}</span><span className="tabular-nums">{pour.ml} ml · {temperature(pour.temp_c)} · {pour.pause_s}s</span></div>
            <p className="mt-1 text-xs text-ink-muted">{pour.pattern} · {pour.flow_ml_s} ml/s{"rpm" in pour ? ` · ${pour.rpm} rpm` : ""}{"vibration" in pour && pour.vibration && pour.vibration !== "none" ? ` · ${t("recipeCard.vibration")} ${pour.vibration}` : ""}</p>
          </li>)}
        </ol>
      </div>
      {coffee && content.note ? <p className={`break-words text-xs leading-relaxed text-ink-muted ${compact ? "line-clamp-2" : ""}`}>{content.note}</p> : null}
      {children ? <div className="mt-auto space-y-4">{children}</div> : null}
    </div>
  </article>;
}
