import { useCallback, useEffect, useState } from "react";
import type { HarnessDescriptor, HarnessId } from "@contracts/harness";
import { fetchHarnesses } from "../api.ts";

const FALLBACK_HARNESSES: HarnessDescriptor[] = [
  {
    id: "claude",
    name: "Claude",
    binary: "claude",
    available: true,
    models: ["sonnet", "opus", "haiku"],
    defaultModel: "sonnet",
    capabilities: {
      hooks: true,
      jsonlTranscript: true,
      serverApi: false,
      resume: true,
      subagents: true,
      externalDiscovery: true,
    },
  },
];

export function useHarnesses() {
  const [harnesses, setHarnesses] = useState<HarnessDescriptor[]>(FALLBACK_HARNESSES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchHarnesses();
      if (list.length > 0) {
        setHarnesses(list);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getHarnessDescriptor = useCallback(
    (id?: HarnessId): HarnessDescriptor => {
      return (
        harnesses.find((h) => h.id === id) ??
        harnesses.find((h) => h.available) ??
        harnesses[0] ??
        FALLBACK_HARNESSES[0]!
      );
    },
    [harnesses],
  );

  return {
    harnesses,
    loading,
    error,
    refresh,
    getHarnessDescriptor,
  };
}
