import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type AuditAction, type AuditEntry, type AuditPage as Page } from "../api";
import { formatWhen } from "../format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, PageHeader, Spinner } from "../ui";

export const AUDIT_LABELS: Record<AuditAction, string> = {
  PLAY: "Played",
  DOWNLOAD: "Downloaded",
  SEARCH: "Searched",
  DELETE: "Deleted call",
  USER_CHANGE: "User changed",
  DEVICE_REVOKE: "Phone signed out",
  SETTINGS_CHANGE: "Settings changed",
  CLIENT_LIST_CHANGE: "Client list changed",
  RETENTION_DELETE: "Retention deleted audio",
  EXPORT: "Exported calls (CSV)",
  CRM_SYNC: "Zoho CRM sync",
  CALL_LIST_CHANGE: "Call list changed",
  CONTACT_IMPORT: "Contacts imported",
  DNC_CHANGE: "Do-not-call list changed",
  LEAD_SOURCE_CHANGE: "Lead source changed",
  OUTCOME_CHANGE: "Outcomes changed",
  TEMPLATE_CHANGE: "Templates changed",
  TARGET_CHANGE: "Targets changed",
};

/** One-line summary of the detail JSON (same wording as the Android Audit screen). */
export function auditSummary(e: Pick<AuditEntry, "action" | "detail">): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "SEARCH":
      return typeof d["q"] === "string" ? `"${d["q"]}"` : "";
    case "EXPORT":
      return `${d["rows"] ?? 0} calls`;
    case "RETENTION_DELETE": {
      const age = d["retentionDays"] != null ? `${String(d["retentionDays"])} days` : `${String(d["retentionMonths"] ?? "?")} months`;
      const cleared = typeof d["transcriptsCleared"] === "number" && d["transcriptsCleared"] > 0 ? `, ${d["transcriptsCleared"]} transcripts cleared` : "";
      return `${String(d["deleted"] ?? 0)} audio files older than ${age}${cleared}`;
    }
    case "CONTACT_IMPORT":
      return `${String(d["created"] ?? 0)} created, ${String(d["updated"] ?? 0)} updated, ${String(d["skipped"] ?? 0)} skipped`;
    case "CLIENT_LIST_CHANGE":
      return Object.entries(d)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
    default:
      return e.detail ? JSON.stringify(e.detail).slice(0, 160) : "";
  }
}

export function AuditPage() {
  const [action, setAction] = useState<AuditAction | "">("");
  const log = useInfiniteQuery({
    queryKey: ["audit", action],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (action) p.set("action", action);
      if (pageParam) p.set("cursor", pageParam);
      // v=2: include the stage 2/3 actions (old apps don't get them).
      p.set("v", "2");
      return api<Page>(`/api/audit?${p}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who played, downloaded, searched or changed what. Newest first." />
      <div className="mb-4 max-w-xs">
        <Label htmlFor="audit-action">Show</Label>
        <NativeSelect id="audit-action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
          <option value="">All actions</option>
          {(Object.keys(AUDIT_LABELS) as AuditAction[]).map((a) => (
            <option key={a} value={a}>
              {AUDIT_LABELS[a]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {log.isPending ? (
        <Spinner label="Loading audit log" />
      ) : log.isError && items.length === 0 ? (
        <ErrorBox error={log.error} onRetry={() => void log.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{action ? "Nothing of this kind yet. Choose All actions to see everything." : "Nothing has been logged yet. Entries appear here when someone plays, downloads or changes something."}</Empty>
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{formatWhen(e.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={e.action === "DELETE" || e.action === "RETENTION_DELETE" ? "red" : e.action === "DOWNLOAD" ? "amber" : "gray"}>
                        {AUDIT_LABELS[e.action as AuditAction] ?? e.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">{e.user ? e.user.name || e.user.email : "System"}</TableCell>
                    <TableCell className="min-w-48 break-all text-muted-foreground">
                      {e.callId && (
                        <Link className="mr-2 text-primary underline" to={`/calls/${e.callId}`}>
                          Open call
                        </Link>
                      )}
                      {auditSummary(e)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {log.hasNextPage && (
            <Button variant="outline" className="mt-4 w-full" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              {log.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
          {log.isFetchNextPageError && <ErrorBox error={log.error} />}
        </>
      )}
    </>
  );
}
