import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

interface Violation {
  file: string;
  specifier: string;
  rule: string;
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const STATIC_IMPORT_RE =
  /(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

function extractImports(source: string): ParsedImport[] {
  const cleaned = stripComments(source);
  const imports: ParsedImport[] = [];

  STATIC_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATIC_IMPORT_RE.exec(cleaned))) {
    imports.push({
      isTypeOnly: Boolean(match[1]),
      specifier: match[2]!,
    });
  }

  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((match = DYNAMIC_IMPORT_RE.exec(cleaned))) {
    imports.push({
      isTypeOnly: false,
      specifier: match[1]!,
    });
  }

  return imports;
}

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else {
      const dot = entry.lastIndexOf(".");
      if (dot !== -1 && SOURCE_EXTS.has(entry.slice(dot))) {
        out.push(full);
      }
    }
  }
  return out;
}

function normalizePosix(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}

function resolveSpecifier(fromFile: string, specifier: string, rootDir: string): string | null {
  if (specifier.startsWith("@core/")) {
    return normalizePosix(join("packages/core/src", specifier.slice("@core/".length)));
  }
  if (specifier.startsWith("@contracts/")) {
    return normalizePosix(join("packages/contracts/src", specifier.slice("@contracts/".length)));
  }
  if (specifier.startsWith("@/")) {
    return normalizePosix(join("apps/web/src", specifier.slice("@/".length)));
  }
  if (specifier.startsWith(".")) {
    const abs = resolve(fromFile, "..", specifier);
    return normalizePosix(relative(rootDir, abs));
  }
  return null;
}

export function checkBoundaries(rootDir = ROOT): Violation[] {
  const violations: Violation[] = [];
  const files = [
    ...walkTsFiles(join(rootDir, "packages")),
    ...walkTsFiles(join(rootDir, "apps")),
  ].filter((f) => !normalizePosix(relative(rootDir, f)).startsWith("apps/api/test/"));

  for (const absFile of files) {
    const relFile = normalizePosix(relative(rootDir, absFile));
    const source = readFileSync(absFile, "utf8");

    for (const imp of extractImports(source)) {
      const isTypeOnly = imp.isTypeOnly;
      const spec = imp.specifier;
      const resolved = resolveSpecifier(absFile, spec, rootDir);

      // 1. packages/core: pure zero-dependency (only relative core files or node: builtins)
      if (relFile.startsWith("packages/core/src/")) {
        if (resolved) {
          if (!resolved.startsWith("packages/core/src/")) {
            violations.push({
              file: relFile,
              specifier: spec,
              rule: "packages/core must not import other workspaces",
            });
          }
        } else if (!spec.startsWith("node:")) {
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "packages/core must not import external dependencies",
          });
        }
        continue;
      }

      // 2. packages/contracts: may only import @core/* or relative packages/contracts/*
      if (relFile.startsWith("packages/contracts/src/")) {
        if (!resolved) {
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "packages/contracts must not import external dependencies",
          });
        } else if (
          !resolved.startsWith("packages/core/src/") &&
          !resolved.startsWith("packages/contracts/src/")
        ) {
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "packages/contracts may only import @core/* or local contract files",
          });
        }
        continue;
      }

      // 3. apps/web: must never import apps/api
      if (relFile.startsWith("apps/web/src/")) {
        if (
          (resolved && resolved.startsWith("apps/api/")) ||
          spec.includes("apps/api") ||
          spec === "elysia"
        ) {
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "apps/web must not import apps/api or backend packages",
          });
        }
        continue;
      }

      // 4. apps/api/src/modules/<ctx>/<layer>
      const modMatch = relFile.match(/^apps\/api\/src\/modules\/([^/]+)\/([^/]+)\//);
      if (modMatch) {
        const ctx = modMatch[1]!;
        const layer = modMatch[2]!;

        if (isAbsolute(spec)) {
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "Modules must not use absolute filesystem imports",
          });
          continue;
        }

        // Cross-bounded-context imports are forbidden (must communicate via application ports wired in index.ts)
        if (resolved && resolved.startsWith("apps/api/src/modules/")) {
          const targetMatch = resolved.match(/^apps\/api\/src\/modules\/([^/]+)\/([^/]+)\//);
          if (targetMatch && targetMatch[1] !== ctx) {
            violations.push({
              file: relFile,
              specifier: spec,
              rule: `Cross-bounded-context import (${ctx} -> ${targetMatch[1]}) is forbidden; communicate via ports`,
            });
            continue;
          }
        }

        if (layer === "domain") {
          if (!resolved) {
            if (!spec.startsWith("node:")) {
              violations.push({
                file: relFile,
                specifier: spec,
                rule: "domain layer must not import external libraries (e.g. elysia)",
              });
            }
            continue;
          }
          if (resolved.startsWith("packages/contracts/src/")) {
            if (!isTypeOnly) {
              violations.push({
                file: relFile,
                specifier: spec,
                rule: "domain layer may only use type-only imports from @contracts/*",
              });
            }
            continue;
          }
          if (
            resolved.startsWith("packages/core/src/") ||
            resolved.startsWith(`apps/api/src/modules/${ctx}/domain/`)
          ) {
            continue;
          }
          violations.push({
            file: relFile,
            specifier: spec,
            rule: "domain layer must not import application, infrastructure, or presentation",
          });
        } else {
          if (
            resolved &&
            (resolved.startsWith("apps/web/") || /^apps\/api\/src\/[^/]+$/.test(resolved))
          ) {
            violations.push({
              file: relFile,
              specifier: spec,
              rule: `${layer} layer must not import api root or web files`,
            });
            continue;
          }
          if (layer === "application") {
            if (resolved && resolved.startsWith(`apps/api/src/modules/${ctx}/`)) {
              const targetLayer = resolved.split("/")[5];
              if (targetLayer === "infrastructure" || targetLayer === "presentation") {
                violations.push({
                  file: relFile,
                  specifier: spec,
                  rule: `application layer must not import ${targetLayer} directly`,
                });
              }
            }
          } else if (layer === "infrastructure") {
            if (resolved && resolved.startsWith(`apps/api/src/modules/${ctx}/presentation/`)) {
              violations.push({
                file: relFile,
                specifier: spec,
                rule: "infrastructure layer must not import presentation directly",
              });
            }
          } else if (layer === "presentation") {
            if (resolved && resolved.startsWith(`apps/api/src/modules/${ctx}/infrastructure/`)) {
              violations.push({
                file: relFile,
                specifier: spec,
                rule: "presentation layer must not import infrastructure directly",
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

if (import.meta.main) {
  const violations = checkBoundaries();
  if (violations.length > 0) {
    console.error(`Found ${violations.length} architecture boundary violation(s):`);
    for (const v of violations) {
      console.error(`  - ${v.file}: "${v.specifier}" -> ${v.rule}`);
    }
    process.exit(1);
  }
  console.log("Boundary check passed (0 violations across packages/* and apps/*).");
}
