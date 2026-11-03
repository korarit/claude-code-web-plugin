import { useState } from "react";
import type { ModelId } from "@contracts/chat";
import { useChat } from "../hooks/useChat.ts";
import ContextBar from "./ContextBar.tsx";
import TaskTimeline from "./TaskTimeline.tsx";

const MODELS: readonly ModelId[] = ["sonnet", "opus", "haiku"];

export default function ChatView() {
  const { model, setModel, messages, tasks, usage, streaming, error, send, newSession } = useChat();
  const [draft, setDraft] = useState("");

  const submit = () => {
    void send(draft);
    setDraft("");
  };

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col gap-2 p-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold">Claude Web</h1>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-neutral-400" htmlFor="model">
            model
          </label>
          <select
            id="model"
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            value={model}
            onChange={(e) => setModel(e.target.value as ModelId)}
            disabled={streaming}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
            onClick={newSession}
            disabled={streaming}
          >
            new session
          </button>
        </div>
      </header>

      <ContextBar usage={usage} />
      <TaskTimeline tasks={tasks} />

      <main className="flex-1 space-y-3 overflow-y-auto rounded border border-neutral-800 p-3">
        {messages.length === 0 && (
          <p className="text-sm text-neutral-500">
            Type a prompt below to run it through your local Claude CLI session.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`whitespace-pre-wrap rounded p-2 text-sm ${
              m.role === "user" ? "bg-neutral-800" : "bg-neutral-900"
            }`}
          >
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">{m.role}</div>
            {m.text || (streaming ? "…" : "")}
          </div>
        ))}
      </main>

      {error && <div className="rounded border border-red-800 p-2 text-xs text-red-300">{error}</div>}

      <footer className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          placeholder="Ask Claude… (Enter to send)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={streaming}
        />
        <button
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          onClick={submit}
          disabled={streaming || !draft.trim()}
        >
          {streaming ? "…" : "Send"}
        </button>
      </footer>
    </div>
  );
}
