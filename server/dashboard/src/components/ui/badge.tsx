import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium [&>svg]:size-3", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "text-foreground",
      neutral: "border-transparent bg-neutral-soft text-neutral-text",
      success: "border-success/20 bg-success-soft text-success-text",
      warning: "border-warning/20 bg-warning-soft text-warning-text",
      danger: "border-destructive/20 bg-danger-soft text-danger-text",
      info: "border-info/20 bg-info-soft text-info-text",
      // Older colour names, kept so existing pages keep working.
      gray: "border-transparent bg-neutral-soft text-neutral-text",
      green: "border-success/20 bg-success-soft text-success-text",
      amber: "border-warning/20 bg-warning-soft text-warning-text",
      red: "border-destructive/20 bg-danger-soft text-danger-text",
      blue: "border-info/20 bg-info-soft text-info-text",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
