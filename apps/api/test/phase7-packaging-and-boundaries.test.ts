import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkBoundaries } from "../../../scripts/check-boundaries.ts";
import { manageHooks } from "../../../plugins/web/scripts/install-hooks.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

describe("Phase 7: Boundaries, Packaging & Hook Setup", () => {
  test("checkBoundaries passes with zero architecture violations", () => {
    const violations = checkBoundaries(REPO_ROOT);
    expect(violations).toEqual([]);
  });

  test("manageHooks installs and uninstalls idempotently with backups while preserving user config", () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p7-hooks-"));
    try {
      const claudePath = join(root, ".claude", "settings.json");
      const agyPath = join(root, ".gemini", "antigravity-cli", "hooks.json");
      const forwarderPath = join(REPO_ROOT, "plugins", "web", "scripts", "hook-forwarder.sh");

      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(
        claudePath,
        JSON.stringify(
          {
            model: "sonnet",
            permissions: { allow: ["Read"] },
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "/usr/local/bin/my-custom-hook.sh" }],
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // 1. First install modifies both files and backs up existing claude settings.json
      const firstInstall = manageHooks({
        action: "install",
        claudeSettingsPath: claudePath,
        agyHooksPath: agyPath,
        forwarderPath,
      });
      expect(firstInstall[0]?.changed).toBe(true);
      expect(firstInstall[0]?.backupPath).toBeTruthy();
      expect(existsSync(firstInstall[0]!.backupPath!)).toBe(true);
      expect(firstInstall[1]?.changed).toBe(true);
      expect(firstInstall[1]?.backupPath).toBeUndefined();

      const claudeCfg = JSON.parse(readFileSync(claudePath, "utf8")) as {
        model: string;
        permissions: { allow: string[] };
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
      };
      expect(claudeCfg.model).toBe("sonnet");
      expect(claudeCfg.permissions.allow).toEqual(["Read"]);
      expect(claudeCfg.hooks.PreToolUse?.some((g) => g.matcher === "Bash")).toBe(true);
      expect(
        claudeCfg.hooks.PermissionRequest?.some((g) =>
          g.hooks.some((h) => h.command === forwarderPath),
        ),
      ).toBe(true);

      const agyCfg = JSON.parse(readFileSync(agyPath, "utf8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
      };
      expect(
        agyCfg.hooks.PreToolUse?.some((g) =>
          g.hooks.some((h) => h.command === forwarderPath && h.timeout === 65),
        ),
      ).toBe(true);

      // 2. Second install is idempotent (no duplicate entries, no redundant backup)
      const secondInstall = manageHooks({
        action: "install",
        claudeSettingsPath: claudePath,
        agyHooksPath: agyPath,
        forwarderPath,
      });
      expect(secondInstall.every((r) => !r.changed)).toBe(true);

      // 3. Uninstall removes only managed hook-forwarder.sh entries and preserves custom user hooks
      const uninstall = manageHooks({
        action: "uninstall",
        claudeSettingsPath: claudePath,
        agyHooksPath: agyPath,
        forwarderPath,
      });
      expect(uninstall[0]?.changed).toBe(true);
      expect(uninstall[0]?.backupPath).toBeTruthy();
      expect(uninstall[1]?.changed).toBe(true);

      const claudeAfter = JSON.parse(readFileSync(claudePath, "utf8")) as {
        model: string;
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
      };
      expect(claudeAfter.model).toBe("sonnet");
      expect(claudeAfter.hooks.PreToolUse).toHaveLength(1);
      expect(claudeAfter.hooks.PreToolUse![0]!.matcher).toBe("Bash");
      expect(claudeAfter.hooks.PermissionRequest).toBeUndefined();

      const agyAfter = JSON.parse(readFileSync(agyPath, "utf8")) as {
        hooks?: unknown;
      };
      expect(agyAfter.hooks).toBeUndefined();

      // 4. Second uninstall is also idempotent
      const secondUninstall = manageHooks({
        action: "uninstall",
        claudeSettingsPath: claudePath,
        agyHooksPath: agyPath,
        forwarderPath,
      });
      expect(secondUninstall.every((r) => !r.changed)).toBe(true);

      const claudeFiles = readdirSync(join(root, ".claude"));
      expect(claudeFiles.some((f) => f.startsWith("settings.json.bak."))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("start-web.sh --dry-run runs preflight checks and prints bun command", () => {
    const startScript = join(REPO_ROOT, "plugins", "web", "scripts", "start-web.sh");
    const proc = Bun.spawnSync(["bash", startScript, "--dry-run", "--port", "4199"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${process.env["HOME"] ?? ""}/.bun/bin:${process.env["PATH"] ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Harness Web Preflight Checks");
    expect(stdout).toContain("apps/api/src/index.ts --host 127.0.0.1 --port 4199");
  });

  test("checkBoundaries rejects cross-context, layer, external, and dynamic import violations", () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p7-bounds-"));
    try {
      mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
      mkdirSync(join(root, "packages", "contracts", "src"), { recursive: true });
      mkdirSync(join(root, "apps", "api", "src", "modules", "chat", "domain"), { recursive: true });
      mkdirSync(join(root, "apps", "api", "src", "modules", "chat", "presentation"), {
        recursive: true,
      });
      mkdirSync(join(root, "apps", "api", "src", "modules", "chat", "infrastructure"), {
        recursive: true,
      });
      mkdirSync(join(root, "apps", "api", "src", "modules", "harness", "domain"), {
        recursive: true,
      });
      mkdirSync(join(root, "apps", "web", "src"), { recursive: true });

      writeFileSync(join(root, "apps", "api", "src", "modules", "harness", "domain", "p.ts"), "export {};\n");
      writeFileSync(
        join(root, "apps", "api", "src", "modules", "chat", "infrastructure", "db.ts"),
        "export const db = 1;\n",
      );
      writeFileSync(
        join(root, "apps", "api", "src", "modules", "chat", "domain", "bad.ts"),
        [
          'import { Elysia } from "elysia";',
          'import { CHAT_MODELS } from "@contracts/chat";',
          'import type { ChatModel } from "@contracts/chat";',
          'import "../../harness/domain/p.ts";',
          'export async function dyn() { return await import("../../harness/domain/p.ts"); }',
          "export type Ok = ChatModel;",
          "void Elysia; void CHAT_MODELS;",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "apps", "api", "src", "modules", "chat", "presentation", "route.ts"),
        'import { db } from "../infrastructure/db.ts";\nexport { db };\n',
      );
      writeFileSync(
        join(root, "apps", "web", "src", "bad-web.ts"),
        'import "../../api/src/index.ts";\n',
      );

      const violations = checkBoundaries(root);
      const specs = violations.map((v) => `${v.file}:${v.specifier}`);
      expect(specs).toContain("apps/api/src/modules/chat/domain/bad.ts:elysia");
      expect(specs).toContain("apps/api/src/modules/chat/domain/bad.ts:@contracts/chat");
      expect(specs).toContain("apps/api/src/modules/chat/domain/bad.ts:../../harness/domain/p.ts");
      expect(specs.filter((s) => s.endsWith("../../harness/domain/p.ts"))).toHaveLength(2);
      expect(specs).toContain(
        "apps/api/src/modules/chat/presentation/route.ts:../infrastructure/db.ts",
      );
      expect(specs).toContain("apps/web/src/bad-web.ts:../../api/src/index.ts");
      expect(violations.some((v) => v.rule.includes("type-only") && v.specifier === "@contracts/chat")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("start-web.sh forwards --host and hook flags, and rejects unknown flags", () => {
    const startScript = join(REPO_ROOT, "plugins", "web", "scripts", "start-web.sh");
    const root = mkdtempSync(join(tmpdir(), "hw-p7-sh-"));
    try {
      const claudePath = join(root, "claude-settings.json");
      const agyPath = join(root, "agy-hooks.json");

      const hostRun = Bun.spawnSync(
        ["bash", startScript, "--dry-run", "--host", "0.0.0.0", "--port", "4199"],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${process.env["HOME"] ?? ""}/.bun/bin:${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(hostRun.exitCode).toBe(0);
      expect(hostRun.stdout.toString()).toContain("apps/api/src/index.ts --host 0.0.0.0 --port 4199");

      const installRun = Bun.spawnSync(
        [
          "bash",
          startScript,
          "--install-hooks",
          "--claude-settings",
          claudePath,
          "--agy-hooks",
          agyPath,
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${process.env["HOME"] ?? ""}/.bun/bin:${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(installRun.exitCode).toBe(0);
      expect(existsSync(claudePath)).toBe(true);
      expect(existsSync(agyPath)).toBe(true);

      const uninstallRun = Bun.spawnSync(
        [
          "bash",
          startScript,
          "--uninstall-hooks",
          "--claude-settings",
          claudePath,
          "--agy-hooks",
          agyPath,
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${process.env["HOME"] ?? ""}/.bun/bin:${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(uninstallRun.exitCode).toBe(0);

      const badFlag = Bun.spawnSync(["bash", startScript, "--unknown-flag"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${process.env["HOME"] ?? ""}/.bun/bin:${process.env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(badFlag.exitCode).toBe(2);
      expect(badFlag.stderr.toString()).toContain("Unknown option");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
