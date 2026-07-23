import { NavLink, Outlet } from "react-router-dom";
import {
  Beaker,
  History as HistoryIcon,
  LayoutDashboard,
  Settings,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import { useMachine } from "../machine/MachineContext";
import { cx, StatusPill } from "./ui";

export function AppShell() {
  const { mode, session, config } = useAuth();
  const { driver, bleSnapshot } = useMachine();
  const { t } = useI18n();

  const NAV_ITEMS = [
    { to: "/", label: t("nav.dashboard"), icon: LayoutDashboard, end: true as const },
    { to: "/design", label: t("nav.design"), icon: Sparkles, end: false as const },
    { to: "/recipes", label: t("nav.recipes"), icon: Beaker, end: false as const },
    { to: "/tools", label: t("nav.tools"), icon: Wrench, end: false as const },
    { to: "/history", label: t("nav.history"), icon: HistoryIcon, end: false as const },
    { to: "/settings", label: t("nav.settings"), icon: Settings, end: false as const },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/80 backdrop-blur-md md:flex">
        <div className="border-b border-line px-4 py-4">
          <div className="text-[15px] font-semibold tracking-tight text-ink">
            {t("app.name")}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
            {mode ? (
              <StatusPill tone={mode === "lan" ? "blue" : "neutral"}>
                {mode}
              </StatusPill>
            ) : null}
            <StatusPill
              tone={driver === "web-bluetooth" ? "green" : "neutral"}
            >
              {driver === "web-bluetooth" ? "web-ble" : "bridge"}
            </StatusPill>
          </div>
          {driver === "web-bluetooth" ? (
            <div className="mt-2 rounded-xl bg-surface-2 px-2.5 py-2 text-[11px] leading-snug text-ink-muted">
              <span className="text-brand">{bleSnapshot.phase}</span>
              {bleSnapshot.machineStateName
                ? ` · ${bleSnapshot.machineStateName}`
                : ""}
              {bleSnapshot.cupWeightG != null
                ? ` · ${bleSnapshot.cupWeightG}g`
                : ""}
              {bleSnapshot.dispensedWaterMl != null
                ? ` · ${bleSnapshot.dispensedWaterMl}ml`
                : ""}
            </div>
          ) : null}
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2.5" aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                  isActive
                    ? "bg-surface-2 font-medium text-ink shadow-[inset_0_0_0_1px_var(--color-line)]"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink",
                )
              }
            >
              <item.icon
                className={cx(
                  "h-4 w-4 shrink-0",
                  "opacity-80",
                )}
                aria-hidden
              />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-3.5 py-3 text-[11px] leading-relaxed text-ink-faint">
          {session?.client_label ? (
            <div className="truncate text-ink-muted">{session.client_label}</div>
          ) : null}
          {config?.public_origin ? (
            <div className="mt-0.5 truncate">{config.public_origin}</div>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line bg-surface/90 px-4 py-3 backdrop-blur-md md:hidden">
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-ink">
              {t("app.name")}
            </div>
            <div className="text-[11px] text-ink-faint">
              {mode ?? "-"}
              {session?.client_label ? ` · ${session.client_label}` : ""}
            </div>
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl px-4 py-6 pb-28 md:px-6 md:pb-8">
            <Outlet />
          </div>
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur-xl md:hidden"
          aria-label="Main"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div className="mx-auto grid max-w-lg grid-cols-6">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    "flex flex-col items-center gap-0.5 px-0.5 py-2 text-[9px] font-medium",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40",
                    isActive ? "text-brand" : "text-ink-muted",
                  )
                }
              >
                <item.icon className="h-5 w-5" aria-hidden />
                <span className="truncate max-w-full">{item.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
