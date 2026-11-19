import { useQuery } from "@tanstack/react-query";
import { api, isManager, type Me, type User } from "../api";
import { personName } from "../format";

/** Active users the signed-in manager may assign (admins: everyone; managers: themselves and their team). */
export function useAssignableUsers(me: Me) {
  // The users list is a managers' endpoint; reps never pick other users.
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: isManager(me.role) });
  const items = (users.data ?? []).filter((u) => u.active && (me.role === "ADMIN" || u.id === me.id || (!!me.team && u.team === me.team)));
  return { items, isPending: users.isPending, error: users.error };
}

/** Checkbox list of users. */
export function UserMultiSelect({ users, value, onChange, label }: { users: User[]; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const set = new Set(value);
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
        {users.length === 0 ? (
          <p className="hint">No users.</p>
        ) : (
          users.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <input
                type="checkbox"
                className="size-4 accent-brand-600"
                checked={set.has(u.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((id) => id !== u.id))}
              />
              <span className="truncate">{personName(u)}</span>
              {u.team && <span className="text-xs text-slate-500">{u.team}</span>}
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
