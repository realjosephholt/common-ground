# Region data attribution

`regions.tsv.gz` is derived from the [GeoNames](https://www.geonames.org/) geographical
database, used under the [Creative Commons Attribution 4.0 International
licence](https://creativecommons.org/licenses/by/4.0/).

> This work includes data from GeoNames (https://www.geonames.org/), licensed under
> CC BY 4.0. Changes were made: the country, first-level and second-level administrative
> records were extracted from `countryInfo.txt`, `admin1CodesASCII.txt` and
> `admin2Codes.txt`, and reshaped into a single tab-separated file. No geometry is
> included.

The dataset version this extract was taken at is in `VERSION`, and it is the upstream
`Last-Modified` date rather than a number we chose, so it can be compared against the
published feed.

## Why this is vendored rather than downloaded

Seeding an Instance must work with no outbound network and no third-party account, so
that Common Ground can be hosted where the data must not leave (ADR-0012). The only
thing in this repository that reaches GeoNames is
`scripts/build-region-extract.ts`, which a maintainer runs to regenerate this file.

## Why no geometry

Regions exist to *name and nest* places, not to draw them. Density scoring already works
on geohashes. Dropping geometry is what makes a whole-world extract small enough to
vendor at all.

## Scope of this extract

Countries, first-level administrative divisions (states, regions, provinces) and
second-level ones (counties, districts). Wards and communes are not included: GeoNames
publishes them only inside the full 380MB dump, and nothing in the product needs them
yet.

Going deeper is not a drop-in. Parents are resolved from the administrative codes, and
this format carries `admin1_code` and `admin2_code` only — so an `admin3` row would key
the same as an `admin2` one and be parented under the wrong place, silently. Adding a
level means adding its code column here, adding it to `REGION_LEVELS` in
`src/lib/db/schema.ts`, and adding a case to `keyOf`/`parentKeyOf`. The parser refuses
levels it cannot key rather than guessing, so a mismatch fails loudly at seed time.

## Bumping the version

Run `npm run regions:build`, then `npm run regions:reconcile` before committing. GeoNames
retires identifiers, and the reconciliation report is what tells you whether a retired
one is holding up a Conversation.
