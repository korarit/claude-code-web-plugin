import type { ReactNode } from "react";

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "class",
  "interface",
  "type",
  "extends",
  "implements",
  "new",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "as",
  "true",
  "false",
  "null",
  "undefined",
  "def",
  "elif",
  "pass",
  "raise",
  "with",
  "lambda",
  "pub",
  "fn",
  "struct",
  "enum",
  "impl",
  "match",
  "use",
  "mod",
  "func",
  "package",
  "defer",
  "go",
  "select",
  "chan",
]);

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "css",
  "scss",
  "sh",
  "bash",
  "zsh",
  "json",
  "yml",
  "yaml",
]);

export function supportsSyntaxHighlight(filePath?: string): boolean {
  if (!filePath) return false;
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXTENSIONS.has(ext);
}

const TOKEN_RE =
  /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gm;

export function highlightCodeLine(line: string, filePath?: string): ReactNode {
  if (!line || !supportsSyntaxHighlight(filePath)) {
    return line;
  }

  const ext = filePath?.split(".").pop()?.toLowerCase() ?? "";
  const isHashCommentLang = ext === "py" || ext === "sh" || ext === "bash" || ext === "zsh" || ext === "yml" || ext === "yaml";

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }

    const token = match[0]!;
    if (token.startsWith("//") || (isHashCommentLang && token.startsWith("#"))) {
      nodes.push(
        <span key={key++} className="italic text-[var(--syn-com)]">
          {token}
        </span>,
      );
    } else if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      nodes.push(
        <span key={key++} className="text-[var(--syn-str)]">
          {token}
        </span>,
      );
    } else if (/^\d/.test(token)) {
      nodes.push(
        <span key={key++} className="text-[var(--syn-num)]">
          {token}
        </span>,
      );
    } else if (KEYWORDS.has(token)) {
      nodes.push(
        <span key={key++} className="font-medium text-[var(--syn-kw)]">
          {token}
        </span>,
      );
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) {
      nodes.push(
        <span key={key++} className="text-[var(--syn-type)]">
          {token}
        </span>,
      );
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : line;
}
