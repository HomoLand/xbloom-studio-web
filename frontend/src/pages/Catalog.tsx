import { useEffect, useState } from "react";
import { api, type CatalogEntry, type CatalogStatus } from "../api";

export default function Catalog() {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [kind, setKind] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (k: string) => {
    setLoading(true);
    setError(null);
    try {
      const [s, l] = await Promise.all([api.catalogStatus(), api.catalogList(k || undefined)]);
      setStatus(s);
      setEntries(l.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(kind);
  }, [kind]);

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">私有目录</h1>
      <p className="text-sm text-white/40 mb-6">从授权 App/MMKV 导入的归一化配方</p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {status && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <Stat label="总数" value={status.total} />
          <Stat label="咖啡" value={status.coffee} />
          <Stat label="茶" value={status.tea} />
          <Stat label="可执行" value={status.executable} />
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {["", "coffee", "tea"].map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              kind === k ? "bg-white/15 text-white" : "bg-white/5 text-white/50 hover:bg-white/10"
            }`}
          >
            {k === "" ? "全部" : k === "coffee" ? "咖啡" : "茶"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-white/40">加载中…</div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-white/40">暂无条目</div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-white/40 text-xs">
              <tr>
                <th className="text-left px-4 py-2 font-medium">名称</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">来源</th>
                <th className="text-left px-4 py-2 font-medium">可执行</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.id ?? e.table_id ?? i} className="border-t border-white/5">
                  <td className="px-4 py-2.5">{e.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-white/60">{e.kind ?? "—"}</td>
                  <td className="px-4 py-2.5 text-white/60">{e.origin ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {e.executable ? (
                      <span className="text-emerald-400">是</span>
                    ) : (
                      <span className="text-white/30">否</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-white/40 mt-1">{label}</div>
    </div>
  );
}
