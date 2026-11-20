import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type * as React from "react";
import { History, LogOut, PhoneCall, Settings2, Smartphone, Users, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { LiveUpdates } from "./components/LiveUpdates";

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
      <LiveUpdates />
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

/** "2m ago" style, for the phone status box. */
function shortAgo(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The rep's Android phone heartbeat (the app reports in at least hourly). Says nothing about Phone Link. */
function PhoneStatusBox() {
  const q = useQuery({ queryKey: ["me-phone"], queryFn: () => api<PhoneStatus>("/api/me/phone"), refetchInterval: 60_000 });
  if (!q.data) return <Skeleton className="h-12 w-full bg-white/10" />;
  const p = q.data;
  const text = !p.lastSeenAt
    ? "No phone signed in"
    : p.online
      ? `Phone online · seen ${shortAgo(p.lastSeenAt)}`
      : `Phone offline since ${shortAgo(p.lastSeenAt)}`;
  const box = (
    <div role="status" tabIndex={p.model ? 0 : undefined} className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
      <span className="flex items-center gap-2 font-medium">
        <Smartphone aria-hidden className="size-4 shrink-0" />
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${p.online ? "bg-green-400" : "bg-slate-400"}`} />
        {text}
      </span>
      {p.model && <span className="mt-0.5 block truncate text-white/60">{p.model} · calls use its SIM</span>}
    </div>
  );
  if (!p.model) return box;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{box}</TooltipTrigger>
      <TooltipContent side="right">
        {p.model}
        {p.appVersion ? ` · app ${p.appVersion}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

const NAV_ICON: Record<string, LucideIcon> = { "/today": PhoneCall, "/activity": Users, "/calls": History, "/admin": Settings2 };

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    // Only drop the local session once the server has cleared the cookie.
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(["me"], null);
    },
    onError: (e) => toast.error(`Sign out failed: ${e.message}`),
  });
  const items = navItems(me);
  const { pathname } = useLocation();
  const role = me.role.charAt(0) + me.role.slice(1).toLowerCase();
  const logo = (
    <span className="flex items-center gap-2 font-semibold text-white">
      <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-sidebar-primary text-xs">
        UIC
      </span>
      UIC Dialer
    </span>
  );

  return (
    <SidebarProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      <AppSidebar me={me} role={role} items={items} pathname={pathname} logo={logo} logout={() => logout.mutate()} loggingOut={logout.isPending} />
      <SidebarInset>
        {/* Small screens: navy top bar; the menu opens the sidebar as a sheet. */}
        <header className="sticky top-0 z-30 bg-sidebar pt-[env(safe-area-inset-top)] md:hidden">
          <div className="flex h-14 items-center gap-3 px-4">
            {logo}
            <SidebarTrigger className="ml-auto text-white hover:bg-white/10 hover:text-white" />
          </div>
        </header>
        <div id="main" className="mx-auto w-full max-w-6xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-8">
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
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({
  me,
  role,
  items,
  pathname,
  logo,
  logout,
  loggingOut,
}: {
  me: Me;
  role: string;
  items: ReturnType<typeof navItems>;
  pathname: string;
  logo: React.ReactNode;
  logout: () => void;
  loggingOut: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar title="UIC Dialer menu">
      <SidebarHeader>
        {logo}
        <PhoneStatusBox />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          <SidebarMenu>
            {items.map((i) => {
              const Icon = NAV_ICON[i.to] ?? Settings2;
              const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
              const active = i.end ? pathname === i.to : under(i.to) || !!i.also?.some(under);
              return (
                <SidebarMenuItem key={i.to}>
                  <SidebarMenuButton asChild isActive={active}>
                    <NavLink to={i.to} end={i.end} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)}>
                      <Icon aria-hidden />
                      {i.label}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <div className="px-3 text-xs text-white/80">
          <div className="truncate font-medium text-white">{me.name || me.email}</div>
          <div>
            {role}
            {me.team ? ` · ${me.team}` : ""}
          </div>
        </div>
        <SidebarMenuButton disabled={loggingOut} onClick={logout}>
          <LogOut aria-hidden />
          Sign out
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  );
}
