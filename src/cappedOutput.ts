/**
 * Writes server console output to a VSCode OutputChannel without letting a chatty server swamp
 * VSCode, and keeps the channel from growing without bound.
 *
 * Two things matter when a server logs a lot:
 *
 * 1. How many messages cross to VSCode's UI process. Every append()/replace() is an IPC message
 *    that the Output panel has to process, and Node hands us stdout in many small chunks. So text
 *    is collected and written out at most once per `flushMs` (and early once a lot has piled up)
 *    instead of once per chunk.
 *
 * 2. How much text a trim rewrites. An OutputChannel can't drop its oldest lines - the only way to
 *    shrink it is replace() with the whole text that should remain. If a trim kept almost the full
 *    limit, then every few percent of new log text would rewrite (nearly) the whole window and the
 *    panel would stall. So a trim cuts well below the limit - at most half of it, and never more
 *    than MAX_KEPT_CHARS - which makes the rewrite both smaller and much rarer: the extra text sent
 *    per log character is kept / (limit - kept) instead of roughly 5x.
 */

export interface OutputSink {
  append(text: string): void;
  replace(text: string): void;
}

/** Most text a single trim rewrites into the channel, however large the limit is. */
export const MAX_KEPT_CHARS = 500_000;

/** Flush right away (instead of waiting for the timer) once this much text is waiting. */
const FLUSH_NOW_CHARS = 256 * 1024;

export const TRIM_NOTICE = '[Tomcat] (오래된 로그가 tomcat.outputMaxChars 설정에 따라 생략되었습니다)\n';

export class CappedOutput {
  private pending = '';
  private tail = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /**
   * @param getMaxChars  Current limit in characters; 0 or less means "don't cap" (re-read on every
   *                     flush, so a settings change applies right away).
   * @param flushMs      Longest time written text may wait before reaching the channel.
   */
  constructor(
    private readonly sink: OutputSink,
    private readonly getMaxChars: () => number,
    private readonly flushMs: number = 100
  ) {}

  write(text: string): void {
    if (this.disposed || !text) return;
    this.pending += text;
    if (this.pending.length >= FLUSH_NOW_CHARS) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  /** Writes out whatever is waiting. Call it before anything else writes to the channel directly
   *  (so the order stays right) and when the process ends. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.disposed || !this.pending) return;
    const text = this.pending;
    this.pending = '';
    try {
      this.sink.append(text);

      const maxChars = this.getMaxChars();
      if (maxChars <= 0) {
        this.tail = ''; // capping is off - nothing needs remembering
        return;
      }
      this.tail += text;
      if (this.tail.length <= maxChars) return;

      const kept = Math.min(Math.floor(maxChars / 2), MAX_KEPT_CHARS);
      let cut = this.tail.length - kept;
      const newline = this.tail.indexOf('\n', cut);
      if (newline !== -1) cut = newline + 1; // start on a whole line
      this.tail = this.tail.slice(cut);
      this.sink.replace(TRIM_NOTICE + this.tail);
    } catch {
      // The channel was disposed underneath us (server restarted / window closing) - nothing to do.
    }
  }

  /** Stops the timer and drops anything not yet written. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = '';
    this.tail = '';
  }
}
