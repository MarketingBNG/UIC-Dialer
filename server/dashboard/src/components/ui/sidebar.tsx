import { MenuIcon } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Sidebar, trimmed to what this app uses: a fixed sidebar on md+ screens
 * and the same content in a Sheet on small screens (opened by SidebarTrigger).
 */
type SidebarContextValue = { openMobile: boolean; setOpenMobile: (open: boolean) => void };
const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider.");
  return ctx;
}

function SidebarProvider({ className, children, ...props }: React.ComponentProps<"div">) {
  const [openMobile, setOpenMobile] = React.useState(false);
  const value = React.useMemo(() => ({ openMobile, setOpenMobile }), [openMobile]);
  return (
    <SidebarContext.Provider value={value}>
      <div data-slot="sidebar-wrapper" style={{ "--sidebar-width": "16rem" } as React.CSSProperties} className={cn("flex min-h-dvh w-full", className)} {...props}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({ className, children, title = "Menu", ...props }: React.ComponentProps<"div"> & { title?: string }) {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <>
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="left" className="bg-sidebar p-0 text-sidebar-foreground md:hidden">
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <div className="flex h-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
      <div className="hidden w-(--sidebar-width) shrink-0 md:block" aria-hidden />
      <div
        data-slot="sidebar"
        className={cn("fixed inset-y-0 left-0 z-30 hidden w-(--sidebar-width) flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex", className)}
        {...props}
      >
        {children}
      </div>
    </>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { setOpenMobile } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn("size-11", className)}
      onClick={(e) => {
        onClick?.(e);
        setOpenMobile(true);
      }}
      {...props}
    >
      <MenuIcon className="size-5" />
      <span className="sr-only">Open menu</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("flex min-w-0 flex-1 flex-col", className)} {...props} />;
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("flex flex-col gap-3 p-4", className)} {...props} />;
}
function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3", className)} {...props} />;
}
function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("flex flex-col gap-2 border-t border-sidebar-border p-3", className)} {...props} />;
}
function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("flex flex-col gap-1", className)} {...props} />;
}
function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-label" className={cn("px-3 pb-1 text-xs font-medium text-sidebar-foreground/60", className)} {...props} />;
}
function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("flex flex-col gap-1", className)} {...props} />;
}
function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("relative", className)} {...props} />;
}

function SidebarMenuButton({ asChild = false, isActive = false, className, ...props }: React.ComponentProps<"button"> & { asChild?: boolean; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-sidebar-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-semibold data-[active=true]:shadow-[inset_3px_0_0_var(--sidebar-primary)] [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
