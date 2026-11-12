# Six-country map overlay

The existing map style, camera, controls and aircraft styling are unchanged.
MapLibre adds geographic fill, hatch, haze, glow and border layers beneath labels
and aircraft for Lebanon, Syria, Iraq, Yemen, Iran and Afghanistan.
These country masks are visual styling, not verified airspace restrictions.

Geometry: Natural Earth 1:50m Admin 0 Countries, public domain.
Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson
Terms: https://www.naturalearthdata.com/about/terms-of-use/
Only the six geometries and their country names/codes are bundled.

Regional aircraft use the existing ADSB_BASE_URL and ADSB_FALLBACK_URL settings.
No new environment variables, API keys, dependencies or database migrations.
The server alternates one discovery tile and one batch of up to 40 known
regional aircraft every 2.5 seconds plus upstream latency. All 29 discovery
cells are covered in roughly 2.5 minutes when known-aircraft updates alternate.
Aircraft are filtered to actual country polygons, airborne only, deduplicated
by hex and removed after 120 seconds without a fresh position. Known positions
are updated in batches through the existing map request budget. Oracle tracking
keeps its separate request budget. Scanning stops after 90 seconds without viewers.

The existing /api/aircraft response includes regional aircraft alongside webcam
traffic; regionalTraffic reports scan status and timestamp independently.
An empty successful response means no aircraft were reported by the provider,
not that the airspace is empty. Reception varies by region. No synthetic
positions or simulated fallback are supplied. The existing aircraft detail
endpoint is reused, and overflights do not automatically become betting markets.

Deploy through the existing Render workflow after reviewing/merging the PR.
This change does not trigger a deployment itself. Verify actual data availability
on the deployed service; local browser QA covers overlays without a chain backend.
