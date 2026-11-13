import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils.ts";

/** Resizable split-pane container built on react-resizable-panels v4. */
export function ResizablePanelGroup({
  className,
  orientation = "horizontal",
  ...props
}: GroupProps) {
  return (
    <Group
      orientation={orientation}
      className={cn("flex h-full w-full", orientation === "vertical" && "flex-col", className)}
      {...props}
    />
  );
}

/** Individual resizable pane inside a ResizablePanelGroup. */
export function ResizablePanel({ className, style, ...props }: PanelProps) {
  return (
    <Panel
      className={cn("min-h-0 min-w-0", className)}
      style={{ overflow: "hidden", ...style }}
      {...props}
    />
  );
}

/** Accessible drag separator handle between two resizable panels. */
export function ResizableHandle({
  withHandle = false,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) {
  return (
    <Separator
      className={cn(
        "relative flex w-1 shrink-0 items-center justify-center bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] data-[separator=active]:bg-[var(--accent-primary)]",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-5 w-3 items-center justify-center rounded-xs border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]">
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </Separator>
  );
}
