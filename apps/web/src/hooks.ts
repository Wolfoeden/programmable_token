import { useEffect, useState } from "react";

/** Current time, refreshed every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Poll an async function every `ms` while `enabled`. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[], enabled = true): { data: T | null; error: unknown; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const d = await fn();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e);
      }
      if (alive) timer = setTimeout(run, ms);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [...deps, enabled, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}
