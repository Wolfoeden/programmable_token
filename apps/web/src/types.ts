/** Shapes returned by the server API (see apps/server/src/dto.ts). */
import type { FlightRef, Question } from "@flightradar/core/questions";

export type MarketPhase = "creating" | "open" | "closed" | "resolved" | "void";

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
