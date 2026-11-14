/** Thin client for the server API. */
import type { AircraftDetail, AircraftResponse, TrackPoint, BetCosts, DeparturesResponse, Health, MarketDto, Portfolio, StreamInfo } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "server_unreachable", "The server cannot be reached. Check your connection and try again.");
  }
  const text = await res.text();
  let body: { error?: string; message?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: an HTML error page from the host (Render), e.g. while the
    // server restarts after a deploy or wakes up from sleep.
    throw new ApiError(
      res.status,
      "server_busy",
      `The server is not answering right now (HTTP ${res.status}). It may be restarting or waking up; please try again in a minute.`,
    );
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? res.statusText);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface WalletPayload {
  address: string;
  utxos: string[];
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const api = {
  adminCheck: (token: string) => request<{ ok: boolean }>("/api/admin/check", { headers: bearer(token) }),
  voidMarket: (token: string, marketId: string, reason: string) =>
    request<{ txHash: string }>(`/api/admin/markets/${marketId}/void`, { method: "POST", headers: bearer(token), body: JSON.stringify({ reason }) }),
  health: () => request<Health>("/api/health"),
  aircraft: () => request<AircraftResponse>("/api/aircraft"),
  tracks: (hexes: string[]) => request<{ tracks: Record<string, TrackPoint[]> }>(`/api/tracks?hex=${hexes.join(",")}`),
  stream: (icao: string) => request<StreamInfo>(`/api/streams/${icao}`),
  aircraftDetail: (hex: string) => request<AircraftDetail>(`/api/aircraft/${hex}`),
  markets: () => request<{ now: number; markets: MarketDto[] }>("/api/markets"),
  market: (id: string) => request<{ market: MarketDto }>(`/api/markets/${id}`),
  createMarket: (body: unknown) => post<{ marketId: string; txHash?: string; existing: boolean }>("/api/markets", body),
  departures: (icao: string) => request<DeparturesResponse>(`/api/airports/${icao}/departures`),
  jackpot: () => request<{ lovelace: string; outputs: number; address: string; sideBet: string }>("/api/jackpot"),
  preview: (hex: string) => request<{ existing: string | null; market: MarketDto | null }>(`/api/aircraft/${hex}/preview`),
  /** `target`: an existing market id, or "preview:<hex>" to create the market with this first bet. */
  betTx: (w: WalletPayload, target: string, outcome: number, stake: bigint, side = false, threshold?: number) =>
    post<{ marketId: string; tx: string; quote: { payout: string; multiplier: number; probabilityAfter: number }; costs: BetCosts }>("/api/tx/bet", {
      ...w,
      ...(target.startsWith("preview:") ? { hex: target.slice(8), ...(threshold !== undefined ? { threshold } : {}) } : { marketId: target }),
      outcome,
      stake: stake.toString(),
      side,
    }),
  claimTx: (w: WalletPayload, marketId: string) => post<{ tx: string; value: string }>("/api/tx/claim", { ...w, marketId }),
  operatorDeposits: (address: string) =>
    request<{ isOperator: boolean; count: number; lovelace: string }>(`/api/operator/deposits?address=${encodeURIComponent(address)}`),
  reclaimDepositsTx: (w: WalletPayload) => post<{ tx: string; count: number; lovelace: string }>("/api/tx/reclaim-deposits", w),
  burnTx: (w: WalletPayload) => post<{ tx: string; burned: number }>("/api/tx/burn", w),
  cancelTx: (w: WalletPayload, order: string) => post<{ tx: string }>("/api/tx/cancel", { ...w, order }),
  submit: (tx: string, witness: string) => post<{ txHash: string }>("/api/tx/submit", { tx, witness }),
  portfolio: (w: WalletPayload) => post<Portfolio>("/api/portfolio", w),
  demoWallets: () => request<{ wallets: Array<{ name: string; address: string; lovelace: string }> }>("/api/demo/wallets"),
  demoUtxos: (name: string) => request<WalletPayload>(`/api/demo/wallets/${name}/utxos`),
  demoSign: (name: string, tx: string) => post<{ witness: string }>(`/api/demo/wallets/${name}/sign`, { tx }),
};
