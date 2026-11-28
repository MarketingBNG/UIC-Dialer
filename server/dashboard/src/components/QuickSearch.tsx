import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type * as React from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight, History, Phone, PhoneCall, Search, Settings2, Users } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { api, isManager, qs, type ContactListItem, type ContactPage } from "../api";
import { useMe } from "../App";
import { cleanNumber, useDialer } from "../dialer";
import { ContactStatusBadge } from "../ui";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcutText = isMac ? "⌘K" : "Ctrl K";

/** Looks like a phone number: only digits, spaces, dashes, dots, brackets and a leading +, with 6+ digits. */
const looksLikePhone = (q: string) => /^\+?[\d\s().-]+$/.test(q.trim()) && q.replace(/\D/g, "").length >= 6;

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The "Search… Ctrl K" button. Opens the same dialog as the keyboard shortcut. */
export function QuickSearchButton({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return (
    <Button
      variant="outline"
      onClick={onOpen}
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className={cn("w-full justify-start gap-2 text-muted-foreground", className)}
    >
      <Search aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px]">{shortcutText}</kbd>
    </Button>
  );
}

/** Ctrl+K / Cmd+K anywhere toggles the dialog. */
export function useQuickSearchShortcut(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

const contactName = (c: ContactListItem) => c.name || c.company || c.phoneE164;

export function QuickSearch({
  open,
  onOpenChange,
  initialQuery = "",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Prefill, e.g. the digit typed on the page (keyboard dialing). */
  initialQuery?: string;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const dialer = useDialer();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState("");
  const term = useDebounced(q.trim(), 250);

  useEffect(() => {
    setQ(open ? initialQuery : "");
  }, [open, initialQuery]);

  const results = useQuery({
    queryKey: ["contacts", "quick-search", term],
    queryFn: () => api<ContactPage>(`/api/contacts${qs({ q: term, limit: 8 })}`),
    enabled: open && term.length > 0,
    staleTime: 30_000,
  });

  const close = () => onOpenChange(false);
  const go = (to: string) => {
    close();
    void navigate(to);
  };
  const callContact = (c: ContactListItem) => {
    close();
    void dialer.call(c.phoneE164, contactName(c), { dncReason: c.dnc?.reason ?? null, dnc: !!c.dnc });
  };
  const openContact = (c: ContactListItem) => go(`/activity/contacts/${c.id}`);

  const pages = [
    { to: "/today", label: "Today", icon: PhoneCall },
    { to: "/activity", label: "Contacts", icon: Users },
    { to: "/calls", label: "Calls", icon: History },
    ...(isManager(me.role) ? [{ to: "/admin", label: "Admin", icon: Settings2 }] : []),
  ].filter((p) => !q.trim() || p.label.toLowerCase().includes(q.trim().toLowerCase()));

  const phone = looksLikePhone(q) ? cleanNumber(q) : "";
  const items = results.data?.items ?? [];
  const searching = q.trim().length > 0 && (term !== q.trim() || results.isFetching);

  // Ctrl/Cmd+Enter (or Alt+Enter) on a contact opens its page instead of calling.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey || e.altKey)) return;
    const c = items.find((i) => `contact:${i.id}` === selected);
    if (c) {
      e.preventDefault();
      e.stopPropagation();
      openContact(c);
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Quick search" description="Search contacts by name, company or number, or jump to a page.">
      <Command shouldFilter={false} value={selected} onValueChange={setSelected} onKeyDown={onKeyDown} loop>
        <CommandInput value={q} onValueChange={setQ} placeholder="Name, company or phone number…" aria-label="Search contacts and pages" />
        <CommandList>
          <CommandEmpty>
            {searching ? "Searching…" : results.isError ? "Search didn't work. Check your connection and try again." : `No contacts or pages match "${q.trim()}".`}
          </CommandEmpty>
          {phone && (
            <CommandGroup heading="Dial">
              <CommandItem
                value={`dial:${phone}`}
                onSelect={() => {
                  close();
                  void dialer.call(phone);
                }}
              >
                <Phone aria-hidden />
                Call {phone}
                <CommandShortcut>Enter</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )}
          {items.length > 0 && (
            <CommandGroup heading="Contacts">
              {items.map((c) => (
                <CommandItem key={c.id} value={`contact:${c.id}`} onSelect={() => callContact(c)} className="group">
                  <Phone aria-hidden className="text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{contactName(c)}</span>
                      <ContactStatusBadge status={c.status} />
                      {c.dnc && <span className="text-xs text-destructive">Do not call</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[c.name && c.company, c.phoneE164].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <span className="hidden text-xs text-muted-foreground group-data-[selected=true]:inline">Enter to call</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    tabIndex={-1}
                    title="Open contact (Ctrl+Enter)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openContact(c);
                    }}
                  >
                    <ArrowUpRight aria-hidden />
                    Open
                  </Button>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {pages.length > 0 && (
            <CommandGroup heading="Go to">
              {pages.map((p) => (
                <CommandItem key={p.to} value={`page:${p.to}`} onSelect={() => go(p.to)}>
                  <p.icon aria-hidden />
                  {p.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to call or open · <kbd>{isMac ? "⌘" : "Ctrl"}+Enter</kbd> to open a contact · <kbd>Esc</kbd> to close
        </div>
      </Command>
    </CommandDialog>
  );
}
