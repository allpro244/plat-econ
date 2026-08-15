// SIDECAR ENTRY: one file, engine inlined — what ships next to plat.exe.
// esbuild resolves the static import below at build time, so the output
// needs nothing but a node runtime (SEA packaging removes even that; see
// docs/GAME-PLAN.md phase 1).
import * as E from "../test/.engine.mjs";
globalThis.__PLAT_ENGINE = E;
await import("./game-server.mjs");
