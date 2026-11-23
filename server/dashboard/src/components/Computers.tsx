import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Globe, Monitor } from "lucide-react";
import { api } from "../api";
import { ago, formatWhen, personName } from "../format";
import { Empty, ErrorBox, FormError, Spinner } from "../ui";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface WebSession {
  id: string;
  kind: "desktop" | "browser";
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  user: { id: string; name: string | null; email: string };
}

/** Computers signed in to the dashboard: the Windows app and browsers (used in the last 30 days). */
export function ComputersPanel({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["web-sessions"], queryFn: () => api<{ items: WebSession[] }>("/api/web-sessions") });
  const [confirm, setConfirm] = useState<WebSession | null>(null);
  const revoke = useMutation({
    mutationFn: (s: WebSession) => api<void>(`/api/web-sessions/${s.id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["web-sessions"] });
    },
  });
  const now = Date.now();
  const items = list.data ? [...list.data.items].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt)) : [];

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-lg font-semibold">Computers</h2>
      <p className="mb-3 text-sm text-muted-foreground">The Windows app and browsers signed in to the dashboard in the last 30 days.</p>
      {list.isPending ? (
        <Spinner label="Loading computers" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <Empty icon={<Monitor />}>No computers have signed in yet.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((s) => (
            <li key={s.id}>
              <Card className={`h-full p-4 ${s.revokedAt ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {s.kind === "desktop" ? <Monitor className="size-4 shrink-0 text-muted-foreground" /> : <Globe className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{personName(s.user)}</div>
                      <div className="truncate text-sm text-muted-foreground">{s.label ?? (s.kind === "desktop" ? "UIC Dialer for Windows" : "Browser")}</div>
                    </div>
                  </div>
                  {s.revokedAt ? <Badge variant="red">Signed out</Badge> : <Badge variant="green">Signed in</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd title={formatWhen(s.lastSeenAt)}>{ago(s.lastSeenAt, now)}</dd>
                  <dt className="text-muted-foreground">Signed in</dt>
                  <dd>{formatWhen(s.createdAt)}</dd>
                  {s.revokedAt && (
                    <>
                      <dt className="text-muted-foreground">Signed out</dt>
                      <dd>{formatWhen(s.revokedAt)}</dd>
                    </>
                  )}
                </dl>
                {isAdmin && !s.revokedAt && (
                  <Button variant="ghost" className="mt-3 -ml-3 px-3 text-destructive hover:text-destructive" onClick={() => setConfirm(s)}>
                    Sign out this computer
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o && !revoke.isPending) {
            setConfirm(null);
            revoke.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out this computer?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && (
                <>
                  {personName(confirm.user)} on {confirm.label ?? "this computer"} will be signed out straight away and has to sign in with
                  Google again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={revoke.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => confirm && revoke.mutate(confirm)}>
              {revoke.isPending ? "Signing out…" : "Sign out"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
