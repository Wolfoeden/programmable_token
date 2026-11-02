"""Build packages/core/src/data/airports.json from the OurAirports dataset.

OurAirports data is released into the public domain:
https://ourairports.com/data/

Usage: python3 scripts/build-airports.py path/to/airports.csv
Keeps large and medium airports with scheduled service and a 4-letter ICAO code.
Each row: [icao, iata, name, city, country, lat, lon, elevation_ft, size]
size: 2 = large, 1 = medium.
"""
import csv
import json
import re
import sys

src = sys.argv[1]
rows = []
with open(src, newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["type"] not in ("large_airport", "medium_airport"):
            continue
        if r["scheduled_service"] != "yes":
            continue
        icao = (r["icao_code"] or r["gps_code"] or r["ident"]).strip().upper()
        if not re.fullmatch(r"[A-Z]{4}", icao):
            continue
        try:
            lat = round(float(r["latitude_deg"]), 5)
            lon = round(float(r["longitude_deg"]), 5)
        except ValueError:
            continue
        elev = int(float(r["elevation_ft"])) if r["elevation_ft"] else 0
        rows.append([
            icao,
            r["iata_code"].strip().upper(),
            r["name"].strip(),
            r["municipality"].strip(),
            r["iso_country"].strip(),
            lat,
            lon,
            elev,
            2 if r["type"] == "large_airport" else 1,
        ])

rows.sort(key=lambda x: x[0])
seen = set()
unique = []
for r in rows:
    if r[0] in seen:
        continue
    seen.add(r[0])
    unique.append(r)

out = "packages/core/src/data/airports.json"
with open(out, "w", encoding="utf-8") as f:
    json.dump(unique, f, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {len(unique)} airports to {out}")
