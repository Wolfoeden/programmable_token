/** Shapes returned by the server API (see apps/server/src/dto.ts). */
import type { FlightRef, Question } from "@flightradar/core/questions";

/** "preview": no market yet; the first bet creates it. */
export type MarketPhase = "preview" | "creating" | "open" | "closed" | "resolved" | "void";

export interface MarketDto {
  id: string;
  kind: Question["kind"];
  question: Question;
  title: { de: string; en: string };
  labels: { de: string[]; en: string[] };
  rules: { de: string; en: string };
  pools: string[];
  total: string;
  probabilities: number[];
  odds: number[];
  pending: { orders: number; stakes: string[] };
  closeTime: number;
  resolveDeadline: number;
  claimDeadline: number;
  feeBps: number;
  maxTotal: string;
  phase: MarketPhase;
  winner: number | null;
  icao24: string[];
  seed?: { probabilities: number[]; model: string };
  resolution?: { reason: string; decidedAt: number; txHash?: string };
  simulated: boolean;
  utxo?: string;
}

export interface AircraftDto {
  hex: string;
  callsign?: string;
  registration?: string;
  type?: string;
  lat: number;
  lon: number;
  altitudeFt?: number;
  onGround: boolean;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  timestamp: number;
  markets?: number;
  phase?: "landing" | "takeoff";
  airport?: string;
  origin?: string;
  /** Destination confirmed (unambiguous); only confirmed flights take predictions. */
  confirmed?: boolean;
  flightNumber?: string;
  /** Model estimate of touchdown, unix ms (UTC), and one standard deviation. */
  etaMs?: number;
  etaSigmaMs?: number;
}

/** loading / ok / unavailable come from the server; error = server unreachable. */
export type DataStatus = "loading" | "ok" | "unavailable" | "error";

export interface AircraftResponse {
  now: number;
  status: "loading" | "ok" | "unavailable";
  updatedAt: number | null;
  aircraft: AircraftDto[];
  /** Flights that left the list: on final, landed or lost. */
  arrivals?: Arrival[];
}

/**
 * approaching: on the list. final: off the list but still airborne.
 * landed: first ADS-B ground report at the airport. lost: no ground report
 * and no signal for 5 minutes (landing unconfirmed).
 */
export type ArrivalStatus = "approaching" | "final" | "landed" | "lost";

export interface Arrival {
  hex: string;
  airport: string;
  callsign?: string;
  flightNumber?: string;
  origin?: string;
  type?: string;
  status: ArrivalStatus;
  lat: number;
  lon: number;
  altitudeFt?: number;
  lastSeenAt: number;
  landedAt?: number;
  endedAt?: number;
}

/** lon, lat, unix ms */
export type TrackPoint = [number, number, number];

export interface StreamInfo {
  icao: string;
  url: string;
  videoId: string | null;
  embeddable: boolean;
  checkedAt: number;
  reason?: string;
}

export interface BetCosts {
  stake: string;
  networkFee: string;
  batcherFee: string;
  deposit: string;
  /** Side bet into the jackpot, "0" when not opted in. */
  side?: string;
  feeBps: string;
  closeTime: number;
}

export interface AirportDto {
  icao: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  elevationFt: number;
  size: 1 | 2;
}

export interface RouteDto {
  callsign: string;
  flightNumber: string;
  airline?: string;
  origin: string;
  destination: string;
}

export interface AircraftDetail {
  aircraft: AircraftDto;
  route: RouteDto | null;
  origin: AirportDto | null;
  destination: AirportDto | null;
  markets: MarketDto[];
}

export interface Health {
  ok: boolean;
  network: string;
  demo: boolean;
  now: number;
  operator: string;
  schedule: { name: string; simulated: boolean } | null;
}

export interface Departure {
  flightNumber: string;
  callsign?: string;
  airline?: string;
  origin: string;
  destination: string;
  scheduledDeparture: number;
  scheduledArrival: number;
  status: string;
  simulated?: boolean;
  quotes: { cancellation: number | null; delay: number | null };
  markets: Array<{ id: string; kind: string; phase: MarketPhase }>;
}

export interface DeparturesResponse {
  airport: AirportDto;
  provider: { name: string; simulated: boolean };
  departures: Departure[];
}

export interface Position {
  marketId: string;
  holdings: Array<{ outcome: number; quantity: string }>;
  market: MarketDto | null;
  claimable: string;
  ifWins: string[];
}

export interface OpenOrder {
  ref: string;
  marketId: string;
  order: { kind: "bet"; outcome: number; stake: string } | { kind: "claim" };
  lovelace: string;
  deadline: number;
}

export interface Portfolio {
  lovelace: string;
  positions: Position[];
  orders: OpenOrder[];
}

export type { FlightRef, Question };


export interface SafeMarketDto {
  id: string; hex: string; zone: string; openedAt: number;
  phase: "open" | "frozen" | "resolved" | "updating";
  recoveryHold?: boolean;
  chainState: "open" | "frozen" | "resolved";
  odds: [string, string]; reserve: string; stakes: [string, string]; limits: [string, string]; minStake: string;
  winner: 0 | 1 | null; evidenceHash: string | null; claimDeadline: number | null;
  evidence: { reason: string; sources: string[]; winner?: 0 | 1 | null } | null;
  criterion: string;
}
export interface SafeFlightResponse { enabled: boolean; market: SafeMarketDto | null; reservePerMarket?: string; previewLimits?: [string, string] }
export interface SafeQuote { tx: string; payout: string; stake: string; fee: string; batcherFee: string; deposit: string; outcome: 0 | 1; marketId: string; hex: string; expiresAt: number }
export interface SafePosition { market: SafeMarketDto; yes: string; no: string; claimable: string }

export interface SafeOrder { txHash: string; outputIndex: number; marketId: string; outcome: number | null; stake: string; deadline: number }
