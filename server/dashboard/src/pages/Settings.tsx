import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save } from "lucide-react";
import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { tabLinkClass, tabsListClass } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, type DeviceConfig, type Settings } from "../api";
import { ClientListPanel } from "../components/Privacy";
import { ErrorBox, FormError, Hint, PageHeader, Spinner } from "../ui";
import { DncTab } from "./settings/Dnc";
import { LeadSourcesTab } from "./settings/LeadSources";
import { OutcomesTab } from "./settings/Outcomes";
import { RetentionTab } from "./settings/Retention";
import { ScriptsTab } from "./settings/Scripts";
import { TargetsTab } from "./settings/Targets";
import { TemplatesTab } from "./settings/Templates";

const TABS = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/outcomes", label: "Outcomes" },
  { to: "/settings/scripts", label: "Scripts" },
  { to: "/settings/templates", label: "Templates" },
  { to: "/settings/lead-sources", label: "Lead sources" },
  { to: "/settings/dnc", label: "Do-not-call" },
  { to: "/settings/retention", label: "Retention" },
  { to: "/settings/targets", label: "Targets" },
];

/** Admin settings with sub-tabs (each tab is its own URL, so /settings/dnc deep-links). */
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="How phones sync, what reps see on calls, and who can be called." />
      <nav aria-label="Settings" className={cn(tabsListClass, "mb-5")}>
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={tabLinkClass}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<GeneralTab />} />
        <Route path="outcomes" element={<OutcomesTab />} />
        <Route path="scripts" element={<ScriptsTab />} />
        <Route path="templates" element={<TemplatesTab />} />
        <Route path="lead-sources" element={<LeadSourcesTab />} />
        <Route path="dnc" element={<DncTab />} />
        <Route path="retention" element={<RetentionTab />} />
        <Route path="targets" element={<TargetsTab />} />
        <Route path="*" element={<Navigate to="/settings" replace />} />
      </Routes>
    </>
  );
}

function GeneralTab() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/settings") });
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">Applied to every phone. Excluded numbers are set per user on the Users page.</p>
      {settings.isPending ? (
        <Spinner label="Loading settings" />
      ) : settings.isError ? (
        <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <>
          <DeviceConfigForm initial={settings.data.deviceConfig} />
          <ClientListPanel />
          <Card className="mt-4">
            <CardHeader className="pb-5">
              <CardTitle>Published app</CardTitle>
              <CardDescription className="break-all">
                {settings.data.latestApp
                  ? `${settings.data.latestApp.versionName} (${settings.data.latestApp.versionCode}) · ${settings.data.latestApp.fileName}`
                  : "No app version published yet."}
              </CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
    </>
  );
}

function SettingSwitch({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <Label htmlFor={id} className="mb-0 cursor-pointer">
          {label}
        </Label>
        <Hint id={`${id}-hint`}>{hint}</Hint>
      </div>
      <Switch id={id} className="mt-0.5" checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} />
    </div>
  );
}

