const STORAGE_KEY = "hw.soundMuted";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playBeep(
  frequencies: number[],
  durationSec = 0.09,
  stepSec = 0.1,
  gainPeak = 0.06,
): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const baseTime = ctx.currentTime;
  frequencies.forEach((freq, idx) => {
    const start = baseTime + idx * stepSec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + durationSec + 0.02);
  });
}

export function loadSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSoundMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Ignore storage errors.
  }
}

export function playAttentionSound(muted: boolean): void {
  if (muted) return;
  playBeep([587.33, 880], 0.11, 0.12, 0.07);
}

export function playCompletedSound(muted: boolean): void {
  if (muted) return;
  playBeep([523.25, 659.25], 0.09, 0.1, 0.05);
}

export function playErrorSound(muted: boolean): void {
  if (muted) return;
  playBeep([330, 261.63], 0.12, 0.12, 0.06);
}
