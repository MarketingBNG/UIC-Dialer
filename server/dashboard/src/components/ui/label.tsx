import { Label as LabelPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root data-slot="label" className={cn("mb-1.5 block text-sm font-medium leading-snug text-slate-700 peer-disabled:opacity-50", className)} {...props} />;
}

export { Label };
