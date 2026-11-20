import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { ApiError, api, isManager, type Me, type PhoneStatus } from "./api";
import { FirefliesBanner } from "./components/Fireflies";
import { CallDetailPage } from "./pages/CallDetail";
import { DialerProvider } from "./dialer";
import { AdminPage } from "./pages/Admin";
import { AuditPage } from "./pages/Audit";
import { CallsPage } from "./pages/Calls";
import { ContactDetailPage } from "./pages/ContactDetail";
import { ContactsPage } from "./pages/Contacts";
import { HealthPage } from "./pages/Health";
import { ListDetailPage, ListSessionPage, ListsPage } from "./pages/Lists";
import { SettingsPage } from "./pages/Settings";
import { DncTab } from "./pages/settings/Dnc";
import { TeamPage } from "./pages/Team";
import { SignInPage } from "./pages/SignIn";
import { TodayPage } from "./pages/Today";
import { UsersPage } from "./pages/Users";
import { ErrorBox, Spinner } from "./ui";

const MeContext = createContext<Me | null>(null);
export const useMe = () => {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside the signed-in app");
  return me;
};

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<Me>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });

  if (me.isPending) return <Spinner />;
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-4 pt-16">
        <ErrorBox error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  if (!me.data) return <SignInPage />;

  return (
    <MeContext.Provider value={me.data}>
      <DialerProvider>
        <Shell me={me.data} />
      </DialerProvider>
    </MeContext.Provider>
  );
}

/** Reps see three pages; admins and managers get one more entry, Admin, that holds everything else. */
function navItems(me: Me) {
  const items: { to: string; label: string; end?: boolean; also?: string[] }[] = [
    { to: "/today", label: "Today" },
    { to: "/activity", label: "Contacts", end: true },
    { to: "/calls", label: "Calls" },
  ];
  if (isManager(me.role)) items.push({ to: "/admin", label: "Admin", also: ADMIN_PATHS });
  return items;
}

/** Pages that live under Admin (the Admin entry stays highlighted on them). */
const ADMIN_PATHS = ["/lists", "/team", "/health", "/users", "/settings", "/audit"];

/** "2m ago" style, for the phone pill. */
function shortAgo(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The rep's Android phone heartbeat (the app reports in at least hourly). Says nothing about Phone Link. */
function PhoneStatusPill() {
  const q = useQuery({ queryKey: ["me-phone"], queryFn: () => api<PhoneStatus>("/api/me/phone"), refetchInterval: 60_000 });
  if (!q.data) return null;
  const p = q.data;
  const text = !p.lastSeenAt
    ? "No phone signed in"
    : p.online
      ? `Phone online · seen ${shortAgo(p.lastSeenAt)}`
      : `Phone offline since ${shortAgo(p.lastSeenAt)}`;
  return (
    <div role="status" className="rounded-xl bg-white/10 px-3 py-2 text-xs text-white/90" title={p.model ? `${p.model}${p.appVersion ? ` · app ${p.appVersion}` : ""}` : undefined}>
      <span className="flex items-center gap-2 font-medium">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${p.online ? "bg-green-400" : "bg-slate-400"}`} />
        {text}
      </span>
      {p.model && <span className="mt-0.5 block truncate text-white/60">{p.model} · calls use its SIM</span>}
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    // Only drop the local session once the server has cleared the cookie.
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(["me"], null);
    },
    onError: (e) => alert(`Sign out failed: ${e.message}`),
  });
  const items = navItems(me);
  const { pathname } = useLocation();
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-10 items-center rounded-xl px-3 text-sm font-medium ${
      isActive ? "bg-white/15 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"
    }`;
  const role = me.role.charAt(0) + me.role.slice(1).toLowerCase();
  const nav = (onPick?: () => void) =>
    items.map((i) => (
      <NavLink
        key={i.to}
        to={i.to}
        end={i.end}
        className={({ isActive }) => linkCls({ isActive: isActive || !!i.also?.some((p) => pathname === p || pathname.startsWith(`${p}/`)) })}
        onClick={onPick}
      >
        {i.label}
      </NavLink>
    ));
  const logo = (
    <span className="flex items-center gap-2 font-semibold text-white">
      <span aria-hidden className="grid size-8 place-items-center rounded-xl bg-brand-600 text-xs">
        UIC
      </span>
      UIC Dialer
    </span>
  );

  return (
    <div className="min-h-dvh md:pl-60">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      {/* Desktop: navy sidebar. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-4 bg-navy p-4 md:flex">
        {logo}
        <PhoneStatusPill />
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {nav()}
        </nav>
        <div className="border-t border-white/15 pt-3 text-xs text-white/80">
          <div className="truncate font-medium text-white">{me.name || me.email}</div>
          <div>
            {role}
            {me.team ? ` · ${me.team}` : ""}
          </div>
          <button
            type="button"
            className="mt-2 min-h-10 w-full rounded-xl px-3 text-left text-sm font-medium text-white/80 hover:bg-white/10 hover:text-white"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Sign out
          </button>
        </div>
      </aside>
      {/* Small screens: top bar with a menu. */}
      <header className="sticky top-0 z-30 bg-navy pt-[env(safe-area-inset-top)] md:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          {logo}
          <button
            type="button"
            className="ml-auto grid size-11 place-items-center rounded-xl text-white hover:bg-white/10"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label="Menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
            </svg>
          </button>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" aria-label="Main" className="flex flex-col gap-1 border-t border-white/15 px-4 py-3">
            <div className="px-3 pb-2 text-xs text-white/70">
              {me.name || me.email} · {me.role.toLowerCase()}
            </div>
            <PhoneStatusPill />
            {nav(() => setMenuOpen(false))}
            <button
              type="button"
              className="mt-2 min-h-10 rounded-xl border border-white/30 px-3 text-sm font-medium text-white hover:bg-white/10"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-8">
        {isManager(me.role) && <FirefliesBanner />}
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/dialer" element={<Navigate to="/today" replace />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/calls/:id" element={<CallDetailPage />} />
          <Route path="/activity" element={<ContactsPage />} />
          <Route path="/activity/contacts/:id" element={<ContactDetailPage />} />
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/lists/:id" element={<ListDetailPage />} />
          <Route path="/lists/:id/work" element={<ListSessionPage />} />
          {isManager(me.role) && <Route path="/admin" element={<AdminPage />} />}
          {isManager(me.role) && <Route path="/team" element={<TeamPage />} />}
          {isManager(me.role) && <Route path="/activity/reps" element={<Navigate to="/team" replace />} />}
          {isManager(me.role) && <Route path="/health" element={<HealthPage />} />}
          {isManager(me.role) && <Route path="/users" element={<UsersPage />} />}
          {me.role === "ADMIN" && <Route path="/settings/*" element={<SettingsPage />} />}
          {me.role === "MANAGER" && <Route path="/settings/dnc" element={<DncTab standalone />} />}
          {me.role === "ADMIN" && <Route path="/audit" element={<AuditPage />} />}
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
      </main>
    </div>
  );
}
