import { Link } from "react-router";
import { useMe } from "../App";
import { PageHeader } from "../ui";

interface AdminLink {
  to: string;
  label: string;
  text: string;
}

/** One place for everything that isn't calling: managers and admins reach their tools from here. */
export function AdminPage() {
  const me = useMe();
  const links: AdminLink[] = [
    { to: "/lists", label: "Call lists", text: "Create lists, assign reps, see progress and results." },
    { to: "/team", label: "Team", text: "Calls, talk time and targets for each rep." },
    { to: "/health", label: "Sync health", text: "Phones, uploads, transcription and alerts." },
    { to: "/users", label: "Users", text: "People, roles, teams and phones." },
  ];
  if (me.role === "MANAGER") links.push({ to: "/settings/dnc", label: "Do-not-call", text: "Numbers nobody should call." });
  if (me.role === "ADMIN")
    links.push(
      { to: "/settings", label: "Settings", text: "Outcomes, scripts, templates, lead sources, do-not-call, privacy." },
      { to: "/audit", label: "Audit log", text: "Who played, downloaded or changed what." },
    );
  return (
    <>
      <PageHeader title="Admin" subtitle="Everything besides calling." />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="card block h-full p-4 hover:border-brand-600 focus-visible:outline-2 focus-visible:outline-brand-600">
              <span className="font-semibold text-brand-700">{l.label}</span>
              <span className="mt-1 block text-sm text-slate-600">{l.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
