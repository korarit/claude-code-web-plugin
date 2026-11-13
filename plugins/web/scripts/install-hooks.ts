import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommandEntry[];
}

interface HooksConfigFile {
  description?: string;
  hooks?: Record<string, HookMatcherGroup[]>;
  [key: string]: unknown;
}

interface HookEventSpec {
  event: string;
  matcher?: string;
  timeout?: number;
}

const CLAUDE_HOOK_EVENTS: readonly HookEventSpec[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "PermissionRequest", matcher: "*", timeout: 65 },
  { event: "Notification" },
  { event: "Stop" },
  { event: "SessionEnd" },
  { event: "SubagentStart" },
  { event: "SubagentStop" },
  { event: "TeammateIdle" },
  { event: "TaskCreated" },
  { event: "TaskCompleted" },
];

const AGY_HOOK_EVENTS: readonly HookEventSpec[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "*", timeout: 65 },
  { event: "PostToolUse", matcher: "*" },
  { event: "Stop" },
  { event: "SessionEnd" },
  { event: "SubagentStart" },
  { event: "SubagentStop" },
];

export interface HookTargetResult {
  target: "claude" | "agy";
  path: string;
  changed: boolean;
  backupPath?: string;
  eventsUpdated: string[];
}

export interface ManageHooksOptions {
  action: "install" | "uninstall";
  claudeSettingsPath?: string;
  agyHooksPath?: string;
  forwarderPath?: string;
  dryRun?: boolean;
}

function isManagedForwarderCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return (
    command.endsWith("/hook-forwarder.sh") ||
    command.endsWith("\\hook-forwarder.sh") ||
    command.includes("hook-forwarder.sh")
  );
}

