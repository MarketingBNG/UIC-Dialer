import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
      <legend className="mb-1.5 text-sm font-medium text-slate-700">{label}</legend>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
        {users.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active users to pick from.</p>
        ) : (
          users.map((u) => (
            <div key={u.id} className="flex min-h-10 items-center gap-2 rounded-md px-1 hover:bg-muted">
              <Checkbox
                id={`user-pick-${u.id}`}
                checked={set.has(u.id)}
                onCheckedChange={(c) => onChange(c === true ? [...value, u.id] : value.filter((id) => id !== u.id))}
              />
              <Label htmlFor={`user-pick-${u.id}`} className="mb-0 flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-normal">
                <span className="truncate">{personName(u)}</span>
                {u.team && <span className="text-xs text-muted-foreground">{u.team}</span>}
              </Label>
            </div>
          ))
        )}
      </div>
    </fieldset>
  );
}
