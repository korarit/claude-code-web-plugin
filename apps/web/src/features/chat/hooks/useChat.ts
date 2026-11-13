import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuthMode,
  ChatStreamEvent,
  ConcurrencyWarning,
  ModelId,
  PendingInteraction,
  PermissionDecision,
  PermissionPromptPayload,
  SessionInfo,
  SessionStatus,
} from "@contracts/chat";
import { newMessageId } from "@core/ids";
import {
  abortSession,
  resumeSession,
  sendChat,
  sendInput,
  subscribeSessionEvents,
  uploadChatImage,
} from "../api.ts";

export interface ToolBlock {
  id: string;
  tool: string;
  summary: string;
  input?: unknown;
  subAgent: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ToolBlock[];
  timestamp?: string;
}

export interface TaskEntry {
  id: string;
  tool: string;
  label: string;
  subAgent: boolean;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  costUsd?: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const NEW_DRAFT_KEY = "__new__";

export interface UseChatOptions {
  activeSessionId?: string;
  activeSession?: SessionInfo;
  defaultCwd?: string;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionUpdated?: (session: SessionInfo) => void;
  onErrorNotification?: () => void;
}

export function useChat({
  activeSessionId,
  activeSession,
  defaultCwd,
  onSessionCreated,
  onSessionUpdated,
  onErrorNotification,
}: UseChatOptions) {
  const [model, setModel] = useState<ModelId>(activeSession?.model ?? "sonnet");
  const [cwd, setCwd] = useState<string>(defaultCwd ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>(activeSession?.authMode ?? "machine_default");
  const [agentProfile, setAgentProfile] = useState<string>(activeSession?.agentProfile ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [usage, setUsage] = useState<UsageState>({
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  });
  const [status, setStatus] = useState<SessionStatus>(activeSession?.status ?? "idle");
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptPayload | null>(null);
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(
    activeSession?.pendingInteraction ?? null,
  );
  const [concurrencyWarning, setConcurrencyWarning] = useState<ConcurrencyWarning | null>(null);
  const [submittingInteraction, setSubmittingInteraction] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenEventIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (defaultCwd && !cwd) {
      setCwd(defaultCwd);
    }
  }, [defaultCwd, cwd]);

  useEffect(() => {
    if (!activeSessionId) {
      setAuthMode("machine_default");
      setAgentProfile("");
      return;
    }
    if (activeSession?.model) {
      setModel(activeSession.model);
    }
    if (activeSession?.authMode) {
      setAuthMode(activeSession.authMode);
    }
    if (activeSession?.agentProfile !== undefined) {
      setAgentProfile(activeSession.agentProfile ?? "");
    }
    if (activeSession?.status) {
      setStatus(activeSession.status);
      if (activeSession.status !== "waiting_permission") {
        setPermissionPrompt(null);
        setPendingInteraction(null);
        setSubmittingInteraction(false);
      } else if (activeSession.pendingInteraction) {
        setPendingInteraction(activeSession.pendingInteraction);
      }
    }
  }, [
    activeSessionId,
    activeSession?.id,
    activeSession?.model,
    activeSession?.authMode,
    activeSession?.agentProfile,
    activeSession?.status,
    activeSession?.pendingInteraction,
  ]);

  const applyEvent = useCallback(
    (event: ChatStreamEvent) => {
      if (event.id) {
        const dedupKey = `${event.type}:${event.id}:${event.toolUseId ?? ""}:${event.text?.slice(0, 24) ?? ""}`;
        if (seenEventIdsRef.current.has(dedupKey)) return;
        seenEventIdsRef.current.add(dedupKey);
      }

      switch (event.type) {
        case "init":
          if (event.usage?.contextWindow) {
            setUsage((u) => ({ ...u, contextWindow: event.usage!.contextWindow! }));
          }
          break;

        case "status":
          if (event.status) {
            setStatus(event.status);
            if (event.status !== "waiting_permission") {
              setPermissionPrompt(null);
              setPendingInteraction(null);
              setSubmittingInteraction(false);
            }
          }
          break;

        case "permission_prompt":
          setStatus("waiting_permission");
          setPermissionPrompt(event.permissionPrompt ?? { message: "Permission requested" });
          break;

        case "interaction":
          if (event.interaction) {
            setStatus("waiting_permission");
            setPendingInteraction(event.interaction);
            setSubmittingInteraction(false);
          }
          break;

        case "interaction_resolved":
          setPendingInteraction((prev) => {
            if (!prev) return null;
            if (
              !event.interactionId ||
              prev.id === event.interactionId ||
              (prev.kind === "question" && prev.toolUseId === event.interactionId)
            ) {
              return null;
            }
            return prev;
          });
          setPermissionPrompt(null);
          setSubmittingInteraction(false);
          break;

        case "user":
          if (event.text) {
            const text = event.text;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "user" && last.text.trim() === text.trim()) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: event.id ?? newMessageId(),
                  role: "user",
                  text,
                  timestamp: event.timestamp,
                },
              ];
            });
          }
          break;

        case "delta":
          if (event.text) {
            const text = event.text;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                if (last.text === text) return prev;
                const nextText = last.text ? `${last.text}\n\n${text}` : text;
                return [...prev.slice(0, -1), { ...last, text: nextText }];
              }
              return [
                ...prev,
                {
                  id: event.id ?? newMessageId(),
                  role: "assistant",
                  text,
                  timestamp: event.timestamp,
                },
              ];
            });
          }
          break;

        case "tool":
        case "task": {
          const toolName = event.tool ?? event.type;
          const summary = event.text ?? toolName;
          const subAgent =
            event.type === "task" || (event.parentToolUseId ?? null) !== null;
          const block: ToolBlock = {
            id: event.toolUseId ?? event.id ?? newMessageId(),
            tool: toolName,
            summary,
            input: event.toolInput,
            subAgent,
          };

          setTasks((prev) => [
            ...prev,
            { id: block.id, tool: toolName, label: summary, subAgent },
          ]);

          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              const existingTools = last.tools ?? [];
              if (existingTools.some((t) => t.id === block.id && t.summary === block.summary)) {
                return prev;
              }
              return [...prev.slice(0, -1), { ...last, tools: [...existingTools, block] }];
            }
            return [
              ...prev,
              {
                id: newMessageId(),
                role: "assistant",
                text: "",
                tools: [block],
                timestamp: event.timestamp,
              },
            ];
          });
          break;
        }

        case "result":
          if (event.usage) {
            setUsage((u) => ({
              ...u,
              inputTokens: event.usage!.inputTokens ?? u.inputTokens,
              outputTokens: event.usage!.outputTokens ?? u.outputTokens,
              contextWindow: event.usage!.contextWindow ?? u.contextWindow,
              costUsd: event.costUsd ?? u.costUsd,
            }));
          } else if (event.costUsd !== undefined) {
            setUsage((u) => ({ ...u, costUsd: event.costUsd }));
          }
          break;

        case "error":
          setError(event.message ?? "Unknown error");
          onErrorNotification?.();
          break;
      }
    },
    [onErrorNotification],
  );

  useEffect(() => {
    seenEventIdsRef.current = new Set();
    setMessages([]);
    setTasks([]);
    setError(null);
    setPermissionPrompt(null);
    setPendingInteraction(activeSession?.pendingInteraction ?? null);
    setSubmittingInteraction(false);
    setConcurrencyWarning(null);
    setUsage({
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });

    if (!activeSessionId) {
      setStatus("idle");
      return;
    }

    const unsub = subscribeSessionEvents(activeSessionId, applyEvent);
    return () => {
      unsub();
    };
  }, [activeSessionId, applyEvent]);

  const draftKey = activeSessionId ?? NEW_DRAFT_KEY;
  const draft = drafts[draftKey] ?? "";

  const setDraft = useCallback(
    (value: string) => {
      setDrafts((prev) => ({ ...prev, [draftKey]: value }));
    },
    [draftKey],
  );

  const send = useCallback(
    async (promptInput?: string) => {
      const text = (promptInput ?? draft).trim();
      if (!text || sending || status === "running" || status === "waiting_permission") return;

      setError(null);
      setSending(true);
      if (promptInput === undefined) {
        setDrafts((prev) => ({ ...prev, [draftKey]: "" }));
      }

      try {
        const res = await sendChat({
          prompt: text,
          sessionId: activeSessionId,
          model,
          cwd: activeSessionId ? undefined : cwd.trim() || undefined,
          authMode: activeSessionId ? undefined : authMode,
          agentProfile: activeSessionId ? undefined : agentProfile.trim() || undefined,
        });
        setStatus(res.session.status);
        setConcurrencyWarning(res.concurrencyWarning ?? null);
        if (res.isNewSession) {
          onSessionCreated?.(res.session);
        } else {
          onSessionUpdated?.(res.session);
        }
      } catch (e) {
        setError((e as Error).message);
        if (promptInput === undefined) {
          setDrafts((prev) => ({ ...prev, [draftKey]: text }));
        }
      } finally {
        setSending(false);
      }
    },
    [
      activeSessionId,
      agentProfile,
      authMode,
      cwd,
      draft,
      draftKey,
      model,
      onSessionCreated,
      onSessionUpdated,
      sending,
      status,
    ],
  );

  const switchModelMidSession = useCallback(
    async (nextModel: ModelId) => {
      setModel(nextModel);
      if (
        activeSession &&
        activeSession.controlMode === "interactive" &&
        activeSession.status === "idle"
      ) {
        await send(`/model ${nextModel}`);
      }
    },
    [activeSession, send],
  );

  const submitDecision = useCallback(
    async (decision: PermissionDecision) => {
      if (!activeSessionId) return;
      setError(null);
      setSubmittingInteraction(true);
      try {
        const res = await sendInput({
          sessionId: activeSessionId,
          interactionId: pendingInteraction?.id,
          inputType: "decision",
          value: decision,
        });
        setStatus(res.session.status);
        if (res.resolved) {
          setPendingInteraction(null);
          setPermissionPrompt(null);
        }
        onSessionUpdated?.(res.session);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSubmittingInteraction(false);
      }
    },
    [activeSessionId, onSessionUpdated, pendingInteraction?.id],
  );

  const submitQuestion = useCallback(
    async (answers: Record<string, string | string[]>) => {
      if (!activeSessionId) return;
      setError(null);
      setSubmittingInteraction(true);
      try {
        const res = await sendInput({
          sessionId: activeSessionId,
          interactionId: pendingInteraction?.id,
          inputType: "selection",
          value: answers,
        });
        onSessionUpdated?.(res.session);
      } catch (e) {
        setError((e as Error).message);
        setSubmittingInteraction(false);
      }
    },
    [activeSessionId, onSessionUpdated, pendingInteraction?.id],
  );

  const continueInWeb = useCallback(async () => {
    if (!activeSessionId) return;
    setError(null);
    setResuming(true);
    try {
      const res = await resumeSession(activeSessionId, {
        model,
        authMode,
        agentProfile: agentProfile.trim() || undefined,
      });
      setConcurrencyWarning(res.concurrencyWarning ?? null);
      setStatus(res.session.status);
      onSessionUpdated?.(res.session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResuming(false);
    }
  }, [activeSessionId, agentProfile, authMode, model, onSessionUpdated]);

  const uploadImage = useCallback(
    async (file: File) => {
      setError(null);
      setUploadingImage(true);
      try {
        const targetCwd = activeSession?.cwd || cwd.trim() || undefined;
        const uploaded = await uploadChatImage(file, targetCwd);
        setDrafts((prev) => {
          const current = prev[draftKey] ?? "";
          const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
          return { ...prev, [draftKey]: `${current}${sep}${uploaded.path} ` };
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploadingImage(false);
      }
    },
    [activeSession?.cwd, cwd, draftKey],
  );

  const abort = useCallback(async () => {
    if (!activeSessionId) return;
    setError(null);
    try {
      const updated = await abortSession(activeSessionId);
      setStatus(updated.status);
      setPendingInteraction(null);
      setPermissionPrompt(null);
      onSessionUpdated?.(updated);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeSessionId, onSessionUpdated]);

  return {
    model,
    setModel: switchModelMidSession,
    cwd,
    setCwd,
    authMode,
    setAuthMode,
    agentProfile,
    setAgentProfile,
    draft,
    setDraft,
    messages,
    tasks,
    usage,
    status,
    permissionPrompt,
    pendingInteraction,
    concurrencyWarning,
    submittingInteraction,
    resuming,
    uploadingImage,
    sending,
    error,
    send,
    abort,
    submitDecision,
    submitQuestion,
    continueInWeb,
    uploadImage,
  };
}
