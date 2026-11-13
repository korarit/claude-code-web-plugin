import { Fragment, useState } from "react";
import { useTranslation } from "../../../lib/i18n/index.ts";

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable.
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--code-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-1 text-[11px] text-[var(--text-muted)]">
        <span className="font-mono">{language || "text"}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded px-1.5 py-0.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
        >
          {copied ? t("copiedCode") : t("copyCode")}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code
          key={idx}
          className="rounded bg-[var(--code-bg)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-[var(--text-primary)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function TextSegment({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-[var(--text-primary)]">
      {lines.map((line, idx) => {
        if (!line.trim()) return <div key={idx} className="h-1" />;
        const h3 = line.match(/^###\s+(.+)$/);
        if (h3) {
          return (
            <h3 key={idx} className="pt-1 text-sm font-semibold text-[var(--text-primary)]">
              {renderInline(h3[1]!)}
            </h3>
          );
        }
        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
          return (
            <h2 key={idx} className="pt-1 text-base font-semibold text-[var(--text-primary)]">
              {renderInline(h2[1]!)}
            </h2>
          );
        }
        const h1 = line.match(/^#\s+(.+)$/);
        if (h1) {
          return (
            <h1 key={idx} className="pt-1 text-lg font-bold text-[var(--text-primary)]">
              {renderInline(h1[1]!)}
            </h1>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={idx} className="flex gap-2 pl-2">
              <span className="text-[var(--text-muted)]">•</span>
              <span className="min-w-0 flex-1 break-words">{renderInline(bullet[1]!)}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="break-words whitespace-pre-wrap">
            {renderInline(line)}
          </p>
        );
      })}
    </div>
  );
}

export default function MarkdownContent({ text }: { text: string }) {
  const blocks: Array<{ kind: "text" | "code"; content: string; language?: string }> = [];
  const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ kind: "text", content: text.slice(lastIndex, match.index) });
    }
    blocks.push({
      kind: "code",
      language: match[1] ?? "",
      content: match[2]?.replace(/\n$/, "") ?? "",
    });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    blocks.push({ kind: "text", content: text.slice(lastIndex) });
  }

  return (
    <div>
      {blocks.map((block, idx) =>
        block.kind === "code" ? (
          <CodeBlock key={idx} language={block.language ?? ""} code={block.content} />
        ) : (
          <TextSegment key={idx} content={block.content} />
        ),
      )}
    </div>
  );
}
