# plat-econ

The economy engine for **plat** — the calibrated commercial-real-estate
simulation from Broadway and Wall, extracted headless with its full harness
suite. This repository is the SIM side of plat's load-bearing line: **the sim
owns quantities, the renderer owns form.** Nothing in here knows what a
building looks like; the renderer (github.com/allpro244/plat) never learns
what one is worth.

## Provenance

Ported verbatim from `allpro244/CRE-GAME`, branch
`claude/fable-5-roadmap-kvdyhi` (commit 16f26ea) — the default branch PLUS the
five unmerged roadmap features: stations and infrastructure value events (F1),
zoning variance hearings (F2), tenant expansion/contraction (F3), house-broker
early looks (F4), and firm entry/exit as market output (F5). The React UI,
MapLibre map, NYC data pipeline and packaging were left behind; the engine,
the city generator it tests against, and every harness came along.

That branch is preserved at `CRE-GAME@backup/fable-5-roadmap-2026-08-13`.

## Running

```sh
pnpm install
pnpm engine       # bundle src/engine -> test/.engine.mjs (esbuild, ~50 ms)
pnpm gate         # conservation + external-leak + city acceptance + invariants
pnpm test         # the century: 5 bots x 8 seeds, ~44k simulated months
pnpm audit        # the economy audit
```

There is no test framework. The engine is pure functions over JSON state, so
every harness is a program that plays the game and asserts the state is sane.
`test/entry.mjs` owns the ONE list of modules the harnesses may see — read its
header before adding an export.

Gate status at import: **green** (conserve 7 seeds x 600 months, zero
unexplained; extleak zero stale records; city-accept 3/3 bands + identity;
invariants 600 bot-months, no violations).

## The seam to plat

The engine consumes a generated city through `makeCity(cityId, seed)` —
parcels, adjacency, stations, manifest. plat's `CityPlan` will implement the
same interface from its own island generator; that adapter is the next piece
of work, and it lives on the plat side. Until it exists, the engine tests
against the citygen carried in `src/citygen`.

## Rules

`CLAUDE.md` discipline carries over from both ancestors: no fake frames — no
constant chosen to make an outcome come out right; measure before claiming;
harnesses own their numbers (never re-derive an engine expression in a probe);
and the gate runs before every push.
