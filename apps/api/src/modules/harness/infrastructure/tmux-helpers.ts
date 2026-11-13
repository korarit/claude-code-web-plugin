import type { ChatInputRequest, QuestionItem } from "@contracts/chat";
import type { ExecCommandFn } from "./binary-probe.ts";
import { HarnessSpawnError } from "../domain/errors.ts";
import type { HarnessId } from "@contracts/harness";

export interface ActiveTmuxPane {
  name: string;
  cwd?: string;
  paneCommand?: string;
  panePid?: number;
}

export interface KeystrokeStep {
  keys?: string[];
  text?: string;
}

export function buildTuiQuestionKeystrokes(
  questions: QuestionItem[],
  rawValue: ChatInputRequest["value"],
): KeystrokeStep[] {
  const steps: KeystrokeStep[] = [];
  const valueMap: Record<string, string | string[]> =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue
      : questions[0]
        ? { [questions[0].id]: rawValue as string | string[] }
        : {};

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const answer = valueMap[q.id];
    const selections = Array.isArray(answer) ? answer : answer ? [String(answer)] : [];

    if (q.multiSelect) {
      let cursor = 0;
      const matchedIndices = selections
        .map((sel) => q.options.findIndex((o) => o.id === sel || o.label === sel))
        .filter((idx) => idx >= 0)
        .sort((a, b) => a - b);

      for (const targetIdx of matchedIndices) {
        const delta = targetIdx - cursor;
        for (let i = 0; i < delta; i++) steps.push({ keys: ["Down"] });
        steps.push({ keys: ["Space"] });
        cursor = targetIdx;
      }

      const customAnswers = selections.filter(
        (sel) => !q.options.some((o) => o.id === sel || o.label === sel),
      );
      if (customAnswers.length > 0 && q.allowCustomText !== false) {
        const delta = q.options.length - cursor;
        for (let i = 0; i < delta; i++) steps.push({ keys: ["Down"] });
        steps.push({ keys: ["Enter"] });
        steps.push({ text: customAnswers.join(", ") });
      } else {
        steps.push({ keys: ["Enter"] });
      }
    } else {
      const first = selections[0] ?? "";
      const targetIdx = q.options.findIndex((o) => o.id === first || o.label === first);

      if (targetIdx >= 0) {
        const keys: string[] = [];
        for (let i = 0; i < targetIdx; i++) keys.push("Down");
        keys.push("Enter");
        steps.push({ keys });
      } else if (first && q.allowCustomText !== false) {
        const keys: string[] = [];
        for (let i = 0; i < q.options.length; i++) keys.push("Down");
        keys.push("Enter");
        steps.push({ keys });
        steps.push({ text: first });
      }
    }

    if (questions.length > 1 && qIdx === questions.length - 1) {
      steps.push({ keys: ["Enter"] });
    }
  }

  return steps;
}

export async function listTmuxPanes(
  exec: ExecCommandFn,
  tmuxBin = "tmux",
): Promise<ActiveTmuxPane[]> {
  const res = await exec([
    tmuxBin,
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}",
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));

  if (res.exitCode !== 0) return [];
  const panes: ActiveTmuxPane[] = [];
  for (const rawLine of res.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [name, cwd, paneCommand, panePidStr] = line.split("\t");
    if (!name) continue;
    const panePid = panePidStr ? Number(panePidStr) : undefined;
    panes.push({
      name,
      cwd: cwd || undefined,
      paneCommand: paneCommand || undefined,
      panePid: Number.isFinite(panePid) ? panePid : undefined,
    });
  }
  return panes;
}

export async function pasteBufferToTmux(
  harnessId: HarnessId,
  exec: ExecCommandFn,
  tmuxSession: string,
  text: string,
  tmuxBin = "tmux",
): Promise<void> {
  const bufName = `cw-buf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const loadRes = await exec([tmuxBin, "load-buffer", "-b", bufName, "-"], { stdin: text });
  if (loadRes.exitCode !== 0) {
    throw new HarnessSpawnError(
      harnessId,
      loadRes.stderr.trim() || `tmux load-buffer failed (${loadRes.exitCode})`,
    );
  }
  const pasteRes = await exec([tmuxBin, "paste-buffer", "-b", bufName, "-t", tmuxSession]);
  await exec([tmuxBin, "delete-buffer", "-b", bufName]).catch(() => {});
  if (pasteRes.exitCode !== 0) {
    throw new HarnessSpawnError(
      harnessId,
      pasteRes.stderr.trim() || `tmux paste-buffer failed (${pasteRes.exitCode})`,
    );
  }
  const enterRes = await exec([tmuxBin, "send-keys", "-t", tmuxSession, "Enter"]);
  if (enterRes.exitCode !== 0) {
    throw new HarnessSpawnError(
      harnessId,
      enterRes.stderr.trim() || `tmux send-keys Enter failed (${enterRes.exitCode})`,
    );
  }
}
