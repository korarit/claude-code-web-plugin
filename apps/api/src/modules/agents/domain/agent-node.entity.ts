import { truncate } from "@core/utils";

export type AgentActivityState =
  | "thinking"
  | "reading"
  | "editing"
  | "running_cmd"
  | "waiting"
  | "idle"
  | "done";

export interface AgentUsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface AgentNodeRecord {
  agentId: string;
  parentAgentId?: string;
  role: string;
  agentType?: string;
  transcriptPath?: string;
  canSendInput: boolean;
  state: AgentActivityState;
  currentTool?: string;
  currentTarget?: string;
  usage?: AgentUsageRecord;
  recentLogs: string[];
  startedAt: string;
  updatedAt: string;
}

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTaskRecord {
  id: string;
  subject: string;
  description?: string;
  owner?: string;
  status: TeamTaskStatus;
  source: "todo" | "team_task";
  updatedAt?: string;
}

const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "read_file",
  "view_file",
  "find_by_name",
  "grep_search",
  "list_dir",
]);
const EDIT_TOOLS = new Set([
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
const CMD_TOOLS = new Set(["Bash", "bash", "run_command"]);
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ask_question", "question"]);
const MAX_LOGS = 20;

export function extractToolTarget(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const obj = toolInput as Record<string, unknown>;
  const candidate =
    obj["file_path"] ??
    obj["filePath"] ??
    obj["TargetFile"] ??
    obj["Path"] ??
    obj["path"] ??
    obj["notebook_path"] ??
    obj["command"] ??
    obj["CommandLine"] ??
    obj["pattern"] ??
    obj["url"] ??
    obj["description"] ??
    obj["subagent_type"] ??
    obj["Role"] ??
    obj["prompt"] ??
    obj["Prompt"];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed ? truncate(trimmed, 80) : undefined;
}

export function deriveActivityFromTool(
  toolName: string,
  toolInput?: unknown,
): { state: AgentActivityState; target?: string } {
  const target = extractToolTarget(toolInput);
  if (QUESTION_TOOLS.has(toolName)) {
    return { state: "waiting", target };
  }
  if (READ_TOOLS.has(toolName)) {
    return { state: "reading", target };
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { state: "editing", target };
  }
  if (CMD_TOOLS.has(toolName)) {
    return { state: "running_cmd", target };
  }
  return { state: "thinking", target };
}

export function extractSubagentMeta(
  toolName: string,
  toolInput?: unknown,
): { role: string; agentType?: string } {
  if (!toolInput || typeof toolInput !== "object") {
    return { role: toolName };
  }
  const obj = toolInput as Record<string, unknown>;
  const rawType =
    typeof obj["subagent_type"] === "string" && obj["subagent_type"].trim()
      ? obj["subagent_type"].trim()
      : typeof obj["TypeName"] === "string" && obj["TypeName"].trim()
        ? obj["TypeName"].trim()
        : typeof obj["name"] === "string" && obj["name"].trim()
          ? obj["name"].trim()
          : undefined;
  const rawRole =
    typeof obj["Role"] === "string" && obj["Role"].trim()
      ? truncate(obj["Role"].trim(), 48)
      : undefined;
  if (rawRole) {
    return { role: rawRole, agentType: rawType };
  }
  const rawDesc =
    typeof obj["description"] === "string" && obj["description"].trim()
      ? truncate(obj["description"].trim(), 48)
      : undefined;

  if (rawDesc && rawType) {
    return { role: `${rawType}: ${rawDesc}`, agentType: rawType };
  }
  if (rawDesc) {
    return { role: rawDesc, agentType: rawType };
  }
  if (rawType) {
    return { role: rawType, agentType: rawType };
  }
  return { role: toolName };
}

export function appendAgentLog(logs: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return logs;
  if (logs[logs.length - 1] === trimmed) return logs;
  const next = [...logs, truncate(trimmed, 120)];
  if (next.length > MAX_LOGS) {
    return next.slice(next.length - MAX_LOGS);
  }
  return next;
}

export function normalizeTaskStatus(raw: unknown): TeamTaskStatus {
  if (raw === "completed" || raw === "done") return "completed";
  if (raw === "in_progress" || raw === "running" || raw === "active") return "in_progress";
  return "pending";
}

export function mapTodoWriteToTasks(toolInput: unknown, timestamp: string): TeamTaskRecord[] | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const obj = toolInput as Record<string, unknown>;
  if (!Array.isArray(obj["todos"])) return null;

  const items: TeamTaskRecord[] = [];
  for (let i = 0; i < obj["todos"].length; i++) {
    const raw = obj["todos"][i];
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const subject =
      typeof item["content"] === "string" && item["content"].trim()
        ? item["content"].trim()
        : typeof item["subject"] === "string" && item["subject"].trim()
          ? item["subject"].trim()
          : "";
    if (!subject) continue;

    const id =
      typeof item["id"] === "string" && item["id"].trim() ? item["id"].trim() : `todo-${i + 1}`;
    const owner = typeof item["owner"] === "string" && item["owner"].trim() ? item["owner"].trim() : undefined;
    const description =
      typeof item["activeForm"] === "string" && item["activeForm"].trim()
        ? item["activeForm"].trim()
        : undefined;

    items.push({
      id,
      subject,
      description,
      owner,
      status: normalizeTaskStatus(item["status"]),
      source: "todo",
      updatedAt: timestamp,
    });
  }

  return items;
}

export function mergeTaskLists(
  todoTasks: TeamTaskRecord[],
  diskTasks: TeamTaskRecord[],
): TeamTaskRecord[] {
  const map = new Map<string, TeamTaskRecord>();
  for (const t of todoTasks) {
    map.set(`todo:${t.id}`, t);
  }
  for (const t of diskTasks) {
    map.set(`team:${t.id}`, t);
  }
  return [...map.values()];
}
