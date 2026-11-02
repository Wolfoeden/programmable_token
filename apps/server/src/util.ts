/** Small server utilities. */

/** JSON.stringify replacer that turns bigints into strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

/** Time-bounded cache. */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private ttlMs: number,
    private maxEntries = 5000,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }
}

/** Runs async tasks one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Fixed-window rate limiter keyed by client. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count += 1;
    return true;
  }
}

/** Spaces out upstream requests: at most `perSecond` starts per second. */
export class Throttle {
  private next = 0;
  constructor(private perSecond: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + 1000 / this.perSecond;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "user-agent": "flightradar.fun/0.1", ...(init.headers ?? {}) } });
    if (!res.ok) throw new HttpError(res.status, "upstream_error", `${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => console.log(`${new Date().toISOString()} ${msg}`, extra === undefined ? "" : JSON.stringify(extra, jsonReplacer)),
  warn: (msg: string, extra?: unknown) => console.warn(`${new Date().toISOString()} WARN ${msg}`, extra === undefined ? "" : JSON.stringify(extra, jsonReplacer)),
};
