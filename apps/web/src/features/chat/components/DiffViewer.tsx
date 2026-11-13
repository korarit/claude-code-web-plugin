import { useMemo, useState } from "react";
import type { FileDiffResponse, RawFileResponse } from "@contracts/changes";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { highlightCodeLine } from "../../../lib/syntax.tsx";
import type { DiffViewMode } from "../hooks/useChanges.ts";

interface UnifiedRow {
  kind: "hunk" | "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface SplitRow {
  kind: "hunk" | "pair";
  hunkText?: string;
  leftLine?: number;
  leftText?: string;
  leftType?: "context" | "del" | "empty";
  rightLine?: number;
  rightText?: string;
  rightType?: "context" | "add" | "empty";
}

function parseUnifiedDiff(unifiedDiff: string): UnifiedRow[] {
  if (!unifiedDiff.trim()) return [];
  const lines = unifiedDiff.replace(/\r\n/g, "\n").split("\n");
  const rows: UnifiedRow[] = [];
  let oldLn = 0;
  let newLn = 0;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\ No newline")) {
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      oldLn = Number(hunkMatch[1]);
      newLn = Number(hunkMatch[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newLine: newLn, text: line.slice(1) });
      newLn++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLn, text: line.slice(1) });
      oldLn++;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine: oldLn, newLine: newLn, text: line.slice(1) });
      oldLn++;
      newLn++;
    }
  }

  return rows;
}

function toSplitRows(unifiedRows: UnifiedRow[]): SplitRow[] {
  const split: SplitRow[] = [];
  let i = 0;

  while (i < unifiedRows.length) {
    const row = unifiedRows[i]!;
    if (row.kind === "hunk") {
      split.push({ kind: "hunk", hunkText: row.text });
      i++;
      continue;
    }
    if (row.kind === "context") {
      split.push({
        kind: "pair",
        leftLine: row.oldLine,
        leftText: row.text,
        leftType: "context",
        rightLine: row.newLine,
        rightText: row.text,
        rightType: "context",
      });
      i++;
      continue;
    }

    const dels: UnifiedRow[] = [];
    const adds: UnifiedRow[] = [];
    while (i < unifiedRows.length && unifiedRows[i]!.kind === "del") {
      dels.push(unifiedRows[i]!);
      i++;
    }
    while (i < unifiedRows.length && unifiedRows[i]!.kind === "add") {
      adds.push(unifiedRows[i]!);
      i++;
    }

    const maxLen = Math.max(dels.length, adds.length);
    for (let k = 0; k < maxLen; k++) {
      const d = dels[k];
      const a = adds[k];
      split.push({
        kind: "pair",
        leftLine: d?.oldLine,
        leftText: d?.text,
        leftType: d ? "del" : "empty",
        rightLine: a?.newLine,
        rightText: a?.text,
        rightType: a ? "add" : "empty",
      });
    }
  }

  return split;
}

export interface DiffViewerProps {
  filePath: string;
  viewMode: DiffViewMode;
  diff: FileDiffResponse | null;
  rawFile: RawFileResponse | null;
  loading: boolean;
}

