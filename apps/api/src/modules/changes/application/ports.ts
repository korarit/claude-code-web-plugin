import type { FileChangeStatus, SessionFileChange } from "@contracts/changes";

export interface SessionRef {
  id: string;
  cwd?: string;
  harnessId: string;
  model: string;
}

export interface SessionLookupPort {
  getSession(sessionId: string): SessionRef | null;
}

export interface ChangeEventPublisherPort {
  publishFileChanged(sessionId: string, fileChange: SessionFileChange, timestamp: string): void;
}

export interface SnapshotStorePort {
  saveSnapshot(sessionId: string, key: string, bytes: Uint8Array): Promise<void>;
  loadSnapshot(sessionId: string, key: string): Promise<Uint8Array | null>;
  deleteSessionSnapshots(sessionId: string): Promise<void>;
}

export interface SafeResolvedPath {
  absPath: string;
  relPath: string;
}

export interface WorkspaceFilePort {
  resolveSafePath(cwd: string, targetPath: string): Promise<SafeResolvedPath>;
  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, bytes: Uint8Array): Promise<void>;
  removeFile(absPath: string): Promise<void>;
}

export interface GitChangedFile {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
}

export interface GitWorkspacePort {
  isGitRepo(cwd: string): Promise<boolean>;
  listChanges(cwd: string): Promise<GitChangedFile[]>;
  readHeadFile(cwd: string, relPath: string): Promise<Uint8Array | null>;
  revertFile(cwd: string, relPath: string): Promise<void>;
}
