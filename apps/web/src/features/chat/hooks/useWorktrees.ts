import { useCallback, useEffect, useState } from "react";
import type {
  CreateWorktreeRequest,
  GitWorktreeInfo,
  MergeWorktreeRequest,
  RemoveWorktreeRequest,
} from "@contracts/workspace";
import {
  createWorktree,
  fetchWorktrees,
  mergeWorktree,
  removeWorktree,
} from "../api.ts";

export function useWorktrees(cwd?: string) {
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (targetCwd = cwd) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWorktrees(targetCwd);
        setRepoRoot(res.repoRoot);
        setWorktrees(res.worktrees);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void refresh(cwd);
  }, [cwd, refresh]);

  const create = useCallback(
    async (req: CreateWorktreeRequest) => {
      setBusy(true);
      setError(null);
      try {
        const res = await createWorktree({ ...req, cwd: req.cwd ?? cwd });
        await refresh(req.cwd ?? cwd);
        return res.worktree;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [cwd, refresh],
  );

  const merge = useCallback(
    async (req: MergeWorktreeRequest) => {
      setBusy(true);
      setError(null);
      try {
        const res = await mergeWorktree({ ...req, cwd: req.cwd ?? cwd });
        await refresh(req.cwd ?? cwd);
        return res;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [cwd, refresh],
  );

  const remove = useCallback(
    async (req: RemoveWorktreeRequest) => {
      setBusy(true);
      setError(null);
      try {
        const res = await removeWorktree({ ...req, cwd: req.cwd ?? cwd });
        await refresh(req.cwd ?? cwd);
        return res;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [cwd, refresh],
  );

  return {
    repoRoot,
    worktrees,
    loading,
    busy,
    error,
    refresh,
    create,
    merge,
    remove,
  };
}
