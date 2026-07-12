# Kazakh UI catalog

This folder owns the complete `kk` application catalog. Every module is checked against the
canonical English key union at compile time; missing or extra keys fail TypeScript. Technical market
terms such as Pine, live, paper, stop, take-profit, footprint and walk-forward intentionally match
the terminology used in `docs/kk/` rather than being translated literally.

When adding a user-visible key, update EN, RU and KK in the same change and extend a focused unit or
browser assertion for safety-critical copy.
