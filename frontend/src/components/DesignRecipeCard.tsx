import { CheckCircle2, Play, Save } from "lucide-react";
import type { DesignSource, RecipeContent } from "../api";
import { useI18n } from "../i18n/I18nContext";
import { isCoffeeContent } from "../lib/recipeDomain";
import { CoffeeEditor, TeaEditor } from "./RecipeEditors";
import { RecipeCard } from "./RecipeCard";
import { Alert, Button } from "./ui";

export function DesignRecipeCard({ content, rationale, sources, model, busy, saved, validated, error, onSave, onUse, onChange }: {
  content: RecipeContent; rationale: string | null; sources: DesignSource[]; model: string;
  busy: boolean; saved: boolean; validated: boolean; error: string | null;
  onSave: () => void; onUse: () => void; onChange: (content: RecipeContent) => void;
}) {
  const { t } = useI18n();
  const coffee = isCoffeeContent(content);
  return <div data-testid="design-recipe-card"><RecipeCard content={content} subtitle={model} badge={
    <span className={`flex items-center gap-1 ${validated ? "text-accent-green" : ""}`}>{validated ? <CheckCircle2 size={14} aria-hidden /> : null}{t(validated ? "design.validated" : "design.edited")}</span>
  }>
      {rationale ? <details className="text-sm text-ink-muted"><summary className="cursor-pointer">{t("design.rationale")}</summary><p className="mt-2 leading-relaxed">{rationale}</p></details> : null}
      {sources.length ? <details className="text-xs text-ink-muted">
        <summary className="cursor-pointer">{t("design.sources")} · {sources.length}</summary>
        <ul className="mt-2 space-y-2">{sources.map(source => <li key={source.url}><a className="text-accent-blue underline" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul>
      </details> : null}
      <details><summary className="cursor-pointer text-xs text-ink-muted">{t("design.adjust")}</summary><div className="mt-3">{coffee ? <CoffeeEditor value={content} onChange={onChange} /> : <TeaEditor value={content} onChange={onChange} />}</div></details>
      {error ? <Alert tone="amber">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !!error} onClick={onUse}><Play size={16} />{t("design.use")}</Button>
        <Button variant="secondary" disabled={busy || saved || !!error} onClick={onSave}><Save size={16} />{saved ? t("design.saved") : t("design.save")}</Button>
      </div>
  </RecipeCard></div>;
}
