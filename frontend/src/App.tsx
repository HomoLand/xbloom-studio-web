import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Recipes from "./pages/Recipes";
import Catalog from "./pages/Catalog";
import History from "./pages/History";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/recipes", label: "配方库" },
  { to: "/catalog", label: "私有目录" },
  { to: "/history", label: "冲煮历史" },
];

export default function App() {
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-white/10 bg-[#0f1115] flex flex-col">
        <div className="px-5 py-5 border-b border-white/10">
          <div className="text-[15px] font-semibold tracking-tight">xBloom Studio</div>
          <div className="text-xs text-white/40 mt-0.5">Web Control</div>
        </div>
        <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:text-white hover:bg-white/5"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-white/10 text-[11px] text-white/30 leading-relaxed">
          非官方社区项目<br />BLE 协议逆向工程
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/history" element={<History />} />
        </Routes>
      </main>
    </div>
  );
}
