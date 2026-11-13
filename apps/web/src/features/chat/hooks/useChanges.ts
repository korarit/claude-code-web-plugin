import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileDiffMode,
  FileDiffResponse,
  RawFileResponse,
  SessionChangesSummary,
  SessionFileChange,
} from "@contracts/changes";
import {
  fetchFileDiff,
  fetchRawFile,
  fetchSessionChanges,
  revertFileChange,
} from "../api.ts";

export type DiffViewMode = "unified" | "split" | "raw";

function computeSummary(files: SessionFileChange[]): SessionChangesSummary {
  return {
    filesCount: files.length,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

export function useChanges({
  activeSessionId,
  isDesktop,
}: {
  activeSessionId?: string;
  isDesktop: boolean;
}) {
  const [mode, setMode] = useState<FileDiffMode>("session");
  const [files, setFiles] = useState<SessionFileChange[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedRevId, setSelectedRevId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>(isDesktop ? "split" : "unified");
  const [contributorFilter, setContributorFilter] = useState<string>("all");
  const [diff, setDiff] = useState<FileDiffResponse | null>(null);
  const [rawFile, setRawFile] = useState<RawFileResponse | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userChoseViewModeRef = useRef(false);
  const preserveSelectionOnModeSwitchRef = useRef(false);

  useEffect(() => {
    if (!userChoseViewModeRef.current) {
      setViewMode(isDesktop ? "split" : "unified");
    }
  }, [isDesktop]);

  const handleSetViewMode = useCallback((next: DiffViewMode) => {
    userChoseViewModeRef.current = true;
    setViewMode(next);
  }, []);

  const refreshList = useCallback(
    async (targetSessionId = activeSessionId, targetMode = mode) => {
      if (!targetSessionId) {
        setFiles([]);
        return;
      }
      setLoadingList(true);
      try {
        const res = await fetchSessionChanges(targetSessionId, targetMode);
        setFiles(res.files);
        setSelectedPath((prev) => {
          if (prev && res.files.some((f) => f.path === prev)) return prev;
          return res.files[0]?.path ?? null;
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingList(false);
      }
    },
    [activeSessionId, mode],
  );

  // Reset and fetch changes when session or mode changes.
  useEffect(() => {
    setError(null);
    setDiff(null);
    setRawFile(null);
    if (preserveSelectionOnModeSwitchRef.current) {
      preserveSelectionOnModeSwitchRef.current = false;
    } else {
      setSelectedRevId(null);
      setContributorFilter("all");
    }
    if (!activeSessionId) {
      setFiles([]);
      setSelectedPath(null);
      return;
    }
    void refreshList(activeSessionId, mode);
  }, [activeSessionId, mode, refreshList]);

  // Fetch diff or raw file whenever selection / mode / revId / viewMode changes.
  const loadDetail = useCallback(async () => {
    if (!activeSessionId || !selectedPath) {
      setDiff(null);
      setRawFile(null);
      return;
    }
    setLoadingDetail(true);
    setError(null);
    try {
      if (viewMode === "raw") {
        const raw = await fetchRawFile(activeSessionId, selectedPath);
        setRawFile(raw);
      } else {
        const d = await fetchFileDiff(
          activeSessionId,
          selectedPath,
          mode,
          mode === "session" ? (selectedRevId ?? undefined) : undefined,
        );
        setDiff(d);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingDetail(false);
    }
  }, [activeSessionId, mode, selectedPath, selectedRevId, viewMode]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const applyFileChangedEvent = useCallback(
    (changed: SessionFileChange) => {
      if (mode === "git") {
        void refreshList(activeSessionId, "git");
        return;
      }
      setFiles((prev) => {
        const without = prev.filter((f) => f.path !== changed.path);
        return [changed, ...without].sort((a, b) =>
          a.lastUpdatedAt < b.lastUpdatedAt ? 1 : -1,
        );
      });
      setSelectedPath((prev) => prev ?? changed.path);
      if (selectedPath === changed.path) {
        void loadDetail();
      }
    },
    [activeSessionId, loadDetail, mode, refreshList, selectedPath],
  );

  const openFileChange = useCallback(
    (path: string, revId?: string) => {
      if (mode !== "session") {
        preserveSelectionOnModeSwitchRef.current = true;
        setMode("session");
      }
      setSelectedPath(path);
      setSelectedRevId(revId ?? null);
    },
    [mode],
  );

  const revert = useCallback(
    async (path: string) => {
      if (!activeSessionId) return;
      setReverting(true);
      setError(null);
      try {
        await revertFileChange(activeSessionId, path, mode);
        setSelectedRevId(null);
        await refreshList(activeSessionId, mode);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setReverting(false);
      }
    },
    [activeSessionId, mode, refreshList],
  );

  const summary = useMemo(() => computeSummary(files), [files]);

  const contributorOptions = useMemo(() => {
    const keys = new Map<string, string>();
    for (const f of files) {
      for (const c of f.contributors) {
        keys.set(`harness:${c.harnessId}`, `Harness: ${c.harnessId}`);
        keys.set(`model:${c.model}`, `Model: ${c.model}`);
        if (c.agentId) {
          keys.set(`agent:${c.agentId}`, `Agent: ${c.agentId.slice(0, 8)}`);
        }
      }
    }
    return [...keys.entries()].map(([value, label]) => ({ value, label }));
  }, [files]);

  const filteredFiles = useMemo(() => {
    if (contributorFilter === "all") return files;
    const sep = contributorFilter.indexOf(":");
    if (sep < 0) return files;
    const kind = contributorFilter.slice(0, sep);
    const val = contributorFilter.slice(sep + 1);
    return files.filter((f) =>
      f.contributors.some((c) => {
        if (kind === "harness") return c.harnessId === val;
        if (kind === "model") return c.model === val;
        if (kind === "agent") return c.agentId === val;
        return true;
      }),
    );
  }, [contributorFilter, files]);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  return {
    mode,
    setMode,
    files,
    filteredFiles,
    summary,
    selectedPath,
    setSelectedPath: (path: string | null) => {
      setSelectedPath(path);
      setSelectedRevId(null);
    },
    selectedRevId,
    setSelectedRevId,
    selectedFile,
    viewMode,
    setViewMode: handleSetViewMode,
    contributorFilter,
    setContributorFilter,
    contributorOptions,
    diff,
    rawFile,
    loadingList,
    loadingDetail,
    reverting,
    error,
    refreshList,
    applyFileChangedEvent,
    openFileChange,
    revert,
  };
}
