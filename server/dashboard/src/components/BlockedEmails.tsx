import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Ban } from "lucide-react";
import { api } from "../api";
import { formatWhen } from "../format";
import { ErrorBox, FormError, Hint, Spinner } from "../ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Blocked = {
  email: string;
  reason: string | null;
  createdAt: string;
  blockedBy: { name: string | null; email: string } | null;
  user: { id: string; name: string | null } | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Admin list of emails that can never sign in, whether or not they have an account. */
export function BlockedEmails() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["blocked-emails"], queryFn: () => api<Blocked[]>("/api/blocked-emails") });
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["blocked-emails"] });
    void qc.invalidateQueries({ queryKey: ["users"] });
  };
  const block = useMutation({
    mutationFn: () => api("/api/blocked-emails", { method: "POST", body: { email: email.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => {
      setEmail("");
      setReason("");
      refresh();
    },
  });
  const unblock = useMutation({
    mutationFn: (e: string) => api(`/api/blocked-emails/${encodeURIComponent(e)}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const valid = EMAIL_RE.test(email.trim());

  return (
    <section className="mt-8" aria-labelledby="blocked-title">
      <h2 id="blocked-title" className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Ban className="size-5" /> Blocked
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        These emails can never sign in, even with a company Google account. Blocking someone who already has an account signs them out of every phone and the dashboard straight away.
      </p>
      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) block.mutate();
        }}
      >
        <div className="sm:w-72">
          <Label htmlFor="block-email">Email</Label>
          <Input id="block-email" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="sm:flex-1">
          <Label htmlFor="block-reason">Reason (optional)</Label>
          <Input id="block-reason" maxLength={300} placeholder="e.g. left the company" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button type="submit" variant="destructive" disabled={!valid || block.isPending}>
          <Ban /> Block
        </Button>
      </form>
      <FormError error={block.error ?? unblock.error} />
      {list.isPending ? (
        <Spinner label="Loading blocked emails" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Hint>No one is blocked.</Hint>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Blocked</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((b) => (
                <TableRow key={b.email}>
                  <TableCell className="max-w-72">
                    <div className="truncate font-medium">{b.user?.name || b.email}</div>
                    {b.user?.name && <div className="truncate text-xs text-muted-foreground">{b.email}</div>}
                    {!b.user && <div className="text-xs text-muted-foreground">No account</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{b.reason || "None given"}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatWhen(b.createdAt)}
                    {b.blockedBy && <div className="text-xs">by {b.blockedBy.name || b.blockedBy.email}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-10"
                      disabled={unblock.isPending}
                      onClick={() => unblock.mutate(b.email)}
                      aria-label={`Unblock ${b.email}`}
                    >
                      Unblock
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}
