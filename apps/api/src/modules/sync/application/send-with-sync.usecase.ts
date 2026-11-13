import type { SessionControlMode, SessionOrigin } from "@contracts/chat";
import type { HarnessId } from "@contracts/harness";
import type { CanonicalSyncService, PreparedSyncPayload } from "./canonical-sync.service.ts";

export interface PreparePromptSyncInput {
  sessionId: string;
  harnessId: HarnessId;
  origin?: SessionOrigin;
  controlMode?: SessionControlMode;
  model: string;
  prompt: string;
  cwd?: string;
  title?: string;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
}

/**
 * Coordinates lazy full-verbatim delta sync for outbound prompts.
 * Computes unsynced canonical events for the target harness, selects the sync strategy
 * (Direct Verbatim / File Sync Fallback / OpenCode Native Import), and updates cursors on send.
 */
export class SendWithSyncUsecase {
  constructor(private readonly canonicalSync: CanonicalSyncService) {}

  async prepare(input: PreparePromptSyncInput): Promise<PreparedSyncPayload> {
    return this.canonicalSync.preparePromptForSend({
      session: {
        sessionId: input.sessionId,
        harnessId: input.harnessId,
        origin: input.origin,
        controlMode: input.controlMode,
        cwd: input.cwd,
        title: input.title,
        model: input.model,
        externalSessionId: input.externalSessionId,
        tmuxSession: input.tmuxSession,
        transcriptPath: input.transcriptPath,
      },
      prompt: input.prompt,
      model: input.model,
    });
  }

  commit(params: {
    prepared: PreparedSyncPayload;
    model: string;
    externalSessionId?: string;
    tmuxSession?: string;
    transcriptPath?: string;
  }) {
    return this.canonicalSync.commitPromptSent(params);
  }
}
