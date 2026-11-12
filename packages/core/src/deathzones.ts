import data from "./deathzones.json";

// Natural Earth 1:50m Admin 0 countries (public domain).
// https://www.naturalearthdata.com/about/terms-of-use/
type Ring = number[][];
type Polygon = Ring[];
export const deathZones = data as {
  type: "FeatureCollection";
  features: { type: "Feature"; properties: { code: string; name: string }; geometry:
    { type: "Polygon"; coordinates: Polygon } | { type: "MultiPolygon"; coordinates: Polygon[] } }[];
};

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i]!; const [px, py] = ring[j]!;
    if ((y! > lat) !== (py! > lat) && lon < (px! - x!) * (lat - y!) / (py! - y!) + x!) inside = !inside;
  }
  return inside;
}

export function deathZoneAt(lon: number, lat: number): string | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const f of deathZones.features) {
    const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polygons.some(p => inRing(lon, lat, p[0]!) && !p.slice(1).some(r => inRing(lon, lat, r)))) return f.properties.code;
  }
  return null;
}

// Cover every country's bounding box, including detached islands. At these
// latitudes each 5 x 5.5 degree cell fits inside a 250 NM upstream query.
export const deathZoneTiles = (() => {
  const tiles = new Map<string, { lat: number; lon: number }>();
  for (const f of deathZones.features) {
    const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const polygon of polygons) {
      const points = polygon[0]!;
      const west = Math.min(...points.map(p => p[0]!)), east = Math.max(...points.map(p => p[0]!));
      const south = Math.min(...points.map(p => p[1]!)), north = Math.max(...points.map(p => p[1]!));
      for (let x = Math.floor(west / 5.5); x <= Math.floor(east / 5.5); x++) {
        for (let y = Math.floor(south / 5); y <= Math.floor(north / 5); y++) {
          tiles.set(`${x},${y}`, { lon: (x + .5) * 5.5, lat: (y + .5) * 5 });
        }
      }
    }
  }
  return [...tiles.values()];
})();
