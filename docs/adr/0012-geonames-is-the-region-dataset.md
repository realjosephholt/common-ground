# GeoNames (CC BY 4.0) is the vendored Region dataset

Regions come from GeoNames, vendored into the repo and keyed on `geonameId`. An
id/name/level/parent extract of the entire world is ~21 MB expanded, ~5 MB gzipped, with
no geometry: 461,520 administrative units across 228 countries, granular to wards and
communes. `hierarchy.zip` supplies parent/child edges.

Not geometry, and that is what makes this cheap. We need Regions to *name and nest*
places, not to draw them; Density already works on geohashes.

## Why not the obvious alternatives

Recording these so they are not re-proposed:

- **GADM** — disqualified twice over. Its licence forbids both commercial use and
  redistribution outright.
- **Natural Earth** — cleanest licence of all, but fails on granularity: its `admin_2`
  layer is 3,224 records and entirely USA. There is no global county layer.
- **geoBoundaries** — advertises CC BY 4.0, but each country inherits its upstream terms,
  producing 19 distinct licence strings across ADM2. Switzerland and Spain carry bespoke
  licences and Oman is direct-permission that does not transfer. Vendoring would mean
  auditing ~180 licence strings.
- **Eurostat NUTS/LAU** — flagged as genuinely ambiguous. Secondary sources indicate a
  EuroGeographics commercial-use restriction; the primary conditions-of-use document
  could not be retrieved. Not relied on either way.
- **OpenStreetMap / Overture** — best geometry, and ODbL does not touch our code. But any
  filtering or reshaping produces a Derivative Database carrying share-alike and
  alteration-disclosure obligations. Fine later in a segregated directory *if* geometry
  is ever needed; unnecessary overhead now.
- **Who's On First** — the best-designed ID lifecycle of any candidate
  (`supersedes`/`superseded_by`), but the US repo alone is 1.86 GB and the licence is a
  patchwork across 312 upstream sources. Revisit only if GeoNames' hierarchy proves
  insufficient.

## Consequences

Key on `geonameId`, **never** on the concatenated admin codes (`US.CA.001`) — those are
country-specific and get restructured. GeoNames publishes daily `deletes-*.txt` and
`modifications-*.txt` feeds, so a version bump must run a reconciliation script that
detects foreign-key breakage rather than leaving it to be discovered later. Attribution
is required by CC BY 4.0 and belongs in the vendored directory and the README.
