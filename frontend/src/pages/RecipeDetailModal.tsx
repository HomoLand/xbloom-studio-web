import { useEffect } from "react";
import type { CatalogEntryDetail, Pour } from "../api";

const ORIGIN: Record<string, string> = {
  "xbloom-hosted": "xBloom 官方",
  "user-created": "自创",
  shared: "分享",
  xpod: "xPod",
  curated: "精选",
  "easy-mode": "易用模式",
  "app-catalog": "App 目录",
  xbloom: "xBloom",
};

export function RecipeDetailModal({
  detail,
  loading,
  onClose,
}: {
  detail: CatalogEntryDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const r = detail?.recipe;
  const pours = (r?.pours as Pour[] | undefined) ?? [];
  const isTea = detail?.kind === "tea";
  const warns = (detail?.warnings as string[] | undefined) ?? [];
  const errs = (detail?.validation_errors as string[] | undefined) ?? [];

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div onClick={(e) => e.stopPropagation()} className="rounded-2xl border border-white/10 bg-[#15171c] max-w-2xl w-full max-h-[80vh] overflow-auto">
        {loading ? (
          <div className="p-8 text-sm text-white/40">加载中…</div>
        ) : detail ? (
          <div className="p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold">{detail.name ?? "—"}</h2>
                <div className="text-xs text-white/40 mt-1">
                  {isTea ? "茶" : "咖啡"} · {ORIGIN[detail.origin ?? ""] ?? detail.origin} · {detail.cup_type ?? "—"}
                </div>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white text-xl leading-none px-2">×</button>
            </div>
            <div className="flex gap-2 mb-4">
              <span className={`text-xs px-2 py-1 rounded ${detail.executable ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-white/40"}`}>
                {detail.executable ? "可执行" : "仅参考"}
              </span>
              {detail.executable && (
                <span className={`text-xs px-2 py-1 rounded ${detail.slot_compatible ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                  {detail.slot_compatible ? "槽位兼容" : "槽位不兼容"}
                </span>
              )}
            </div>
            {/*PLACEHOLDER_RECIPE*/}
            {r && (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mb-4">
                <div className="grid grid-cols-3 gap-3 text-sm">
                  {!isTea && r.dose_g != null && <Field label="粉量" value={`${r.dose_g} g`} />}
                  {!isTea && r.grind != null && <Field label="研磨度" value={String(r.grind)} />}
                  {!isTea && r.water_ml != null && <Field label="总水量" value={`${r.water_ml} ml`} />}
                  {!isTea && r.dripper && <Field label="滤杯" value={String(r.dripper)} />}
                  {!isTea && r.ratio != null && <Field label="比例" value={`1:${r.ratio}`} />}
                  {isTea && r.leaf_g != null && <Field label="叶量" value={`${r.leaf_g} g`} />}
                  {isTea && r.output_ml_per_steep != null && <Field label="每泡出水量" value={`${r.output_ml_per_steep} ml`} />}
                  {r.bypass_ml != null && Number(r.bypass_ml) > 0 && <Field label="旁路水" value={`${r.bypass_ml} ml`} />}
                </div>
              </div>
            )}
            {/*PLACEHOLDER_POURS*/}
            {pours.length > 0 && (
              <div className="mb-4">
                <h3 className="text-sm font-medium mb-2">注水方案（{pours.length} 段）</h3>
                <div className="rounded-xl border border-white/10 overflow-hidden overflow-x-auto">
                  <table className="w-full text-xs whitespace-nowrap">
                    <thead className="bg-white/[0.03] text-white/40">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">#</th>
                        <th className="text-left px-3 py-2 font-medium">水量</th>
                        <th className="text-left px-3 py-2 font-medium">温度</th>
                        <th className="text-left px-3 py-2 font-medium">模式</th>
                        <th className="text-left px-3 py-2 font-medium">暂停</th>
                        <th className="text-left px-3 py-2 font-medium">流速</th>
                        {!isTea && <th className="text-left px-3 py-2 font-medium">振动</th>}
                        {!isTea && <th className="text-left px-3 py-2 font-medium">RPM</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {pours.map((p, i) => (
                        <tr key={i} className="border-t border-white/5">
                          <td className="px-3 py-2 text-white/50">{p.label ?? i + 1}</td>
                          <td className="px-3 py-2">{p.ml} ml</td>
                          <td className="px-3 py-2">{p.temp_c}°C</td>
                          <td className="px-3 py-2 text-white/60">{p.pattern}</td>
                          <td className="px-3 py-2 text-white/60">{p.pause_s}s</td>
                          <td className="px-3 py-2 text-white/60">{p.flow_ml_s}</td>
                          {!isTea && <td className="px-3 py-2 text-white/60">{p.vibration ?? "—"}</td>}
                          {!isTea && <td className="px-3 py-2 text-white/60">{p.rpm ?? "—"}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {/*PLACEHOLDER_WARN*/}
            {warns.length > 0 && (
              <div className="mb-3">
                <h3 className="text-xs font-medium text-amber-400/80 mb-1.5">警告</h3>
                <ul className="space-y-1">
                  {warns.map((w, i) => (
                    <li key={i} className="text-xs text-white/50 leading-relaxed">· {w}</li>
                  ))}
                </ul>
              </div>
            )}
            {errs.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-red-400/80 mb-1.5">校验问题</h3>
                <ul className="space-y-1">
                  {errs.map((e, i) => (
                    <li key={i} className="text-xs text-white/50 leading-relaxed">· {e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-8 text-sm text-white/40">加载失败</div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-white/40">{label}</div>
      <div className="text-sm font-medium mt-0.5">{value}</div>
    </div>
  );
}
