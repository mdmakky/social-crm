/**
 * Graceful shutdown for a single-process deployment (API + in-process workers on one free web service).
 * Order: stop accepting connections, let in-flight requests finish, stop the workers (each waits for its current pass; an event being processed
 * is one transaction, so a hard kill would only roll it back), close the database pools, exit. A deadline forces the exit if something hangs
 * (the host sends SIGKILL after its own delay, 30 s by default on Render), and a second signal exits at once.
 */
type Closable = { close(cb?: (err?: Error) => void): unknown; closeIdleConnections?: () => void; closeAllConnections?: () => void };

export function createShutdown(opts: {
  server: Closable;
  /** Workers: each stop() resolves after the current pass. */
  stoppers: Array<() => Promise<unknown>>;
  /** Database pools: each end() closes idle and waits for checked-out connections. */
  pools: Array<() => Promise<unknown>>;
  exit: (code: number) => void;
  timeoutMs?: number;
  log?: (message: string) => void;
}): () => Promise<void> {
  const log = opts.log ?? ((m) => console.log(m));
  let running: Promise<void> | null = null;
  let done = false;

  return () => {
    if (running) {
      // a second signal while shutting down: stop waiting
      if (!done) { log("shutdown: second signal, exiting now"); opts.server.closeAllConnections?.(); opts.exit(1); }
      return running;
    }
    log("shutdown: started");
    const deadline = setTimeout(() => {
      if (done) return;
      log("shutdown: deadline reached, forcing exit");
      opts.server.closeAllConnections?.();
      opts.exit(1);
    }, opts.timeoutMs ?? 10_000);
    running = (async () => {
      try {
        const closed = new Promise<void>((resolve) => opts.server.close(() => resolve()));
        opts.server.closeIdleConnections?.();
        await Promise.allSettled(opts.stoppers.map((s) => s())); // workers may still be finishing a pass that began before the signal
        await closed; // in-flight requests are done
        await Promise.allSettled(opts.pools.map((p) => p()));
        done = true;
        clearTimeout(deadline);
        log("shutdown: clean");
        opts.exit(0);
      } catch (e) {
        done = true;
        clearTimeout(deadline);
        log(`shutdown: failed (${(e as Error).name})`);
        opts.exit(1);
      }
    })();
    return running;
  };
}
