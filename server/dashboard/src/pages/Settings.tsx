import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
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
import { MaintenanceJobs } from "../components/MaintenanceJobs";
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
  { to: "/settings/calling", label: "Calling" },
  { to: "/settings/leads", label: "Leads & numbers" },
  { to: "/settings/privacy", label: "Privacy" },
  { to: "/settings/advanced", label: "Advanced" },
];

// Old tab URLs (bookmarks, links in messages) land on the section's new home.
const OLD_TABS: [string, string][] = [
  ["outcomes", "/settings/calling#outcomes"],
  ["scripts", "/settings/calling#scripts"],
  ["templates", "/settings/calling#templates"],
  ["targets", "/settings/calling#targets"],
  ["lead-sources", "/settings/leads#lead-sources"],
  ["dnc", "/settings/leads#dnc"],
  ["retention", "/settings/privacy"],
];

/** Admin settings in 4 tabs (each its own URL). Managers reach Do not call through their own route. */
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="What reps see on calls, where leads go, and privacy." />
      <nav aria-label="Settings" className={cn(tabsListClass, "mb-5")}>
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={tabLinkClass}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <ScrollToHash />
      <Routes>
        <Route index element={<Navigate to="/settings/calling" replace />} />
        <Route path="calling" element={<CallingTab />} />
        <Route path="leads" element={<LeadsTab />} />
        <Route path="privacy" element={<RetentionTab />} />
        <Route path="advanced" element={<AdvancedTab />} />
        {OLD_TABS.map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="*" element={<Navigate to="/settings/calling" replace />} />
      </Routes>
    </>
  );
}

/** Old tab links point at a section (#dnc); scroll to it once it has rendered. */
function ScrollToHash() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [hash, pathname]);
  return null;
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className="mb-4 scroll-mt-20">
      {children}
    </section>
  );
}

function CallingTab() {
  return (
    <>
      <Section id="outcomes">
        <OutcomesTab />
      </Section>
      <Section id="scripts">
        <ScriptsTab />
      </Section>
      <Section id="templates">
        <TemplatesTab />
      </Section>
      <Section id="targets">
        <TargetsTab />
      </Section>
    </>
  );
}

function LeadsTab() {
  return (
    <>
      <Section id="lead-sources">
        <LeadSourcesTab />
      </Section>
      <Section id="dnc">
        <DncTab />
      </Section>
      <Section id="personal-calls">
        <PersonalCalls />
      </Section>
    </>
  );
}

const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/settings") });

/** "Business calls only" plus the client list. Saves the whole device config with just this switch changed. */
function PersonalCalls() {
  const qc = useQueryClient();
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (businessOnly: boolean) =>
      api<DeviceConfig>("/api/settings/device-config", { method: "PUT", body: { ...settings.data!.deviceConfig, businessOnly } }),
    onSuccess: (data) => {
      toast.success("Saved. Phones pick this up on their next sync.");
      qc.setQueryData<Settings>(["settings"], (s) => (s ? { ...s, deviceConfig: data } : s));
    },
  });
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Personal calls</CardTitle>
          <CardDescription>Keep reps' personal calls off the server.</CardDescription>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <Spinner label="Loading settings" />
          ) : settings.isError ? (
            <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <>
              <SettingSwitch
                id="s-business"
                label="Business calls only"
                hint="Phones skip calls with numbers saved in the rep's contacts, unless the number is on the client list below. New numbers still upload."
                checked={save.isPending ? !!save.variables : settings.data.deviceConfig.businessOnly}
                onChange={(v) => save.mutate(v)}
              />
              <FormError error={save.error} />
            </>
          )}
        </CardContent>
      </Card>
      <ClientListPanel />
    </>
  );
}

/** Upload settings, catch-up jobs, app version and test alert: closed by default so nobody changes them by accident. */
function AdvancedTab() {
  const settings = useSettings();
  return (
    <details className="rounded-xl border bg-card p-4">
      <summary className="cursor-pointer font-medium">Show advanced settings</summary>
      <p className="mt-1 text-sm text-muted-foreground">Change only if recordings are not uploading.</p>
      <div className="mt-4">
        {settings.isPending ? (
          <Spinner label="Loading settings" />
        ) : settings.isError ? (
          <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <>
            <DeviceConfigForm key={JSON.stringify(settings.data.deviceConfig)} initial={settings.data.deviceConfig} />
            <MaintenanceJobs />
            <h3 className="mb-2 mt-6 font-semibold">Latest app version</h3>
            <Card className="break-all p-4 text-sm text-muted-foreground">
              {settings.data.latestApp
                ? `${settings.data.latestApp.versionName} (${settings.data.latestApp.versionCode}) · ${settings.data.latestApp.fileName}`
                : "No app version published yet."}
            </Card>
          </>
        )}
      </div>
    </details>
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
    // Set on the Leads & numbers tab; always the saved value here.
    businessOnly: initial.businessOnly,
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
        <CardTitle>Phone recording & upload</CardTitle>
        <CardDescription>Where phones find recordings and how they upload them.</CardDescription>
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
              Folders in the phone's storage, such as Recordings/Call. {folderList.length}/50
            </Hint>
          </div>

          <div>
            <p id="s-net-label" className="mb-1.5 text-sm font-medium text-foreground">
              Upload calls on
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
            <SettingSwitch id="s-backlog" label="Also upload older calls" hint="Calls recorded before the app was installed." checked={form.backlogEnabled} onChange={(v) => set("backlogEnabled", v)} />
            {form.backlogEnabled && (
              <div className="flex flex-wrap items-center gap-2 py-3 text-sm">
                <Label htmlFor="s-cutoff" className="mb-0">
                  From the last
                </Label>
                <Input id="s-cutoff" inputMode="numeric" className="w-24" value={form.cutoff} onChange={(e) => set("cutoff", e.target.value)} aria-describedby="s-cutoff-hint" aria-invalid={!cutoffOk} />
                <span>days</span>
                <Hint id="s-cutoff-hint" className={cn("w-full", cutoffOk ? "" : "text-destructive")}>
                  0 to 3650.
                </Hint>
              </div>
            )}
            <SettingSwitch id="s-compress" label="Make audio smaller before upload" hint="Uses less mobile data." checked={form.compressAudio} onChange={(v) => set("compressAudio", v)} />
          </div>

          <div>
            <p id="s-par-label" className="mb-1.5 text-sm font-medium text-foreground">
              Uploads at the same time
            </p>
            <div role="radiogroup" aria-labelledby="s-par-label" className="flex gap-2">
              {[1, 2, 3, 4].map((n) => (
                <Button key={n} role="radio" aria-checked={form.maxParallelUploads === n} variant={form.maxParallelUploads === n ? "default" : "outline"} className="size-11" onClick={() => set("maxParallelUploads", n)}>
                  {n}
                </Button>
              ))}
            </div>
            <Hint>Phones with little memory always upload one at a time.</Hint>
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
