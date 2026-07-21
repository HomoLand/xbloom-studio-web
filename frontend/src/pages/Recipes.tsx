import { useEffect, useState } from "react";
import { api, type Template, type ValidateResult } from "../api";

export default function Recipes() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [validatePath, setValidatePath] = useState("");
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.templates()
      .then((r) => setTemplates(r.templates))
      .finally(() => setLoading(false));
  }, []);

  const doValidate = async () => {
    if (!validatePath.trim()) return;
    setBusy(true);
    try {
      setResult(await api.validate(validatePath.trim()));
    } finally {
      setBusy(false);
    }
  };

  const coffee = templates.filter((t) => !t.tea && t.kind !== "hot" || (t.kind === "hot" && !t.tea && t.dose_g !== null));
  const tea = templates.filter((t) => t.tea);

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">配方库</h1>
      <p className="text-sm text-white/40 mb-6">内置模板与配方校验</p>

      <section className="mb-8">
        <h2 className="text-base font-medium mb-3">咖啡模板</h2>
        {loading ? (
          <div className="text-sm text-white/40">加载中…</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {coffee.map((t) => (
              <RecipeCard key={t.file} t={t} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-base font-medium mb-3">茶模板（Omni Tea Brewer）</h2>
        <div className="grid grid-cols-2 gap-3">
          {tea.map((t) => (
            <RecipeCard key={t.file} t={t} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-base font-medium mb-3">配方校验</h2>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <div className="flex gap-3">
            <input
              value={validatePath}
              onChange={(e) => setValidatePath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doValidate()}
              placeholder="本地配方文件路径，如 assets/hot-template.yaml"
              className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder:text-white/30 focus:outline-none focus:border-white/30"
            />
            <button
              onClick={doValidate}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "校验中…" : "校验"}
            </button>
          </div>
          {result && (
            <div className="mt-4">
              {result.valid ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                  校验通过
                  {result.summary && (
                    <pre className="mt-2 text-xs text-emerald-200/70 overflow-auto">
                      {JSON.stringify(result.summary, null, 2)}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  校验失败：{result.error}
                  {result.type && <span className="block text-xs text-red-300/60 mt-1">{result.type}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RecipeCard({ t }: { t: Template }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 hover:bg-white/[0.04] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium">{t.name || t.file}</div>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 shrink-0">
          {t.kind}
        </span>
      </div>
      <div className="mt-2 text-xs text-white/40 space-y-0.5">
        {t.dose_g !== null && <div>粉量 {t.dose_g} g · {t.pours} 段注水</div>}
        {t.leaf_g !== null && <div>叶量 {t.leaf_g} g · {t.pours} 段</div>}
        {t.water_ml !== null && <div>水量 {t.water_ml} ml</div>}
      </div>
      <code className="block mt-2 text-[11px] text-white/30 truncate">{t.file}</code>
    </div>
  );
}