export default function DiffViewer({
  filePath,
  viewMode,
  diff,
  rawFile,
  loading,
}: DiffViewerProps) {
  const { t } = useTranslation();
  const [copiedCode, setCopiedCode] = useState(false);

  const unifiedRows = useMemo(
    () => (diff?.unifiedDiff ? parseUnifiedDiff(diff.unifiedDiff) : []),
    [diff?.unifiedDiff],
  );
  const splitRows = useMemo(() => toSplitRows(unifiedRows), [unifiedRows]);
  const rawLines = useMemo(() => {
    if (rawFile?.content === null || rawFile?.content === undefined) return [];
    const lines = rawFile.content.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }, [rawFile?.content]);

  const copyPayload =
    viewMode === "raw"
      ? (rawFile?.content ?? "")
      : (diff?.modifiedText ?? diff?.unifiedDiff ?? "");

  const handleCopyCode = async () => {
    if (!copyPayload) return;
    try {
      await navigator.clipboard.writeText(copyPayload);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-[var(--text-muted)]">
        ...
      </div>
    );
  }

  const isBinary = viewMode === "raw" ? Boolean(rawFile?.isBinary) : Boolean(diff?.isBinary);
  const isTruncated = viewMode === "raw" ? Boolean(rawFile?.truncated) : Boolean(diff?.truncated);

  if (isBinary) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-[var(--text-muted)]">
        {t("changesBinaryNotice")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isTruncated && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          {t("changesTruncatedNotice")}
        </div>
      )}

      {copyPayload && (
        <div className="flex justify-end border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1">
          <button
            type="button"
            onClick={() => void handleCopyCode()}
            className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {copiedCode ? t("copiedCode") : t("copyCode")}
          </button>
        </div>
      )}

      {viewMode === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--code-bg)] font-mono text-[11px] leading-5">
          {rawLines.length === 0 ? (
            <div className="p-4 text-xs text-[var(--text-muted)]">{t("changesNoDiff")}</div>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {rawLines.map((line, idx) => (
                  <tr key={idx} className="hover:bg-[var(--bg-elevated)]/40">
                    <td className="w-11 shrink-0 select-none border-r border-[var(--border-subtle)] px-2 text-right text-[10px] text-[var(--text-muted)]">
                      {idx + 1}
                    </td>
                    <td className="whitespace-pre px-3 text-[var(--text-primary)]">
                      {highlightCodeLine(line, filePath) || " "}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : unifiedRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-[var(--text-muted)]">
          {t("changesNoDiff")}
        </div>
      ) : viewMode === "unified" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--code-bg)] font-mono text-[11px] leading-5">
          <table className="w-full border-collapse">
            <tbody>
              {unifiedRows.map((row, idx) => {
                if (row.kind === "hunk") {
                  return (
                    <tr key={idx} className="bg-[var(--diff-hunk-bg)] text-[var(--diff-hunk-text)]">
                      <td colSpan={3} className="whitespace-pre px-3 py-0.5 text-[10px]">
                        {row.text}
                      </td>
                    </tr>
                  );
                }

                const bgClass =
                  row.kind === "add"
                    ? "bg-[var(--diff-add-bg)]"
                    : row.kind === "del"
                      ? "bg-[var(--diff-del-bg)]"
                      : "";
                const prefixClass =
                  row.kind === "add"
                    ? "text-[var(--diff-add-text)]"
                    : row.kind === "del"
                      ? "text-[var(--diff-del-text)]"
                      : "text-[var(--text-muted)]";
                const prefixChar = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";

                return (
                  <tr key={idx} className={bgClass}>
                    <td className="w-9 select-none px-1.5 text-right text-[10px] text-[var(--text-muted)]">
                      {row.oldLine ?? ""}
                    </td>
                    <td className="w-9 select-none border-r border-[var(--border-subtle)] px-1.5 text-right text-[10px] text-[var(--text-muted)]">
                      {row.newLine ?? ""}
                    </td>
                    <td className="whitespace-pre px-2 text-[var(--text-primary)]">
                      <span className={`mr-1.5 inline-block w-2 select-none font-bold ${prefixClass}`}>
                        {prefixChar}
                      </span>
                      {highlightCodeLine(row.text, filePath) || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--code-bg)] font-mono text-[11px] leading-5">
          <table className="w-full min-w-[640px] table-fixed border-collapse">
            <tbody>
              {splitRows.map((row, idx) => {
                if (row.kind === "hunk") {
                  return (
                    <tr key={idx} className="bg-[var(--diff-hunk-bg)] text-[var(--diff-hunk-text)]">
                      <td colSpan={4} className="whitespace-pre px-3 py-0.5 text-[10px]">
                        {row.hunkText}
                      </td>
                    </tr>
                  );
                }

                const leftBg =
                  row.leftType === "del"
                    ? "bg-[var(--diff-del-bg)]"
                    : row.leftType === "empty"
                      ? "bg-[var(--bg-elevated)]/40"
                      : "";
                const rightBg =
                  row.rightType === "add"
                    ? "bg-[var(--diff-add-bg)]"
                    : row.rightType === "empty"
                      ? "bg-[var(--bg-elevated)]/40"
                      : "";

                return (
                  <tr key={idx} className="align-top">
                    <td
                      className={`w-10 select-none border-r border-[var(--border-subtle)] px-1.5 text-right text-[10px] text-[var(--text-muted)] ${leftBg}`}
                    >
                      {row.leftLine ?? ""}
                    </td>
                    <td
                      className={`w-1/2 overflow-x-auto border-r border-[var(--border-strong)] whitespace-pre px-2 text-[var(--text-primary)] ${leftBg}`}
                    >
                      {row.leftType === "del" && (
                        <span className="mr-1 select-none font-bold text-[var(--diff-del-text)]">-</span>
                      )}
                      {row.leftText !== undefined
                        ? highlightCodeLine(row.leftText, filePath) || " "
                        : ""}
                    </td>
                    <td
                      className={`w-10 select-none border-r border-[var(--border-subtle)] px-1.5 text-right text-[10px] text-[var(--text-muted)] ${rightBg}`}
                    >
                      {row.rightLine ?? ""}
                    </td>
                    <td
                      className={`w-1/2 overflow-x-auto whitespace-pre px-2 text-[var(--text-primary)] ${rightBg}`}
                    >
                      {row.rightType === "add" && (
                        <span className="mr-1 select-none font-bold text-[var(--diff-add-text)]">+</span>
                      )}
                      {row.rightText !== undefined
                        ? highlightCodeLine(row.rightText, filePath) || " "
                        : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
