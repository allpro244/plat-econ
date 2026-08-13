// IndexedDB saves: named snapshots plus one debounced `auto` crash-protection
// slot. A save is just GameState — parcels/adjacency are deterministic city data.
import type { GameState } from "./types";
import { clearStyleOverrides, ensurePeople } from "./people";

const DB = "broadway-and-wall";
const STORE = "saves";

export interface SaveMeta { slot: string; month: number; cash: number; savedAt: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function saveGame(slot: string, state: GameState): Promise<void> {
  await tx("readwrite", (s) => s.put({ state, savedAt: Date.now() }, slot));
}

/**
 * A save written before extended paper had a field of its own. The date used to
 * be filed inside `heldSince` under an `ext|` prefix; it lives in `extendedTo`
 * now (see the note on `Rival`). Move what is still about a building the firm
 * owns, drop the rest — those were the leak, and a save is exactly where they
 * accumulated.
 */
function migrateExtendedPaper(state: GameState) {
  const EXT = "ext|";
  for (const r of state.rivals ?? []) {
    if (!r.heldSince) continue;
    const own = new Set(r.bbls ?? []);
    for (const k of Object.keys(r.heldSince)) {
      if (!k.startsWith(EXT)) continue;
      const bbl = k.slice(EXT.length);
      if (own.has(bbl)) (r.extendedTo ??= {})[bbl] = r.heldSince[k];
      delete r.heldSince[k];
    }
  }
}

export const SAVE_VERSION = 34 as const;

/**
 * THE VERSION AT WHICH THE GENERATED ISLAND'S GROUND MOVED.
 *
 * A save is `(island, seed, size, build-out)` and the town is REBUILT from it,
 * so anything that changes what a seed produces changes the ground under a
 * campaign's deeds. Park shapes, the esplanade and the linear park all change
 * which cells the obstacle subtraction removes, so the lot lines on a procedural
 * island are cut differently from v33 on.
 *
 * Measured across three seeds, old generator against new: about 30% of deeds
 * vanish outright, and of the ones that survive by BBL, NINETY-NINE PER CENT
 * ARE A DIFFERENT PARCEL — same number, different ground, different size,
 * somewhere else on the island. That is silent corruption and it is much worse
 * than a missing deed: the campaign opens, the portfolio page fills in, and
 * every building the player owns is quietly somewhere they did not buy.
 *
 * THIS IS 34 AND NOT 33 BECAUSE TWO BRANCHES BOTH CLAIMED 33. The Principal
 * break (one Person type, peopleRng, no free style dials) shipped as v33 on
 * one branch while the island generator was being rewritten on another, and
 * they meet here. A save stamped 33 by that branch therefore has people but
 * was still cut by the OLD generator, so its ground moved too and it must be
 * refused on the same terms as a v32. Keying the refusal to 34 rather than 33
 * is what makes that true; the alternative silently opens exactly the
 * campaigns this constant exists to catch.
 */
const ISLAND_GROUND_MOVED_AT = 34;
const PROCEDURAL_ISLAND = "somewhere";   // citygen's PROCEDURAL, not imported: engine does not depend on citygen
const LEGACY_DRAWN_ISLANDS = new Set(["newalden", "kestrel"]);

/** Pure save-shape migrations, also exported for a fast round-trip harness. */
export function migrateSaveState(state: GameState): GameState {
  migrateExtendedPaper(state);
  if (state.varianceApp) {
    state.varianceApps = {
      ...(state.varianceApps ?? {}),
      [state.varianceApp.bbl]: state.varianceApp,
    };
    delete state.varianceApp;
  }
  // The Principal: one Person type, peopleRng, drop free style dials.
  // ensurePeople synthesises a principal and rival faces from peopleRng only;
  // s.rng / staffRng step counts are untouched (BASELINE must stay bit-identical).
  clearStyleOverrides(state);
  ensurePeople(state);
  // Older campaigns bump forward once shape migrations have run — EXCEPT
  // across a break the migration cannot repair. This is the "future hard
  // break" the note above anticipated: no rearrangement of the save's fields
  // can put a deed back on ground the generator no longer cuts, so the save is
  // left at its own version and the gate below refuses it. Refusing a campaign
  // is bad; opening one whose every deed points somewhere else is worse, and
  // it is worse quietly.
  //
  // The bump is CONDITIONAL and must stay conditional — an unconditional
  // `state.v = SAVE_VERSION` after this block would make the gate below
  // unreachable and quietly restore the corruption.
  if (typeof state.v === "number" && state.v < SAVE_VERSION) {
    const groundMoved = state.v < ISLAND_GROUND_MOVED_AT
      && state.cityIsland === PROCEDURAL_ISLAND;
    if (!groundMoved) state.v = SAVE_VERSION;
  } else {
    state.v = SAVE_VERSION;
  }
  return state;
}

/**
 * PURE CONTINUE PREP — migrate, version-gate, require a rebuildable town.
 * The store and the harness both call this so IndexedDB is not the only path
 * that proves a campaign can be resumed.
 */
export function prepareSaveForResume(state: GameState):
  { ok: true; state: GameState } | { ok: false; reason: string } {
  const migrated = migrateSaveState(structuredClone(state));
  if (migrated.cityIsland && LEGACY_DRAWN_ISLANDS.has(migrated.cityIsland)) {
    return {
      ok: false,
      reason: "this campaign was on a hand-drawn island that is no longer in the game — start a new run on a generated town",
    };
  }
  if (migrated.v !== SAVE_VERSION) {
    // Say WHICH kind of stale it is. "Older build" sends somebody looking for
    // a bug in the save format; the truth is that the island itself is cut
    // differently now and the deeds no longer describe real ground.
    return {
      ok: false,
      reason: typeof migrated.v === "number" && migrated.v < ISLAND_GROUND_MOVED_AT
        && migrated.cityIsland === PROCEDURAL_ISLAND
        ? "this campaign's island was drawn by an older map generator, and its deeds no longer match the ground"
        : "unsupported save version",
    };
  }
  if (migrated.citySeed === undefined) {
    return { ok: false, reason: "save has no city seed" };
  }
  return { ok: true, state: migrated };
}

export async function loadGame(slot: string): Promise<GameState | null> {
  try {
    const rec = await tx<{ state: GameState } | undefined>("readonly", (s) => s.get(slot) as IDBRequest<{ state: GameState } | undefined>);
    if (!rec?.state) return null;
    return migrateSaveState(rec.state);
  } catch {
    return null;
  }
}

export async function listSaves(): Promise<SaveMeta[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const store = t.objectStore(STORE);
      const metas: SaveMeta[] = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(metas); db.close(); return; }
        const v = cur.value as { state: GameState; savedAt: number };
        metas.push({ slot: String(cur.key), month: v.state.month, cash: v.state.cash, savedAt: v.savedAt });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteSave(slot: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(slot));
}

/** Drop the whole save database — used when a new playable build lands so
 *  campaigns from a previous zip cannot resume against changed rules. */
export async function clearAllSaves(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clearAllSaves failed"));
    // Another tab holding the DB open — treat as best-effort; boot continues.
    req.onblocked = () => resolve();
  });
}
