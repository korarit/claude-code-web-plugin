import { useEffect } from "react";
import type { ModelId, SessionInfo } from "@contracts/chat";
import type { HarnessDescriptor, HarnessId } from "@contracts/harness";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { useTheme, type ThemePreference } from "../../../lib/theme/index.ts";
import { getHarnessLabelKey } from "./HarnessBadge.tsx";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionInfo[];
  activeSession?: SessionInfo;
  harnesses: HarnessDescriptor[];
  currentHarnessId: HarnessId;
  currentModel: ModelId;
  modelOptions: ModelId[];
  canSwitchHarness: boolean;
  canSwitchModel: boolean;
  soundMuted: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onSwitchHarness: (harnessId: HarnessId) => void;
  onSelectModel: (model: ModelId) => void;
  onOpenInspector: (tab: "changes" | "agents" | "terminal") => void;
  onOpenWorktrees: () => void;
  onToggleSound: () => void;
}

const THEME_OPTIONS: readonly { value: ThemePreference; labelKey: "themeSystem" | "themeLight" | "themeDark" }[] = [
  { value: "system", labelKey: "themeSystem" },
  { value: "light", labelKey: "themeLight" },
  { value: "dark", labelKey: "themeDark" },
];

/** Global Cmd+K / Ctrl+K command palette for sessions, harnesses, models, panels, and theme. */
export default function CommandPalette({
  open,
  onOpenChange,
  sessions,
  activeSession,
  harnesses,
  currentHarnessId,
  currentModel,
  modelOptions,
  canSwitchHarness,
  canSwitchModel,
  soundMuted,
  onSelectSession,
  onNewSession,
  onSwitchHarness,
  onSelectModel,
  onOpenInspector,
  onOpenWorktrees,
  onToggleSound,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const runAndClose = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("commandPaletteTitle")}
      description={t("commandPaletteDescription")}
      closeLabel={t("closeDialog")}
    >
      <CommandInput placeholder={t("commandPalettePlaceholder")} />
      <CommandList>
        <CommandEmpty>{t("commandPaletteEmpty")}</CommandEmpty>

        <CommandGroup heading={t("commandGroupActions")}>
          <CommandItem
            value={`new-session ${t("newSession")}`}
            onSelect={() => runAndClose(onNewSession)}
          >
            <span>{t("newSession")}</span>
          </CommandItem>
          <CommandItem
            value={`changes ${t("commandOpenChanges")}`}
            onSelect={() => runAndClose(() => onOpenInspector("changes"))}
          >
            <span>{t("commandOpenChanges")}</span>
          </CommandItem>
          <CommandItem
            value={`agents ${t("commandOpenAgents")}`}
            onSelect={() => runAndClose(() => onOpenInspector("agents"))}
          >
            <span>{t("commandOpenAgents")}</span>
          </CommandItem>
          <CommandItem
            value={`terminal ${t("commandOpenTerminal")}`}
            onSelect={() => runAndClose(() => onOpenInspector("terminal"))}
          >
            <span>{t("commandOpenTerminal")}</span>
          </CommandItem>
          <CommandItem
            value={`worktrees ${t("commandOpenWorktrees")}`}
            onSelect={() => runAndClose(onOpenWorktrees)}
          >
            <span>{t("commandOpenWorktrees")}</span>
          </CommandItem>
          <CommandItem
            value={`sound ${t("soundOn")} ${t("soundMuted")}`}
            onSelect={() => runAndClose(onToggleSound)}
          >
            <span>
              {t("commandToggleSound", {
                state: soundMuted ? t("soundMuted") : t("soundOn"),
              })}
            </span>
          </CommandItem>
        </CommandGroup>

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandGroupSessions")}>
              {sessions.map((s) => {
                const title = s.title || s.lastMessagePreview || t("untitledSession");
                const isActive = s.id === activeSession?.id;
                const harnessName = t(getHarnessLabelKey(s.harnessId));
                return (
                  <CommandItem
                    key={s.id}
                    value={`session ${title} ${harnessName} ${s.model} ${s.cwd ?? ""}`}
                    onSelect={() => runAndClose(() => onSelectSession(s.id))}
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge variant="outline">{harnessName}</Badge>
                      <Badge variant="secondary" className="font-mono">
                        {s.model}
                      </Badge>
                      {isActive && (
                        <Badge variant="emerald">{t("commandActiveSessionBadge")}</Badge>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {harnesses.length > 0 && canSwitchHarness && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandGroupHarnesses")}>
              {harnesses.map((h) => {
                const name = t(getHarnessLabelKey(h.id));
                const isCurrent = h.id === currentHarnessId;
                const disabled = !h.available && !isCurrent;
                return (
                  <CommandItem
                    key={h.id}
                    disabled={disabled}
                    value={`harness ${name} ${h.id}`}
                    onSelect={() => {
                      if (!isCurrent && !disabled) {
                        runAndClose(() => onSwitchHarness(h.id));
                      }
                    }}
                  >
                    <span>{t("commandSwitchHarnessTo", { name })}</span>
                    {isCurrent && <Badge variant="primary">{t("commandActiveSessionBadge")}</Badge>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {modelOptions.length > 0 && canSwitchModel && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandGroupModels")}>
              {modelOptions.map((m) => {
                const isCurrent = m === currentModel;
                return (
                  <CommandItem
                    key={m}
                    value={`model ${m}`}
                    onSelect={() => runAndClose(() => onSelectModel(m))}
                  >
                    <span className="font-mono">{t("commandSwitchModelTo", { model: m })}</span>
                    {isCurrent && <Badge variant="primary">{t("commandActiveSessionBadge")}</Badge>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading={t("commandGroupTheme")}>
          {THEME_OPTIONS.map((opt) => {
            const label = t(opt.labelKey);
            const isCurrent = theme === opt.value;
            return (
              <CommandItem
                key={opt.value}
                value={`theme ${label} ${opt.value}`}
                onSelect={() => runAndClose(() => setTheme(opt.value))}
              >
                <span>{t("commandThemeOption", { theme: label })}</span>
                {isCurrent && <Badge variant="primary">{t("commandActiveSessionBadge")}</Badge>}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
