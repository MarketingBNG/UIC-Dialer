import { Activity, ChevronRight, ClipboardList, PhoneOff, ScrollText, Settings, UserCog, Users, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { Card } from "@/components/ui/card";
import { useMe } from "../App";
import { PageHeader } from "../ui";

interface AdminLink {
  to: string;
  label: string;
  text: string;
  icon: LucideIcon;
}

/** One place for everything that isn't calling: managers and admins reach their tools from here. */
export function AdminPage() {
  const me = useMe();
  const links: AdminLink[] = [
    { to: "/lists", label: "Call lists", text: "Create lists, assign reps, see progress and results.", icon: ClipboardList },
    { to: "/team", label: "Team", text: "Calls, talk time and targets for each rep.", icon: Users },
    { to: "/health", label: "Sync health", text: "Phones, uploads, transcription and alerts.", icon: Activity },
    { to: "/users", label: "Users", text: "People, roles, teams and phones.", icon: UserCog },
  ];
  if (me.role === "MANAGER") links.push({ to: "/settings/dnc", label: "Do-not-call", text: "Numbers nobody should call.", icon: PhoneOff });
  if (me.role === "ADMIN")
    links.push(
      { to: "/settings", label: "Settings", text: "Outcomes, scripts, templates, lead sources, do-not-call, privacy.", icon: Settings },
      { to: "/audit", label: "Audit log", text: "Who played, downloaded or changed what.", icon: ScrollText },
    );
  return (
    <>
      <PageHeader title="Admin" subtitle="Manage lists, people and settings. Pick an area to open it." />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Card className="flex h-full items-start gap-3 p-4 transition-colors group-hover:border-primary">
                <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                  <l.icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-foreground">{l.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{l.text}</span>
                </span>
                <ChevronRight aria-hidden className="mt-2 size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