function createBackup(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak.${stamp}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function readJsonConfig(filePath: string): HooksConfigFile {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object at root of ${filePath}`);
  }
  return parsed as HooksConfigFile;
}

function mergeInstallHooks(
  config: HooksConfigFile,
  specs: readonly HookEventSpec[],
  forwarderPath: string,
  description?: string,
): { next: HooksConfigFile; changed: boolean; eventsUpdated: string[] } {
  const cloned = structuredClone(config) as HooksConfigFile;
  let changed = false;
  const eventsUpdated: string[] = [];

  if (description && typeof cloned.description !== "string") {
    cloned.description = description;
    changed = true;
  }

  const hooksMap: Record<string, HookMatcherGroup[]> =
    cloned.hooks && typeof cloned.hooks === "object" && !Array.isArray(cloned.hooks)
      ? { ...cloned.hooks }
      : {};

  for (const spec of specs) {
    const existingGroups = Array.isArray(hooksMap[spec.event]) ? [...hooksMap[spec.event]!] : [];
    const desiredEntry: HookCommandEntry = {
      type: "command",
      command: forwarderPath,
      ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    };

    let foundExact = false;
    let eventChanged = false;
    const updatedGroups: HookMatcherGroup[] = [];

    for (const group of existingGroups) {
      if (!group || typeof group !== "object") continue;
      const hooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
      const nextHooks: HookCommandEntry[] = [];

      for (const item of hooks) {
        if (item && typeof item === "object" && isManagedForwarderCommand(item.command)) {
          if (
            !foundExact &&
            item.type === desiredEntry.type &&
            item.command === desiredEntry.command &&
            item.timeout === desiredEntry.timeout &&
            (spec.matcher ?? undefined) === (group.matcher ?? undefined)
          ) {
            foundExact = true;
            nextHooks.push(item);
          } else if (!foundExact && (spec.matcher ?? undefined) === (group.matcher ?? undefined)) {
            foundExact = true;
            eventChanged = true;
            nextHooks.push(desiredEntry);
          } else {
            // Remove duplicate/stale managed forwarder entry.
            eventChanged = true;
          }
        } else {
          nextHooks.push(item);
        }
      }

      if (nextHooks.length > 0) {
        updatedGroups.push({ ...group, hooks: nextHooks });
      } else if (hooks.length > 0) {
        eventChanged = true;
      }
    }

    if (!foundExact) {
      const targetGroupIndex = updatedGroups.findIndex(
        (g) => (g.matcher ?? undefined) === (spec.matcher ?? undefined),
      );
      if (targetGroupIndex >= 0) {
        const group = updatedGroups[targetGroupIndex]!;
        updatedGroups[targetGroupIndex] = {
          ...group,
          hooks: [...(group.hooks ?? []), desiredEntry],
        };
      } else {
        updatedGroups.push({
          ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
          hooks: [desiredEntry],
        });
      }
      eventChanged = true;
    }

    if (eventChanged) {
      hooksMap[spec.event] = updatedGroups;
      changed = true;
      eventsUpdated.push(spec.event);
    }
  }

  cloned.hooks = hooksMap;
  return { next: cloned, changed, eventsUpdated };
}

function removeInstalledHooks(config: HooksConfigFile): {
  next: HooksConfigFile;
  changed: boolean;
  eventsUpdated: string[];
} {
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    return { next: config, changed: false, eventsUpdated: [] };
  }

  const cloned = structuredClone(config) as HooksConfigFile;
  const hooksMap = { ...(cloned.hooks ?? {}) };
  let changed = false;
  const eventsUpdated: string[] = [];

  for (const [eventName, groups] of Object.entries(hooksMap)) {
    if (!Array.isArray(groups)) continue;
    let eventChanged = false;
    const nextGroups: HookMatcherGroup[] = [];

    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const keptHooks = hooks.filter(
        (item) => !(item && typeof item === "object" && isManagedForwarderCommand(item.command)),
      );
      if (keptHooks.length !== hooks.length) {
        eventChanged = true;
      }
      if (keptHooks.length > 0) {
        nextGroups.push({ ...group, hooks: keptHooks });
      }
    }

    if (eventChanged) {
      changed = true;
      eventsUpdated.push(eventName);
      if (nextGroups.length > 0) {
        hooksMap[eventName] = nextGroups;
      } else {
        delete hooksMap[eventName];
      }
    }
  }

  if (Object.keys(hooksMap).length > 0) {
    cloned.hooks = hooksMap;
  } else {
    delete cloned.hooks;
  }

  return { next: cloned, changed, eventsUpdated };
}

function applyToTarget(params: {
  target: "claude" | "agy";
  filePath: string;
  action: "install" | "uninstall";
  specs: readonly HookEventSpec[];
  forwarderPath: string;
  description?: string;
  dryRun: boolean;
}): HookTargetResult {
  const existed = existsSync(params.filePath);
  if (params.action === "uninstall" && !existed) {
    return { target: params.target, path: params.filePath, changed: false, eventsUpdated: [] };
  }

  const current = readJsonConfig(params.filePath);
  const { next, changed, eventsUpdated } =
    params.action === "install"
      ? mergeInstallHooks(current, params.specs, params.forwarderPath, params.description)
      : removeInstalledHooks(current);

  if (!changed) {
    return { target: params.target, path: params.filePath, changed: false, eventsUpdated: [] };
  }

  let backupPath: string | undefined;
  if (!params.dryRun) {
    mkdirSync(dirname(params.filePath), { recursive: true });
    if (existed) {
      backupPath = createBackup(params.filePath);
    }
    writeFileSync(params.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return {
    target: params.target,
    path: params.filePath,
    changed: true,
    backupPath,
    eventsUpdated,
  };
}

/**
 * Safely installs or uninstalls harness-web hook forwarder entries into
 * Claude Code (`~/.claude/settings.json`) and Antigravity CLI (`~/.gemini/antigravity-cli/hooks.json`).
 * Creates a timestamped backup before modifying an existing config file and is idempotent.
 */
export function manageHooks(options: ManageHooksOptions): HookTargetResult[] {
  const home = homedir();
  const defaultForwarder = resolve(import.meta.dir, "hook-forwarder.sh");
  const forwarderPath = resolve(options.forwarderPath ?? defaultForwarder);
  const claudeSettingsPath = resolve(
    options.claudeSettingsPath ?? join(home, ".claude", "settings.json"),
  );
  const agyHooksPath = resolve(
    options.agyHooksPath ?? join(home, ".gemini", "antigravity-cli", "hooks.json"),
  );
  const dryRun = Boolean(options.dryRun);

  return [
    applyToTarget({
      target: "claude",
      filePath: claudeSettingsPath,
      action: options.action,
      specs: CLAUDE_HOOK_EVENTS,
      forwarderPath,
      dryRun,
    }),
    applyToTarget({
      target: "agy",
      filePath: agyHooksPath,
      action: options.action,
      specs: AGY_HOOK_EVENTS,
      forwarderPath,
      description: "Forward Antigravity CLI lifecycle hooks to harness-web when running.",
      dryRun,
    }),
  ];
}

function parseCliArgs(argv: string[]): ManageHooksOptions {
  let action: "install" | "uninstall" | null = null;
  let claudeSettingsPath: string | undefined;
  let agyHooksPath: string | undefined;
  let forwarderPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--install" || arg === "--install-hooks") {
      action = "install";
    } else if (arg === "--uninstall" || arg === "--uninstall-hooks") {
      action = "uninstall";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--claude-settings" && argv[i + 1]) {
      claudeSettingsPath = argv[++i];
    } else if (arg === "--agy-hooks" && argv[i + 1]) {
      agyHooksPath = argv[++i];
    } else if (arg === "--forwarder" && argv[i + 1]) {
      forwarderPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun plugins/web/scripts/install-hooks.ts (--install | --uninstall) [--dry-run] [--claude-settings <path>] [--agy-hooks <path>] [--forwarder <path>]",
      );
      process.exit(0);
    }
  }

  if (!action) {
    throw new Error("Missing required flag: pass --install or --uninstall");
  }

  return { action, claudeSettingsPath, agyHooksPath, forwarderPath, dryRun };
}

if (import.meta.main) {
  const opts = parseCliArgs(process.argv.slice(2));
  const results = manageHooks(opts);
  for (const res of results) {
    const status = res.changed
      ? opts.dryRun
        ? "would update"
        : "updated"
      : "already up to date";
    const eventsInfo = res.eventsUpdated.length > 0 ? ` (${res.eventsUpdated.join(", ")})` : "";
    const backupInfo = res.backupPath ? ` [backup: ${res.backupPath}]` : "";
    console.log(`[hooks:${res.target}] ${status}: ${res.path}${eventsInfo}${backupInfo}`);
  }
}
