import { useQuery } from "@tanstack/react-query";
import { Download, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Downloads {
  android: { version: string; sizeBytes: number; url: string } | null;
  windows: { version: string; sizeBytes: number; url: string } | null;
}

type Platform = "android" | "windows" | "other";

function detect(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1)} MB`;

/** Public page (no sign-in): download the Android and Windows apps. */
export function DownloadsPage({ signedIn = false }: { signedIn?: boolean }) {
  const platform = detect();
  const q = useQuery({
    queryKey: ["downloads"],
    queryFn: async () => {
      const r = await fetch("/api/downloads", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Downloads;
    },
    staleTime: 60_000,
  });

  const android = (
    <AppCard
      key="android"
      icon={<Smartphone className="size-6" />}
      name="Android"
      recommended={platform === "android"}
      app={q.data?.android}
      loading={q.isPending}
      requirement="Android 8.0 or newer"
      button="Download for Android"
      steps={[
        "Tap Download and open the file when it finishes.",
        "If asked, allow your browser to install apps (Settings → Install unknown apps).",
        "If Play Protect warns you, tap More details → Install anyway.",
        "Open UIC Dialer and sign in with your company Google account.",
      ]}
    />
  );
  const windows = (
    <AppCard
      key="windows"
      icon={<Monitor className="size-6" />}
      name="Windows"
      recommended={platform === "windows"}
      app={q.data?.windows}
      loading={q.isPending}
      requirement="Windows 10 or 11 (64-bit)"
      button="Download for Windows"
      steps={[
        "Click Download and run the installer when it finishes.",
        "If Windows shows \"Windows protected your PC\", click More info → Run anyway.",
        "Sign in with your company Google account. Updates install by themselves.",
      ]}
    />
  );

  return (
    <main className="min-h-dvh bg-background px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <header className="text-center">
          <div aria-hidden className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-primary text-sm font-semibold text-white">
            UIC
          </div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Download UIC Dialer</h1>
          <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
            Call, record and follow up from your phone or computer. Always the latest version.
          </p>
        </header>

        {q.isError && (
          <p role="alert" className="mt-6 text-center text-sm text-destructive">
            Couldn't load the latest versions. You can still use the buttons below.
          </p>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-2">{platform === "windows" ? [windows, android] : [android, windows]}</div>

        <p className="mt-8 flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <ShieldCheck aria-hidden className="size-4" />
          Only approved company accounts can sign in.
        </p>
        <p className="mt-2 text-center text-sm">
          <a href={signedIn ? "/today" : "/"} className="text-primary hover:underline">
            {signedIn ? "Back to the app" : "Sign in on the web instead"}
          </a>
        </p>
      </div>
    </main>
  );
}

function AppCard(props: {
  icon: ReactNode;
  name: string;
  recommended: boolean;
  app: { version: string; sizeBytes: number; url: string } | null | undefined;
  loading: boolean;
  requirement: string;
  button: string;
  steps: string[];
}) {
  const { app } = props;
  const fallback = props.name === "Android" ? "/app.apk" : "/download/windows";
  return (
    <Card className={`flex flex-col p-6 ${props.recommended ? "ring-2 ring-primary" : ""}`}>
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-11 place-items-center rounded-lg bg-primary/10 text-primary">
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{props.name}</h2>
          {props.loading ? (
            <Skeleton className="mt-1 h-4 w-32" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {app ? `Version ${app.version} · ${mb(app.sizeBytes)}` : "Latest version"}
            </p>
          )}
        </div>
        {props.recommended && <Badge>For this device</Badge>}
      </div>

      <Button asChild size="lg" variant={props.recommended ? "default" : "outline"} className="mt-5 w-full">
        <a href={app?.url ?? fallback}>
          <Download aria-hidden />
          {props.button}
        </a>
      </Button>
      <p className="mt-2 text-center text-xs text-muted-foreground">{props.requirement}</p>

      <div className="mt-5 border-t pt-4">
        <h3 className="text-sm font-medium">How to install</h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          {props.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
