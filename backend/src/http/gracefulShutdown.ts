interface ShutdownServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
}

interface GracefulShutdownOptions {
  quiesce(): void;
  closeResources(): Promise<void> | void;
  forceAfterMs?: number;
  exit?: (code: number) => void;
  report?: (message: string, error?: unknown) => void;
}

/** Stop producers first, then bound how long open HTTP/upgrade clients may delay exit. */
export function createGracefulShutdown(server: ShutdownServer, options: GracefulShutdownOptions) {
  let stopping = false;
  let completed = false;
  let timer: NodeJS.Timeout | undefined;
  let exitCode = 0;
  const report = options.report ?? ((message, error) => console.error(message, error ?? ""));
  const exit = options.exit ?? ((code) => process.exit(code));

  const finish = async (code: number) => {
    if (completed) return;
    completed = true;
    if (timer) clearTimeout(timer);
    let finalCode = code;
    try {
      await options.closeResources();
    } catch (error) {
      finalCode = 1;
      report("Shutdown resource close failed", error);
    }
    exit(finalCode);
  };

  return () => {
    if (stopping) return;
    stopping = true;
    try {
      options.quiesce();
    } catch (error) {
      exitCode = 1;
      report("Shutdown quiesce failed", error);
    }
    timer = setTimeout(() => {
      report("Graceful shutdown deadline reached; closing remaining client connections");
      server.closeAllConnections?.();
      void finish(exitCode);
    }, options.forceAfterMs ?? 5_000);
    timer.unref();
    try {
      server.close((error) => {
        if (error) {
          exitCode = 1;
          report("HTTP server close failed", error);
        }
        void finish(exitCode);
      });
    } catch (error) {
      exitCode = 1;
      report("HTTP server close failed", error);
      server.closeAllConnections?.();
      void finish(exitCode);
    }
  };
}

export function installGracefulShutdown(server: ShutdownServer, options: GracefulShutdownOptions) {
  const shutdown = createGracefulShutdown(server, options);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return shutdown;
}
