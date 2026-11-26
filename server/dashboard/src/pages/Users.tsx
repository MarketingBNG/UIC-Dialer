import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Role, type User } from "../api";
import { useMe } from "../App";
import { formatWhen } from "../format";
import { Empty, ErrorBox, FormError, Hint, PageHeader, Spinner } from "../ui";
import { Pencil, UserPlus, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { BlockedEmails } from "../components/BlockedEmails";

const ROLES: Role[] = ["AGENT", "MANAGER", "ADMIN"];
const roleLabel = (r: Role) => r.charAt(0) + r.slice(1).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function UsersPage() {
  const me = useMe();
  const isAdmin = me.role === "ADMIN";
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [filter, setFilter] = useState("");

  const list = (users.data ?? []).filter((u) => {
    const f = filter.trim().toLowerCase();
    return !f || u.email.includes(f) || (u.name ?? "").toLowerCase().includes(f) || (u.team ?? "").toLowerCase().includes(f);
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={isAdmin ? "Who can sign in, their role and team." : "Read-only. Only admins can change users."}
        actions={
          isAdmin && (
            <Button onClick={() => setAdding(true)}>
              <UserPlus /> Add user
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Label htmlFor="user-filter" className="sr-only">
          Filter users
        </Label>
        <Input id="user-filter" type="search" className="sm:max-w-xs" placeholder="Filter by name, email or team" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {users.isPending ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
      ) : list.length === 0 ? (
        <Empty
          icon={<Users />}
          action={
            !filter && isAdmin ? (
              <Button onClick={() => setAdding(true)}>
                <UserPlus /> Add user
              </Button>
            ) : undefined
          }
        >
          {filter ? "No users match. Try a different name, email or team." : "No users yet. Add someone by their company Google email so they can sign in."}
        </Empty>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead>Last sign-in</TableHead>
                {isAdmin && <TableHead className="sr-only">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="max-w-72">
                    <div className="truncate font-medium">{u.name || u.email}</div>
                    {u.name && <div className="truncate text-xs text-muted-foreground">{u.email}</div>}
                    {u.excludedNumbers.length > 0 && <div className="text-xs text-muted-foreground">{u.excludedNumbers.length} excluded numbers</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={u.role === "ADMIN" ? "blue" : u.role === "MANAGER" ? "amber" : "gray"}>{roleLabel(u.role)}</Badge>
                      {!u.active && <Badge variant="red">Deactivated</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.team || "No team"}</TableCell>
                  <TableCell className="text-right tabular-nums">{u._count?.calls ?? 0}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{u.lastLoginAt ? formatWhen(u.lastLoginAt) : "Never"}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" className="min-h-10" onClick={() => setEditing(u)} aria-label={`Edit ${u.name || u.email}`}>
                        <Pencil /> Edit
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {isAdmin && <BlockedEmails />}
      {isAdmin && <AddUserDialog open={adding} onClose={() => setAdding(false)} />}
      {isAdmin && editing && <EditUserDialog key={editing.id} user={editing} isSelf={editing.id === me.id} onClose={() => setEditing(null)} />}
    </>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [role, setRole] = useState<Role>("AGENT");
  const add = useMutation({
    mutationFn: () =>
      api<User>("/api/users", {
        method: "POST",
        body: { email: email.trim(), role, ...(name.trim() ? { name: name.trim() } : {}), ...(team.trim() ? { team: team.trim() } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      close();
    },
  });
  const close = () => {
    setEmail("");
    setName("");
    setTeam("");
    setRole("AGENT");
    add.reset();
    onClose();
  };
  const valid = EMAIL_RE.test(email.trim());
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !add.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>They sign in with this Google account. Nothing is sent to them.</DialogDescription>
        </DialogHeader>
      <form
        id="add-user"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) add.mutate();
        }}
      >
        <div>
          <Label htmlFor="nu-email">
            Google email
          </Label>
          <Input id="nu-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="nu-name">
            Name (optional)
          </Label>
          <Input id="nu-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="nu-team">
            Team (optional)
          </Label>
          <Input id="nu-team" maxLength={100} value={team} onChange={(e) => setTeam(e.target.value)} />
        </div>
        <RolePicker value={role} onChange={setRole} />
        <FormError error={add.error} />
      </form>
        <DialogFooter>
          <Button variant="ghost" disabled={add.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="add-user" disabled={!valid || add.isPending}>
            {add.isPending ? "Adding…" : "Add user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <div>
      <Label htmlFor="role-picker">Role</Label>
      <NativeSelect id="role-picker" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} aria-describedby="role-picker-hint">
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </NativeSelect>
      <Hint id="role-picker-hint">Agents see their own calls. Managers see their team's calls. Admins see everything and manage settings.</Hint>
    </div>
  );
}

function EditUserDialog({ user, isSelf, onClose }: { user: User; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.name ?? "");
  const [team, setTeam] = useState(user.team ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [numbersText, setNumbersText] = useState(user.excludedNumbers.join("\n"));
  const numbers = numbersText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const numbersOk = numbers.length <= 500 && numbers.every((n) => n.length <= 40);

  const save = useMutation({
    mutationFn: () =>
      api<User>(`/api/users/${user.id}`, {
        method: "PATCH",
        body: {
          name: name.trim() || null,
          team: team.trim() || null,
          role,
          active,
          excludedNumbers: numbers,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
      <form
        id="edit-user"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (numbersOk) save.mutate();
        }}
      >
        <div>
          <Label htmlFor="eu-name">
            Name
          </Label>
          <Input id="eu-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="eu-team">
            Team (blank = none)
          </Label>
          <Input id="eu-team" maxLength={100} value={team} onChange={(e) => setTeam(e.target.value)} />
        </div>
        <RolePicker value={role} onChange={setRole} disabled={isSelf} />
        <div className="flex min-h-11 items-center justify-between gap-3">
          <Label htmlFor="eu-active" className="mb-0">
            Can sign in (active)
          </Label>
          <Switch id="eu-active" checked={active} disabled={isSelf} onCheckedChange={setActive} />
        </div>
        {isSelf && <Hint>You can't change your own role or deactivate yourself.</Hint>}
        {!active && user.active && <Hint className="text-amber-700">Deactivating signs this user out on all phones right away.</Hint>}
        <div>
          <Label htmlFor="eu-numbers">
            Excluded numbers, one per line
          </Label>
          <Textarea id="eu-numbers" rows={5} className="font-mono" value={numbersText} onChange={(e) => setNumbersText(e.target.value)} aria-describedby="eu-numbers-hint" />
          <Hint id="eu-numbers-hint" className={numbersOk ? "" : "text-destructive"}>
            Calls with these numbers are never uploaded. {numbers.length}/500
          </Hint>
        </div>
        <FormError error={save.error} />
      </form>
        <DialogFooter>
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-user" disabled={!numbersOk || save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
