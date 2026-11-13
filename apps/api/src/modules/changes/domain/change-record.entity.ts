import type {
  FileChangeStatus,
  FileEditAttribution,
  FileEditRevision,
  SessionFileChange,
} from "@contracts/changes";

export const FILE_EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_file",
  "edit_file",
  "edit",
  "write",
  "patch",
  "multiedit",
]);

export function isFileEditTool(toolName?: string): boolean {
  return Boolean(toolName && FILE_EDIT_TOOLS.has(toolName));
}

export function extractToolTargetPath(toolName: string, toolInput: unknown): string | null {
  if (!isFileEditTool(toolName) || !toolInput || typeof toolInput !== "object") {
    return null;
  }
  const obj = toolInput as Record<string, unknown>;
  const candidate =
    toolName === "NotebookEdit"
      ? (obj["notebook_path"] ?? obj["file_path"] ?? obj["path"])
      : (obj["file_path"] ??
        obj["filePath"] ??
        obj["TargetFile"] ??
        obj["Path"] ??
        obj["path"] ??
        obj["notebook_path"]);
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export interface TrackedRevisionRecord extends FileEditRevision {
  beforeKey?: string;
  beforeMissing?: boolean;
  afterKey?: string;
  afterMissing?: boolean;
}

export interface TrackedFileRecord {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  source: "session_tool";
  lastUpdatedAt: string;
  lastEditedBy: FileEditAttribution;
  contributors: FileEditAttribution[];
  revisions: TrackedRevisionRecord[];
  baselineKey?: string;
  baselineMissing?: boolean;
  latestSnapshotKey?: string;
  latestMissing?: boolean;
}

export function dedupeAttributions(list: FileEditAttribution[]): FileEditAttribution[] {
  const seen = new Set<string>();
  const result: FileEditAttribution[] = [];
  for (const item of list) {
    const key = `${item.harnessId}\0${item.model}\0${item.agentId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function toSessionFileChange(record: TrackedFileRecord): SessionFileChange {
  return {
    path: record.path,
    status: record.status,
    additions: record.additions,
    deletions: record.deletions,
    source: record.source,
    lastUpdatedAt: record.lastUpdatedAt,
    lastEditedBy: record.lastEditedBy,
    contributors: record.contributors,
    revisions: record.revisions.map((r) => ({
      revId: r.revId,
      seq: r.seq,
      harnessId: r.harnessId,
      model: r.model,
      agentId: r.agentId,
      toolName: r.toolName,
      toolUseId: r.toolUseId,
      additions: r.additions,
      deletions: r.deletions,
      editedAt: r.editedAt,
    })),
  };
}
