export const MAX_PREVIEW_BYTES = 256 * 1024; // 256 KiB

export function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export function decodePreviewText(
  bytes: Uint8Array | null,
  maxBytes = MAX_PREVIEW_BYTES,
): { text: string | null; isBinary: boolean; truncated: boolean } {
  if (bytes === null) {
    return { text: null, isBinary: false, truncated: false };
  }
  if (isBinaryBytes(bytes)) {
    return { text: null, isBinary: true, truncated: false };
  }
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, isBinary: false, truncated };
}

export function normalizeModelLabel(rawModel?: string, fallbackModel = "sonnet"): string {
  const val = rawModel?.trim();
  if (!val) return fallbackModel;
  const lower = val.toLowerCase();
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return val;
}

export function splitLines(text: string | null): string[] {
  if (text === null || text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

type DiffOpType = "equal" | "del" | "add";

interface DiffOp {
  type: DiffOpType;
  line: string;
}

function computeLineOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: "equal", line: oldLines[i]! });
  }

  const midOld = oldLines.slice(prefix, n - suffix);
  const midNew = newLines.slice(prefix, m - suffix);
  const aLen = midOld.length;
  const bLen = midNew.length;

  if (aLen === 0 && bLen === 0) {
    // Nothing changed in middle.
  } else if (aLen === 0) {
    for (const line of midNew) ops.push({ type: "add", line });
  } else if (bLen === 0) {
    for (const line of midOld) ops.push({ type: "del", line });
  } else if (aLen * bLen > 2_000_000) {
    // Guard against huge files causing excessive DP memory.
    for (const line of midOld) ops.push({ type: "del", line });
    for (const line of midNew) ops.push({ type: "add", line });
  } else {
    // Standard LCS DP on middle slice.
    const width = bLen + 1;
    const dp = new Int32Array((aLen + 1) * width);

    for (let i = aLen - 1; i >= 0; i--) {
      const rowOffset = i * width;
      const nextRowOffset = (i + 1) * width;
      const lineA = midOld[i]!;
      for (let j = bLen - 1; j >= 0; j--) {
        if (lineA === midNew[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1;
        } else {
          const down = dp[nextRowOffset + j]!;
          const right = dp[rowOffset + j + 1]!;
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < aLen && j < bLen) {
      if (midOld[i] === midNew[j]) {
        ops.push({ type: "equal", line: midOld[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
        ops.push({ type: "del", line: midOld[i]! });
        i++;
      } else {
        ops.push({ type: "add", line: midNew[j]! });
        j++;
      }
    }
    while (i < aLen) {
      ops.push({ type: "del", line: midOld[i]! });
      i++;
    }
    while (j < bLen) {
      ops.push({ type: "add", line: midNew[j]! });
      j++;
    }
  }

  for (let k = n - suffix; k < n; k++) {
    ops.push({ type: "equal", line: oldLines[k]! });
  }

  return ops;
}

export function computeLineStats(
  originalText: string | null,
  modifiedText: string | null,
): { additions: number; deletions: number } {
  if (originalText === modifiedText) return { additions: 0, deletions: 0 };
  const oldLines = splitLines(originalText);
  const newLines = splitLines(modifiedText);
  const ops = computeLineOps(oldLines, newLines);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") additions++;
    else if (op.type === "del") deletions++;
  }
  return { additions, deletions };
}

export function buildUnifiedDiff(
  relPath: string,
  originalText: string | null,
  modifiedText: string | null,
  contextLines = 3,
): string {
  const oldLines = splitLines(originalText);
  const newLines = splitLines(modifiedText);
  const ops = computeLineOps(oldLines, newLines);

  const hasChanges = ops.some((o) => o.type !== "equal");
  if (!hasChanges) return "";

  interface IndexedOp extends DiffOp {
    oldLine: number;
    newLine: number;
  }

  const indexed: IndexedOp[] = [];
  let oldLn = 1;
  let newLn = 1;
  for (const op of ops) {
    indexed.push({ ...op, oldLine: oldLn, newLine: newLn });
    if (op.type === "equal") {
      oldLn++;
      newLn++;
    } else if (op.type === "del") {
      oldLn++;
    } else {
      newLn++;
    }
  }

  // Group change indices into hunks with surrounding context.
  const changeIndices: number[] = [];
  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i]!.type !== "equal") changeIndices.push(i);
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(indexed.length - 1, idx + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const out: string[] = [
    originalText === null ? "--- /dev/null" : `--- a/${relPath}`,
    modifiedText === null ? "+++ /dev/null" : `+++ b/${relPath}`,
  ];

  for (const range of ranges) {
    const slice = indexed.slice(range.start, range.end + 1);
    const first = slice[0]!;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];

    for (const item of slice) {
      if (item.type === "equal") {
        oldCount++;
        newCount++;
        body.push(` ${item.line}`);
      } else if (item.type === "del") {
        oldCount++;
        body.push(`-${item.line}`);
      } else {
        newCount++;
        body.push(`+${item.line}`);
      }
    }

    const oldStart = originalText === null && oldCount === 0 ? 0 : first.oldLine;
    const newStart = modifiedText === null && newCount === 0 ? 0 : first.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }

  return out.join("\n") + "\n";
}
