/**
 * While a server is starting, "시작 중..." can look frozen for reasons that have nothing to do with
 * Tomcat itself, and the console stays empty so there is nothing to read. This watchdog writes the
 * two facts that tell those cases apart straight into the console:
 *
 * - Extension-host stalls: a timer that fires late means this process's event loop was blocked
 *   (some extension - Java language server client, a JSP indexer, ... - hogging it right after
 *   VSCode started). It is reported once the loop is free again, e.g. "응답하지 않았습니다 (약 190초)".
 * - JVM silence: once the process has been spawned but printed nothing yet, a periodic line says how
 *   long it has been and whether the process still exists, so "JVM never started" and "JVM alive
 *   but waiting on something" can be told apart without opening Task Manager.
 *
 * No vscode dependency, so it can be unit tested.
 */

export interface StartupWatchOptions {
  log: (message: string) => void;
  /** PID to report while the process is spawned but still silent; undefined = nothing to report. */
  getPid: () => number | undefined;
  /** True once startup is over (finished, failed or the process exited) - the watch then stops. */
  isDone: () => boolean;
  tickMs?: number;
  lagThresholdMs?: number;
  heartbeatMs?: number;
  /** Safety net: the watch always stops after this long. */
  maxMs?: number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only, works on Windows too
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM'; // exists but not ours to signal
  }
}

export function watchStartup(options: StartupWatchOptions): { stop(): void } {
  const tickMs = options.tickMs ?? 250;
  const lagThresholdMs = options.lagThresholdMs ?? 3000;
  const heartbeatMs = options.heartbeatMs ?? 20000;
  const maxMs = options.maxMs ?? 15 * 60 * 1000;

  const started = Date.now();
  let lastTick = started;
  let lastBeat = started;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const lag = now - lastTick - tickMs;
    lastTick = now;

    if (options.isDone() || now - started > maxMs) {
      stop();
      return;
    }

    if (lag >= lagThresholdMs) {
      options.log(
        `[Tomcat] VSCode 확장 호스트가 약 ${Math.round(lag / 1000)}초 동안 응답하지 않았습니다. ` +
          '이 시간 동안에는 Tomcat이 출력한 내용도 읽지 못하므로 Tomcat이 조용했다는 뜻은 아닙니다. ' +
          '이 확장의 시작 준비 단계(느렸다면 "느린 단계"로 따로 표시됩니다)일 수도, 다른 확장이나 VSCode 자체일 수도 있습니다.'
      );
      // Output the JVM printed while the loop was blocked is still sitting unread in the pipe, so
      // the silence over that stretch says nothing about the JVM - start counting it again now.
      lastBeat = now;
    }

    const pid = options.getPid();
    if (pid !== undefined && now - lastBeat >= heartbeatMs) {
      lastBeat = now;
      options.log(
        `[Tomcat] Tomcat 프로세스(PID ${pid})를 띄웠지만 ${Math.round((now - started) / 1000)}초째 아무 출력이 없습니다 ` +
          `(프로세스 ${processExists(pid) ? '실행 중' : '없음'}). 작업 관리자에서 java.exe 의 CPU/디스크 사용량을 확인해 보세요.`
      );
    }
  }, tickMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
}

/**
 * Runs one synchronous startup step and, if it took `thresholdMs` or longer, writes which step it
 * was. A synchronous call that blocks (file access on a slow/scanned folder, process creation held
 * up by security software, ...) freezes the whole extension host, so the message can only be
 * written once the call returns - but it then names the exact step instead of just "something".
 */
export function timedStep<T>(log: (message: string) => void, label: string, fn: () => T, thresholdMs: number = 1000): T {
  const started = Date.now();
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= thresholdMs) {
      log(`[Tomcat] 느린 단계: ${label} - ${(elapsed / 1000).toFixed(1)}초`);
    }
  }
}
