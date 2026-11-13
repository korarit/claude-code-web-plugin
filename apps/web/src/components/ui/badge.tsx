import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors",
  {
    variants: {
      variant: {
        default: "bg-[var(--bg-muted)] text-[var(--text-secondary)]",
        primary: "bg-[var(--primary)]/15 text-[var(--primary)]",
        secondary: "bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
        outline:
          "border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]",
        amber:
          "border border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-300",
        emerald:
          "border border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        indigo:
          "border border-indigo-500/35 bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
        rose: "border border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** Semantic status and metadata badge primitive. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