function DeviceConfigForm({ initial }: { initial: DeviceConfig }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...initial, folders: initial.recorderFolders.join("\n"), cutoff: String(initial.backlogCutoffDays) });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const folderList = form.folders
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const cutoff = Number(form.cutoff);
  const foldersOk = folderList.length <= 50 && folderList.every((f) => f.length <= 200);
  const cutoffOk = /^\d+$/.test(form.cutoff) && cutoff >= 0 && cutoff <= 3650;
  const config: DeviceConfig = {
    recorderFolders: folderList,
    liveNetwork: form.liveNetwork,
    backlogEnabled: form.backlogEnabled,
    backlogCutoffDays: cutoff,
    maxParallelUploads: form.maxParallelUploads,
    compressAudio: form.compressAudio,
    businessOnly: form.businessOnly,
  };
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => api<DeviceConfig>("/api/settings/device-config", { method: "PUT", body: config }),
    onSuccess: (data) => {
      toast.success("Saved. Phones pick this up on their next sync.");
      qc.setQueryData<Settings>(["settings"], (s) => (s ? { ...s, deviceConfig: data } : s));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Device sync settings</CardTitle>
        <CardDescription>Where phones look for recordings and how they upload them.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (foldersOk && cutoffOk && dirty) save.mutate();
          }}
        >
          <div>
            <Label htmlFor="s-folders">Recorder folders, one per line</Label>
            <Textarea id="s-folders" rows={8} className="font-mono" value={form.folders} onChange={(e) => set("folders", e.target.value)} aria-describedby="s-folders-hint" aria-invalid={!foldersOk} />
            <Hint id="s-folders-hint" className={foldersOk ? "" : "text-destructive"}>
              Paths under internal storage, such as Recordings/Call. {folderList.length}/50
            </Hint>
          </div>

          <div>
            <p id="s-net-label" className="mb-1.5 text-sm font-medium text-slate-700">
              Live uploads network
            </p>
            <div role="radiogroup" aria-labelledby="s-net-label" className="flex flex-wrap gap-2">
              {(
                [
                  ["any", "Any network"],
                  ["wifi", "Wi-Fi only"],
                ] as const
              ).map(([v, l]) => (
                <Button key={v} role="radio" aria-checked={form.liveNetwork === v} variant={form.liveNetwork === v ? "secondary" : "outline"} className={cn("min-h-11", form.liveNetwork === v && "ring-2 ring-primary")} onClick={() => set("liveNetwork", v)}>
                  {form.liveNetwork === v && <Check aria-hidden />}
                  {l}
                </Button>
              ))}
            </div>
          </div>

          <div className="divide-y">
            <SettingSwitch id="s-backlog" label="Upload old recordings (backlog)" hint="Recordings made before the app was installed." checked={form.backlogEnabled} onChange={(v) => set("backlogEnabled", v)} />
            <SettingSwitch id="s-compress" label="Compress audio before upload" hint="Smaller files, less mobile data." checked={form.compressAudio} onChange={(v) => set("compressAudio", v)} />
            <SettingSwitch
              id="s-business"
              label="Business calls only"
              hint="Phones skip calls with numbers saved in their contacts, unless the number is on the client list below. Unsaved numbers still upload. Phones ask for the Contacts permission."
              checked={form.businessOnly}
              onChange={(v) => set("businessOnly", v)}
            />
          </div>

          <div className="max-w-xs">
            <Label htmlFor="s-cutoff">Backlog cutoff (days)</Label>
            <Input id="s-cutoff" inputMode="numeric" value={form.cutoff} onChange={(e) => set("cutoff", e.target.value)} aria-describedby="s-cutoff-hint" aria-invalid={!cutoffOk} />
            <Hint id="s-cutoff-hint" className={cutoffOk ? "" : "text-destructive"}>
              Skip recordings older than this. 0 to 3650.
            </Hint>
          </div>

          <div>
            <p id="s-par-label" className="mb-1.5 text-sm font-medium text-slate-700">
              Max parallel uploads
            </p>
            <div role="radiogroup" aria-labelledby="s-par-label" className="flex gap-2">
              {[1, 2, 3, 4].map((n) => (
                <Button key={n} role="radio" aria-checked={form.maxParallelUploads === n} variant={form.maxParallelUploads === n ? "default" : "outline"} className="size-11" onClick={() => set("maxParallelUploads", n)}>
                  {n}
                </Button>
              ))}
            </div>
            <Hint>Low-RAM phones always upload one at a time.</Hint>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button type="submit" disabled={!dirty || !foldersOk || !cutoffOk || save.isPending}>
              <Save aria-hidden />
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button
              variant="ghost"
              disabled={!dirty || save.isPending}
              onClick={() => {
                save.reset();
                setForm({ ...initial, folders: initial.recorderFolders.join("\n"), cutoff: String(initial.backlogCutoffDays) });
              }}
            >
              Discard changes
            </Button>
            <span aria-live="polite">
              <FormError error={save.error} />
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
