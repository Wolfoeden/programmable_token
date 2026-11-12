import type { Map } from "maplibre-gl";
import { deathZones } from "@flightradar/core/deathzones";

/** Geographic overlays only: the base style, camera and controls stay intact. */
export function addDeathZones(map: Map) {
  const width = 22, height = 16;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Periodic diagonal tile: seamless under pan/zoom.
    if (((8 * x - 11 * y) % 176 + 176) % 176 < 14) pixels.set([255, 72, 81, 71], (y * width + x) * 4);
  }
  map.addImage("deathzone-hatch", { width, height, data: pixels }, { pixelRatio: 1 });
  map.addSource("deathzones", { type: "geojson", data: deathZones });
  // Insert beneath existing basemap labels; flight layers are added afterwards.
  const before = map.getStyle().layers?.find(l => l.type === "symbol")?.id;
  map.addLayer({ id: "deathzone-glow", type: "line", source: "deathzones", paint: {
    "line-color": "#DC2439", "line-opacity": .37, "line-width": 18, "line-blur": 10,
  } }, before);
  map.addLayer({ id: "deathzone-fill", type: "fill", source: "deathzones", paint: {
    "fill-color": "#5F1B2B", "fill-opacity": .8,
  } }, before);
  map.addLayer({ id: "deathzone-haze", type: "fill", source: "deathzones", paint: {
    "fill-color": "#FA2839", "fill-opacity": .08,
  } }, before);
  map.addLayer({ id: "deathzone-hatch", type: "fill", source: "deathzones", paint: {
    "fill-pattern": "deathzone-hatch",
  } }, before);
  map.addLayer({ id: "deathzone-border", type: "line", source: "deathzones", paint: {
    "line-color": "#FF3545", "line-width": 1.5,
  } }, before);
}
