import { useEffect, useState } from "react";
import { api, type Template, type CatalogEntry, type ValidateResult } from "../api";

const ORIGIN_LABELS: Record<string, string> = {
  "xbloom-hosted": "xBloom 官方",
  "user-created": "自创",
  shared: "分享",
  xpod: "xPod",
  curated: "精选",
  "easy-mode": "易用模式",
  "app-catalog": "App 目录",
  xbloom: "xBloom",
};

export default function Recipes() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [validatePath, setValidatePath] = useState("");
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.templates().then((r) => r.templates).catch(() => [] as Template[]),
      api.catalogList().then((r) => r.entries).catch(() => [] as CatalogEntry[]),
    ])
      .then(([t, c]) => {
        setTemplates(t);
        setCatalogEntries(c);
      })
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

  const coffeeTemplates = templates.filter((t) => !t.tea);
  const teaTemplates = templates.filter((t) => t.tea);
  const coffeeCatalog = catalogEntries.filter((e) => e.kind === "coffee");
  const teaCatalog = catalogEntries.filter((e) => e.kind === "tea");

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">配方库</h1>
      <p className="text-sm text-white/40 mb-6">
        内置模板、私有目录配方与配方校验
      </p>

      {/* 内置模板 */}
      <section className="mb-8">
        <h2 className="text-base font-medium mb-3">咖啡模板</h2>
        {loading ? (
          <div className="text-sm text-white/40">加载中…</div>
        ) : coffeeTemplates.length === 0 ? (
          <div className="text-sm text-white/30">暂无内置咖啡模板</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {coffeeTemplates.map((t) => (
              <TemplateCard key={t.file} t={t} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-base font-medium mb-3">茶模板（Omni Tea Brewer）</h2>
        {loading ? (
          <div className="text-sm text-white/40">加载中…</div>
        ) : teaTemplates.length === 0 ? (
          <div className="text-sm text-white/30">暂无内置茶模板</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {teaTemplates.map((t) => (
              <TemplateCard key={t.file} t={t} />
            ))}
          </div>
        )}
      </section>

      {/* 私有目录 */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-medium">私有目录</h2>
          <span className="text-xs text-white/30">
            从授权 App / 云端导入的归一化配方
          </span>
        </div>
        {loading ? (
          <div className="text-sm text-white/40">加载中…</div>
        ) : catalogEntries.length === 0 ? (
          <div className="text-sm text-white/30">
            私有目录为空。通过 Skill 导入 App 配方后会在此展示。
          </div>
        ) : (
          <div className="space-y-6">
            {coffeeCatalog.length > 0 && (
              <div>
                <div className="text-xs text-white/40 mb-2">
                  咖啡 · {coffeeCatalog.length} 条
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {coffeeCatalog.map((e, i) => (
                    <CatalogCard key={e.id ?? e.table_id ?? i} e={e} />
                  ))}
                </div>
              </div>
            )}
            {teaCatalog.length > 0 && (
              <div>
                <div className="text-xs text-white/40 mb-2">
                  茶 · {teaCatalog.length} 条
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {teaCatalog.map((e, i) => (
                    <CatalogCard key={e.id ?? e.table_id ?? i} e={e} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 配方校验 */}
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
                  {result.type && (
                    <span className="block text-xs text-red-300/60 mt-1">
                      {result.type}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function TemplateCard({ t }: { t: Template }) {
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

function CatalogCard({ e }: { e: CatalogEntry }) {
  const origin = e.origin ?? "unknown";
  const originLabel = ORIGIN_LABELS[origin] ?? origin;
  const executable = !!e.executable;
  const slotOk = !!e.slot_compatible;
  const errors = (e.validation_errors as string[] | undefined) ?? [];
  const reason = errors[0];

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 hover:bg-white/[0.04] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium truncate">{e.name ?? "—"}</div>
        <div className="flex gap-1 shrink-0">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50">
            {originLabel}
          </span>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {executable ? (
          <span className="text-emerald-400">可执行</span>
        ) : (
          <span className="text-white/30">仅参考</span>
        )}
        {executable && (
          <span className={slotOk ? "text-emerald-400/70" : "text-amber-400/70"}>
            {slotOk ? "· 槽位兼容" : "· 槽位不兼容"}
          </span>
        )}
        {e.cup_type && (
          <span className="text-white/30">· {e.cup_type}</span>
        )}
      </div>
      {!executable && reason && (
        <div className="mt-1.5 text-[11px] text-white/30 line-clamp-2">
          {reason}
        </div>
      )}
      {e.author && (
        <div className="mt-1.5 text-[11px] text-white/30">作者 {e.author}</div>
      )}
    </div>
  );
}
