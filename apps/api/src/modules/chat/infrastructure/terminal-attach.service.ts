import type {
  TerminalAttachment,
  TerminalAttachPort,
  TerminalRunnerPort,
} from "../application/ports.ts";

export class TmuxCaptureTerminalAdapter implements TerminalAttachPort {
  constructor(
    private readonly runner: TerminalRunnerPort,
    private readonly pollIntervalMs = 250,
  ) {}

  attach(
    tmuxSession: string,
    onScreen: (content: string) => void,
    onError: (message: string) => void,
  ): TerminalAttachment {
    let closed = false;
    let lastScreen: string | null = null;
    let polling = false;

    const poll = async () => {
      if (closed || polling || !this.runner.capturePane) return;
      polling = true;
      try {
        const content = await this.runner.capturePane(tmuxSession, 120);
        if (!closed && content !== lastScreen) {
          lastScreen = content;
          onScreen(content);
        }
      } catch (e) {
        if (!closed) {
          onError((e as Error).message);
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, this.pollIntervalMs);

    return {
      sendKey: async (key: string) => {
        await this.runner.sendRawKeys(tmuxSession, key);
        setTimeout(() => {
          void poll();
        }, 60);
      },
      sendText: async (text: string) => {
        await this.runner.sendPrompt(tmuxSession, text);
        setTimeout(() => {
          void poll();
        }, 80);
      },
      close: () => {
        closed = true;
        clearInterval(timer);
      },
    };
  }
}
