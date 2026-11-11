import { useEffect, useRef } from "react";
import { AttributionControl, Map as MlMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type MapGeoJSONFeature } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature as GeoFeature, FeatureCollection, Point } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { destinationPoint, KM_PER_NM } from "@flightradar/core/geo";
import { api } from "../api";
import type { AircraftDto, AirportDto, Arrival, DataStatus } from "../types";
import { greatCircle } from "./greatCircle";
import { diamondImage, planeImage, ringImage } from "./icons";

// The worker is a standalone module; point MapLibre at the bundled copy so it
// works both with Vite's dependency pre-bundling and in production builds.
setWorkerUrl(workerUrl);

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

export interface MapViewProps {
  selectedHex: string | null;
  destination: AirportDto | null;
  onAircraftClick: (hex: string) => void;
  onAirportClick: (icao: string) => void;
  onBackgroundClick: () => void;
  onAircraftUpdate: (list: AircraftDto[], arrivals: Arrival[]) => void;
  /** Data state after every poll: server status, or "error" if the server could not be reached. */
  onStatus: (s: { status: DataStatus; updatedAt: number | null; at: number }) => void;
  flyTo: { lat: number; lon: number; zoom?: number; key: number } | null;
}

type Feature = GeoFeature<Point, Record<string, unknown>>;

