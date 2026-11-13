import { useState } from "react";
import type { SessionFileChange } from "@contracts/changes";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { ToolBlock } from "../hooks/useChat.ts";

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function extractToolFilePath(tool: string, input: unknown): string | null {
  if (!FILE_EDIT_TOOLS.has(tool) || !input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const raw =
    tool === "NotebookEdit"
      ? (obj["notebook_path"] ?? obj["file_path"] ?? obj["path"])
      : (obj["file_path"] ?? obj["path"] ?? obj["notebook_path"]);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function matchSessionChange(
  rawPath: string | null,
  toolUseId: string,
  changesFiles?: SessionFileChange[],
): { file: SessionFileChange; revId?: string } | null {
  if (!changesFiles || changesFiles.length === 0) return null;

  for (const file of changesFiles) {
    const rev = file.revisions.find((r) => r.toolUseId && r.toolUseId === toolUseId);
    if (rev) return { file, revId: rev.revId };
  }

  if (!rawPath) return null;
  const norm = rawPath.replace(/\\/g, "/");
  for (const file of changesFiles) {
    if (norm === file.path || norm.endsWith(`/${file.path}`)) {
      return { file };
    }
  }
  return null;
}

export interface ToolCallBlockProps {
  block: ToolBlock;
  changesFiles?: SessionFileChange[];
  onInspectFileChange?: (path: string, revId?: string) => void;
}

export default function ToolCallBlock({
  block,
  changesFiles,
  onInspectFileChange,
}: ToolCallBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetails = block.input !== undefined && block.input !== null;

  const rawPath = extractToolFilePath(block.tool, block.input);
  const matched = matchSessionChange(rawPath, block.id, changesFiles);
  const displayPath = matched?.file.path ?? rawPath;
  const matchedRev = matched?.revId
    ? matched.file.revisions.find((r) => r.revId === matched.revId)
    : undefined;

  const pillLabel = (() => {
    if (!displayPath) return null;
    if (!matched) return t("changesInspectPill", { path: displayPath });
    const add = matchedRev ? matchedRev.additions : matched.file.additions;
    const del = matchedRev ? matchedRev.deletions : matched.file.deletions;
    const model = matchedRev?.model ?? matched.file.lastEditedBy.model;
    if (matched.file.status === "added" && !matchedRev) {
      return t("changesCreatedPill", { path: displayPath, add, model });
    }
    if (matched.file.status === "deleted") {
      return t("changesDeletedPill", { path: displayPath, del, model });
    }
    return t("changesEditedPill", { path: displayPath, add, del, model });
  })();

  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-xs">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            {block.tool}
          </span>
          <span className="truncate text-[var(--text-secondary)]">{block.summary}</span>
          {block.subAgent && (
            <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
              {t("subagentBadge")}
            </span>
          )}
        </div>
        {hasDetails && (
          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </button>

      {pillLabel && displayPath && onInspectFileChange && (
        <div className="border-t border-[var(--border-subtle)]/70 px-2.5 py-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInspectFileChange(matched?.file.path ?? displayPath, matched?.revId);
            }}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">{pillLabel}</span>
          </button>
        </div>
      )}

      {expanded && hasDetails && (
        <pre className="max-h-48 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--code-bg)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
          {typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
