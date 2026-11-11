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
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? res.statusText);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface WalletPayload {
  address: string;
  utxos: string[];
}

export const api = {
  health: () => request<Health>("/api/health"),
  aircraft: () => request<AircraftResponse>("/api/aircraft"),
  tracks: (hexes: string[]) => request<{ tracks: Record<string, TrackPoint[]> }>(`/api/tracks?hex=${hexes.join(",")}`),
  stream: (icao: string) => request<StreamInfo>(`/api/streams/${icao}`),
  aircraftDetail: (hex: string) => request<AircraftDetail>(`/api/aircraft/${hex}`),
  markets: () => request<{ now: number; markets: MarketDto[] }>("/api/markets"),
  market: (id: string) => request<{ market: MarketDto }>(`/api/markets/${id}`),
  createMarket: (body: unknown) => post<{ marketId: string; txHash?: string; existing: boolean }>("/api/markets", body),
  departures: (icao: string) => request<DeparturesResponse>(`/api/airports/${icao}/departures`),
  betTx: (w: WalletPayload, marketId: string, outcome: number, stake: bigint) =>
    post<{ tx: string; quote: { payout: string; multiplier: number; probabilityAfter: number }; costs: BetCosts }>("/api/tx/bet", {
      ...w,
      marketId,
      outcome,
      stake: stake.toString(),
    }),
  claimTx: (w: WalletPayload, marketId: string) => post<{ tx: string; value: string }>("/api/tx/claim", { ...w, marketId }),
  cancelTx: (w: WalletPayload, order: string) => post<{ tx: string }>("/api/tx/cancel", { ...w, order }),
  submit: (tx: string, witness: string) => post<{ txHash: string }>("/api/tx/submit", { tx, witness }),
  portfolio: (w: WalletPayload) => post<Portfolio>("/api/portfolio", w),
  demoWallets: () => request<{ wallets: Array<{ name: string; address: string; lovelace: string }> }>("/api/demo/wallets"),
  demoUtxos: (name: string) => request<WalletPayload>(`/api/demo/wallets/${name}/utxos`),
  demoSign: (name: string, tx: string) => post<{ witness: string }>(`/api/demo/wallets/${name}/sign`, { tx }),
};
