export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type FileChangeSource = "session_tool" | "git_workspace";

export type FileDiffMode = "session" | "git";

export interface FileEditAttribution {
  harnessId: string;
  model: string;
  agentId?: string;
}

export interface FileEditRevision {
  revId: string;
  seq?: number;
  harnessId: string;
  model: string;
  agentId?: string;
  toolName: string;
  toolUseId?: string;
  additions: number;
  deletions: number;
  editedAt: string;
}

export interface SessionFileChange {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  source: FileChangeSource;
  lastUpdatedAt: string;
  lastEditedBy: FileEditAttribution;
  contributors: FileEditAttribution[];
  revisions: FileEditRevision[];
}

export interface SessionChangesSummary {
  filesCount: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface SessionChangesResponse {
  mode: FileDiffMode;
  files: SessionFileChange[];
  summary: SessionChangesSummary;
}

export interface FileDiffResponse {
  path: string;
  status: FileChangeStatus;
  mode: FileDiffMode;
  revId?: string;
  editedBy?: FileEditAttribution;
  originalText: string | null;
  modifiedText: string | null;
  unifiedDiff: string;
  isBinary: boolean;
  truncated: boolean;
}

export interface RawFileResponse {
  path: string;
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
  size: number;
}

export interface RevertFileRequest {
  path: string;
  mode?: FileDiffMode;
}

export interface RevertFileResponse {
  reverted: boolean;
  path: string;
  mode: FileDiffMode;
}
