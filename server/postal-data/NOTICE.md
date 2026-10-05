# Data notice - ph-postal.json

`ph-postal.json` maps each Philippine city / municipality (by PSGC code) to its 4-digit ZIP codes. It is generated
by `scripts/build-ph-postal.mjs` from two open datasets:

1. **unified-zip-codes** - https://github.com/0xC0000094/unified-zip-code - MIT License, (c) 2019 James Ventura.
   Barangay list with PSGC codes (Philippine Statistics Authority) and ZIP codes (Philippine Postal Corporation).
2. **ph-postal-php** - https://github.com/kon2raya24/ph-postal-php - MIT License.
   Its ZIP data derives from **GeoNames** (https://www.geonames.org), licensed **CC BY 4.0**, (c) GeoNames.
   Used here only where a place name matches the city's own name.

The result is community-sourced, not an official PHLPost feed. A ZIP a real resident uses may be missing, and a few
neighbouring municipalities share a ZIP. To correct an entry, edit the source or the script and re-run it.

Hand-made corrections live in `ph-postal-extra.json` (a ZIP added there is accepted for that city on top of
this table, and re-running the script never erases it). The check is used for the Philippines only; other
countries get a postal-format check.

How the app uses this: the ZIP check asks the live Unified ZIP Code API (https://zip.jamesventura.dev, MIT, same data as source 1)
first. This table answers only if that API cannot be reached, and it also supplies the city names used to confirm that a city's
PSGC code and name belong together. Hand-made corrections in `ph-postal-extra.json` are accepted regardless of what the API says.