function extrapolate(a: AircraftDto, now: number): [number, number] {
  if (a.onGround || a.groundSpeedKt === undefined || a.trackDeg === undefined) return [a.lon, a.lat];
  const sec = Math.min(Math.max(0, (now - a.timestamp) / 1000), 60);
  const p = destinationPoint(a, a.trackDeg, (a.groundSpeedKt * KM_PER_NM * sec) / 3600);
  return [p.lon, p.lat];
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const aircraft = useRef<Map<string, AircraftDto>>(new Map());
  const trail = useRef<{ hex: string | null; points: [number, number][] }>({ hex: null, points: [] });
  const lookupAirport = useRef<((icao: string) => { lat: number; lon: number; iata: string; icao: string } | undefined) | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // ## Map setup
  useEffect(() => {
    const map = new MlMap({
      container: container.current!,
      style: STYLE_URL,
      center: [10.5, 49.6],
      zoom: 5.2,
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __map: MlMap }).__map = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    // Required credits (ODbL, OpenStreetMap) behind the small ⓘ button.
    map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: [
          '<a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> (ODbL)',
          '<a href="https://www.adsbdb.com" target="_blank" rel="noopener">adsbdb.com</a>',
          '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
        ],
      }),
      "bottom-left",
    );
    // Start folded: only the ⓘ shows until someone opens it.
    const fold = () => container.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    map.once("load", fold);
    map.once("idle", fold);

    map.on("load", async () => {
      map.addImage("plane", planeImage(64), { sdf: true, pixelRatio: 2 });
      map.addImage("ring", ringImage(64), { sdf: true, pixelRatio: 2 });
      map.addImage("diamond", diamondImage(48), { pixelRatio: 2 });
      const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
      map.addSource("aircraft", { type: "geojson", data: empty });
      map.addSource("trail", { type: "geojson", data: empty });
      map.addSource("route", { type: "geojson", data: empty });
      map.addSource("airports", { type: "geojson", data: empty });
      map.addSource("origins", { type: "geojson", data: empty });
      map.addSource("flows", { type: "geojson", data: empty });
      // Where each shown flight came from (dashed) and where it goes (faint).
      map.addLayer({
        id: "flows-flown",
        type: "line",
        source: "flows",
        filter: ["==", ["get", "leg"], "flown"],
        paint: { "line-color": "#5aa9ff", "line-width": 1.2, "line-opacity": 0.45, "line-dasharray": [1.5, 2] },
      });
      map.addLayer({
        id: "flows-ahead",
        type: "line",
        source: "flows",
        filter: ["==", ["get", "leg"], "ahead"],
        paint: { "line-color": "#3ddc97", "line-width": 1.2, "line-opacity": 0.35 },
      });
      map.addLayer({
        id: "origins",
        type: "symbol",
        source: "origins",
        layout: {
          "icon-image": "diamond",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 9, 1],
          "icon-allow-overlap": true,
          "text-field": ["get", "iata"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-optional": true,
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#5aa9ff", "text-halo-color": "#0b0d10", "text-halo-width": 1.2 },
      });

      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        paint: { "line-color": "#ffca06", "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "trail",
        type: "line",
        source: "trail",
        paint: { "line-color": "#e8ecf1", "line-width": 2, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "airports",
        type: "circle",
        source: "airports",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 9, 8],
          "circle-color": "#0b0d10",
          "circle-stroke-color": "#ffca06",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "airport-labels",
        type: "symbol",
        source: "airports",
        minzoom: 4,
        layout: { "text-field": ["get", "iata"], "text-size": 12, "text-offset": [0, 1.2], "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": "#ffca06", "text-halo-color": "#0b0d10", "text-halo-width": 1.2 },
      });
      map.addLayer({
        id: "market-rings",
        type: "symbol",
        source: "aircraft",
        filter: [">", ["get", "markets"], 0],
        layout: {
          "icon-image": "ring",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 10, 1.1],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#ffca06", "icon-opacity": 0.95 },
      });
      map.addLayer({
        id: "aircraft-ground",
        type: "symbol",
        source: "aircraft",
        minzoom: 8,
        filter: ["all", ["==", ["get", "ground"], 1], ["==", ["get", "sel"], 0]],
        layout: {
          "icon-image": "plane",
          "icon-rotate": ["get", "track"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 12, 0.8],
        },
        paint: { "icon-color": "#7d8794", "icon-opacity": 0.8 },
      });
      map.addLayer({
        id: "aircraft",
        type: "symbol",
        source: "aircraft",
        filter: ["any", ["==", ["get", "ground"], 0], ["==", ["get", "sel"], 1]],
        layout: {
          "icon-image": "plane",
          "icon-rotate": ["get", "track"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            ["*", 0.55, ["case", ["==", ["get", "sel"], 1], 1.45, ["==", ["get", "heavy"], 1], 1.1, 0.85]],
            10,
            ["*", 0.95, ["case", ["==", ["get", "sel"], 1], 1.45, ["==", ["get", "heavy"], 1], 1.1, 0.85]],
          ],
          "symbol-sort-key": ["get", "sort"],
        },
        paint: {
          "icon-color": [
            "case",
            ["==", ["get", "sel"], 1],
            "#ffffff",
            ["==", ["get", "ground"], 1],
            "#7d8794",
            ["==", ["get", "phase"], "landing"],
            "#3ddc97",
            ["==", ["get", "phase"], "takeoff"],
            "#ff9f43",
            "#54a0ff",
          ],
          "icon-halo-color": "rgba(0,0,0,0.6)",
          "icon-halo-width": 1,
        },
      });
      map.addLayer({
        id: "aircraft-labels",
        type: "symbol",
        source: "aircraft",
        minzoom: 8,
        layout: {
          "text-field": ["get", "cs"],
          "text-size": 11,
          "text-offset": [0, 1.6],
          "text-font": ["Noto Sans Regular"],
          "text-optional": true,
        },
        paint: { "text-color": "#e8ecf1", "text-halo-color": "#0b0d10", "text-halo-width": 1.2 },
      });

      // Only airports with a public webcam are shown and clickable.
      const { webcamAirports } = await import("@flightradar/core/webcams");
      const { airportByIcao } = await import("@flightradar/core/airports");
      lookupAirport.current = airportByIcao;
      (map.getSource("airports") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: webcamAirports().map((a) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [a.lon, a.lat] },
          properties: { icao: a.icao, iata: a.iata || a.icao, name: a.name },
        })),
      });
      void poll();
    });

    map.on("click", (e: MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(
        [
          [e.point.x - 8, e.point.y - 8],
          [e.point.x + 8, e.point.y + 8],
        ],
        { layers: ["aircraft", "aircraft-ground", "airports"] },
      );
      const plane = hits.find((f: MapGeoJSONFeature) => f.layer.id === "aircraft" || f.layer.id === "aircraft-ground");
      if (plane) return propsRef.current.onAircraftClick(String(plane.properties.hex));
      const airport = hits.find((f: MapGeoJSONFeature) => f.layer.id === "airports");
      if (airport) return propsRef.current.onAirportClick(String(airport.properties.icao));
      propsRef.current.onBackgroundClick();
    });
    for (const layer of ["aircraft", "aircraft-ground", "airports"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    // ## Data polling
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    async function poll() {
      if (inflight) return;
      inflight = true;
      try {
        const res = await api.aircraft();
        propsRef.current.onStatus({ status: res.status, updatedAt: res.updatedAt, at: Date.now() });
        const next = new Map<string, AircraftDto>();
        for (const a of res.aircraft) next.set(a.hex, a);
        // The server list is authoritative: a flight it no longer reports is
        // gone (the app then moves the selection on and says so).
        const sel = propsRef.current.selectedHex;
        aircraft.current = next;
        const s = sel ? next.get(sel) : undefined;
        if (s && trail.current.hex === sel) trail.current.points.push([s.lon, s.lat]);
        propsRef.current.onAircraftUpdate([...next.values()], res.arrivals ?? []);
        render();
      } catch {
        // keep showing the last state; next poll retries
        propsRef.current.onStatus({ status: "error", updatedAt: null, at: Date.now() });
      } finally {
        inflight = false;
        clearTimeout(timer);
        // Slower while the tab is hidden, to save server capacity.
        timer = setTimeout(poll, document.hidden ? 60_000 : 8000);
      }
    }

    // Dead reckoning between polls keeps the motion smooth.
    const tick = setInterval(render, 1000);

    function render() {
      const src = map.getSource("aircraft") as GeoJSONSource | undefined;
      if (!src) return;
      const now = Date.now();
      const { selectedHex } = propsRef.current;
      const features: Feature[] = [];
      let selectedPos: [number, number] | null = null;
      for (const a of aircraft.current.values()) {
        const pos = extrapolate(a, now);
        const sel = a.hex === selectedHex ? 1 : 0;
        if (sel) selectedPos = pos;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: pos },
          properties: {
            hex: a.hex,
            cs: a.callsign ?? a.registration ?? a.hex,
            track: a.trackDeg ?? 0,
            alt: a.onGround ? 0 : (a.altitudeFt ?? 0),
            ground: a.onGround ? 1 : 0,
            heavy: a.type && /^(A3[3-8]|A35|B7[4-8]|B77|B78|A34)/.test(a.type) ? 1 : 0,
            markets: a.markets ?? 0,
            phase: a.phase ?? "",
            sel,
            sort: sel ? 3 : a.markets ? 1 : 0,
          },
        });
      }
      src.setData({ type: "FeatureCollection", features });

      // Departure airports of the shown flights and their legs.
      const find = lookupAirport.current;
      if (find) {
        const origins = new Map<string, { lat: number; lon: number; iata: string; icao: string }>();
        const legs: GeoFeature[] = [];
        for (const f of features) {
          const a = aircraft.current.get(String(f.properties.hex));
          if (!a?.origin || !a.airport) continue;
          const o = find(a.origin);
          const d = find(a.airport);
          if (!o || !d) continue;
          origins.set(o.icao, o);
          const pos = { lon: f.geometry.coordinates[0]!, lat: f.geometry.coordinates[1]! };
          legs.push({ type: "Feature", geometry: { type: "LineString", coordinates: greatCircle(o, pos, 24) }, properties: { leg: "flown" } });
          legs.push({ type: "Feature", geometry: { type: "LineString", coordinates: greatCircle(pos, d, 24) }, properties: { leg: "ahead" } });
        }
        (map.getSource("origins") as GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: [...origins.values()].map((o) => ({ type: "Feature", geometry: { type: "Point", coordinates: [o.lon, o.lat] }, properties: { iata: o.iata || o.icao } })),
        });
        (map.getSource("flows") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: legs });
      }

      const t = trail.current;
      (map.getSource("trail") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features:
          t.hex === selectedHex && t.points.length > 0 && selectedPos
            ? [{ type: "Feature", geometry: { type: "LineString", coordinates: [...t.points, selectedPos] }, properties: {} }]
            : [],
      });
      const dest = propsRef.current.destination;
      (map.getSource("route") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features:
          dest && selectedPos
            ? [{ type: "Feature", geometry: { type: "LineString", coordinates: greatCircle({ lon: selectedPos[0], lat: selectedPos[1] }, dest) }, properties: {} }]
            : [],
      });
    }

    (mapRef as { render?: () => void }).render = render;
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Selection changes: reset the trail and redraw.
  useEffect(() => {
    const sel = props.selectedHex;
    const a = sel ? aircraft.current.get(sel) : undefined;
    trail.current = { hex: sel, points: a ? [[a.lon, a.lat]] : [] };
    (mapRef as { render?: () => void }).render?.();
  }, [props.selectedHex, props.destination?.icao]);

  useEffect(() => {
    if (!props.flyTo || !mapRef.current) return;
    // Keep the aircraft clear of the side panel (desktop) or bottom sheet (mobile).
    const mobile = window.innerWidth <= 720;
    mapRef.current.flyTo({
      center: [props.flyTo.lon, props.flyTo.lat],
      zoom: props.flyTo.zoom ?? Math.max(mapRef.current.getZoom(), 7),
      padding: mobile ? { top: 80, bottom: 360, left: 20, right: 20 } : { top: 90, bottom: 40, left: 200, right: 440 },
    });
  }, [props.flyTo?.key]);

  return <div ref={container} className="map" />;
}
