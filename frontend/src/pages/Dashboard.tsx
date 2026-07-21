import { useCallback, useEffect, useState } from "react";
import { api, type BridgeState, type ScanResult, type ProbeResult } from "../api";

type Summary = {
  templates: number;
  catalogTotal: number;
  historyTotal: number;
};

export default function Dashboard() {
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, t, c, h] = await Promise.all([
        api.bridge(),
        api.templates(),
        api.catalogStatus(),
        api.historyStatus(),
      ]);
      setBridge(b);
      setSummary({
        templates: t.templates.length,
        catalogTotal: c.total,
        historyTotal: h.total,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doScan = async () => {
    setBusy("scan");
    setError(null);
    try {
      setScan(await api.scan());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doProbe = async () => {
    setBusy("probe");
    setError(null);
    try {
      setProbe(await api.probe());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Dashboard</h1>
      <p className="text-sm text-white/40 mb-6">设备状态与本地能力概览</p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="配方模板" value={summary?.templates ?? "—"} />
        <StatCard label="私有目录" value={summary?.catalogTotal ?? "—"} />
        <StatCard label="冲煮历史" value={summary?.historyTotal ?? "—"} />
      </div>

      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-medium">BLE Bridge</h2>
          <button
            onClick={load}
            className="text-xs text-white/50 hover:text-white px-2 py-1 rounded hover:bg-white/5"
          >
            刷新
          </button>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          {bridge ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <Field label="运行状态" value={bridge.running ? "运行中" : "未运行"} />
              <Field label="已连接" value={bridge.connected ? "是" : "否"} />
              <Field label="机器" value={bridge.machine ?? "—"} />
              <Field label="固件" value={bridge.firmware ?? "—"} />
              <Field label="活动" value={bridge.activity ?? "空闲"} />
              <Field label="阶段" value={bridge.phase ?? "—"} />
            </div>
          ) : (
            <div className="text-sm text-white/40">加载中…</div>
          )}
          {!bridge?.running && (
            <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/40 leading-relaxed">
              Bridge 未运行。启动它以获得持久 BLE 控制（暂停/恢复、实时遥测）：
              <code className="ml-1 px-1.5 py-0.5 rounded bg-white/5 text-white/70">
                python scripts/xbloom.py bridge start
              </code>
            </div>
          )}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-medium mb-3">设备发现</h2>
        <div className="flex gap-3 mb-4">
          <button
            onClick={doScan}
            disabled={busy === "scan"}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
          >
            {busy === "scan" ? "扫描中…" : "扫描设备"}
          </button>
          <button
            onClick={doProbe}
            disabled={busy === "probe"}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium disabled:opacity-50"
          >
            {busy === "probe" ? "探测中…" : "探测机器"}
          </button>
        </div>

        {scan && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mb-3">
            <div className="text-sm text-white/50 mb-2">
              扫描到 {scan.count} 台设备
            </div>
            {scan.machines.length > 0 ? (
              <div className="space-y-1">
                {scan.machines.map((m) => (
                  <div key={m.address} className="flex justify-between text-sm">
                    <span>{m.name}</span>
                    <code className="text-white/40">{m.address}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-white/40">未发现 xBloom 设备。确认蓝牙已开启且机器在附近。</div>
            )}
          </div>
        )}

        {probe && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="text-sm text-white/50 mb-2">
              {probe.machine} · <code className="text-white/40">{probe.address}</code>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              {Object.entries(probe)
                .filter(([k]) => !["command", "address", "serial_number"].includes(k))
                .map(([k, v]) => (
                  <Field key={k} label={k} value={String(v)} />
                ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm text-white/40 mt-1">{label}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-white/40">{label}</span>
      <span className="text-white/80 text-right">{value}</span>
    </div>
  );
}
