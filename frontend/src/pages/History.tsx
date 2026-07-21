import { useEffect, useState } from "react";
import { api, type HistoryEvent, type HistoryStatus } from "../api";

const outcomeColor: Record<string, string> = {
  completed: "text-emerald-400",
  loaded: "text-sky-400",
  started: "text-amber-400",
  cancelled: "text-white/40",
  failed: "text-red-400",
  completion_unconfirmed: "text-orange-400",
  imported: "text-white/50",
};

export default function History() {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.historyStatus(), api.historyList(50)])
      .then(([s, l]) => {
        setStatus(s);
        setEvents(l.events);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">冲煮历史</h1>
      <p className="text-sm text-white/40 mb-6">本地 brew journal，用于 dial-in 复盘</p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {status && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Stat label="总记录" value={status.total} />
          <Stat label="本地" value={status.by_source["local-skill"] ?? 0} />
          <Stat label="App 导入" value={status.by_source["app-cloud"] ?? 0} />
        </div>
      )}

      {loading ? (
        <div className="text-sm text-white/40">加载中…</div>
      ) : events.length === 0 ? (
        <div className="text-sm text-white/40">暂无历史记录</div>
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <div
              key={e.event_id}
              className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`text-xs font-medium ${outcomeColor[e.outcome] ?? "text-white/60"}`}>
                    {e.outcome}
                  </span>
                  <span className="text-sm truncate">{e.recipe_name ?? e.event_id}</span>
                </div>
                <span className="text-xs text-white/30 shrink-0">
                  {e.recorded_at?.replace("T", " ").slice(0, 19) ?? ""}
                </span>
              </div>
              {e.note && (
                <div className="mt-1.5 text-xs text-white/50 italic">{e.note}</div>
              )}
            </div>
          ))}
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
