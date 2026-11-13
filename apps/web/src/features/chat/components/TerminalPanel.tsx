import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { connectTerminalWs } from "../api.ts";

export interface TerminalPanelProps {
  activeSession?: SessionInfo;
  onContinueInWeb?: () => void;
  resuming?: boolean;
}

const ACCESSORY_KEYS: ReadonlyArray<{
  labelKey:
    | "terminalAccessoryTab"
    | "terminalAccessoryEsc"
    | "terminalAccessoryCtrlC"
    | "terminalAccessoryUp"
    | "terminalAccessoryDown"
    | "terminalAccessoryEnter";
  key: string;
}> = [
  { labelKey: "terminalAccessoryTab", key: "Tab" },
  { labelKey: "terminalAccessoryEsc", key: "Escape" },
  { labelKey: "terminalAccessoryCtrlC", key: "C-c" },
  { labelKey: "terminalAccessoryUp", key: "Up" },
  { labelKey: "terminalAccessoryDown", key: "Down" },
  { labelKey: "terminalAccessoryEnter", key: "Enter" },
];

export default function TerminalPanel({
  activeSession,
  onContinueInWeb,
  resuming = false,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const [screen, setScreen] = useState("");
  const [connected, setConnected] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [lineInput, setLineInput] = useState("");
  const [copiedAttach, setCopiedAttach] = useState(false);
  const connRef = useRef<ReturnType<typeof connectTerminalWs> | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const canAttach =
    Boolean(activeSession?.id) &&
    activeSession?.controlMode === "interactive" &&
    activeSession?.status !== "stopped" &&
    Boolean(activeSession?.tmuxSession);

  useEffect(() => {
    setScreen("");
    setWsError(null);
    setConnected(false);

    if (!activeSession || !canAttach) {
      return;
    }

    const conn = connectTerminalWs(activeSession.id, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
        if (msg.type === "screen") {
          setScreen(msg.content);
          setWsError(null);
        } else if (msg.type === "error") {
          setWsError(msg.message);
        }
      },
    });
    connRef.current = conn;

    return () => {
      conn.close();
      connRef.current = null;
      setConnected(false);
    };
  }, [activeSession?.id, activeSession?.tmuxSession, activeSession?.controlMode, canAttach]);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [screen]);

  const sendKey = (key: string) => {
    connRef.current?.send({ type: "key", key });
  };

  const sendLine = () => {
    const trimmed = lineInput;
    if (!trimmed.trim()) return;
    connRef.current?.send({ type: "text", text: trimmed });
    setLineInput("");
  };

  const copyAttachCmd = async () => {
    if (!activeSession?.tmuxSession) return;
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${activeSession.tmuxSession}`);
      setCopiedAttach(true);
      setTimeout(() => setCopiedAttach(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };

  if (!activeSession || !canAttach) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--bg-surface)] p-6 text-center text-xs text-[var(--text-muted)]">
        <p className="max-w-xs leading-relaxed">{t("terminalEmpty")}</p>
        {(activeSession?.controlMode === "mirror" || activeSession?.status === "stopped") &&
          onContinueInWeb && (
            <button
              type="button"
              disabled={resuming}
              onClick={onContinueInWeb}
              className="mt-3 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50"
            >
              {resuming
                ? t("continuingInWeb")
                : activeSession.controlMode === "mirror"
                  ? t("continueInWeb")
                  : t("resumeSession")}
            </button>
          )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              connected ? "bg-emerald-500" : "bg-[var(--text-muted)]"
            }`}
          />
          <span className="font-semibold text-[var(--text-primary)]">{t("terminalTitle")}</span>
          <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
            {activeSession.tmuxSession}
          </span>
        </div>

        <button
          type="button"
          onClick={() => void copyAttachCmd()}
          className="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          {copiedAttach ? t("copiedCode") : t("terminalAttachCopy")}
        </button>
      </div>

      {wsError && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
          {wsError}
        </div>
      )}

      <pre
        ref={preRef}
        className="min-h-0 flex-1 overflow-auto bg-[#0b0d12] p-3 font-mono text-[11px] leading-relaxed text-[#e5e7eb] whitespace-pre"
      >
        {screen || (connected ? t("loadingText") : t("terminalDisconnected"))}
      </pre>

      <div className="space-y-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
        <div className="flex flex-wrap items-center gap-1">
          {ACCESSORY_KEYS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => sendKey(item.key)}
              disabled={!connected}
              className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)] disabled:opacity-40"
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendLine();
          }}
          className="flex items-center gap-1.5"
        >
          <input
            type="text"
            value={lineInput}
            onChange={(e) => setLineInput(e.target.value)}
            placeholder={t("terminalInputPlaceholder")}
            disabled={!connected}
            className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <button
            type="submit"
            disabled={!connected || !lineInput.trim()}
            className="rounded bg-[var(--accent-primary)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-40"
          >
            {t("terminalSendLine")}
          </button>
        </form>
      </div>
    </div>
  );
}
