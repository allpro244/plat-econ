import { startTransition } from "react";
import { create } from "zustand";
import type { Adjacency, DataManifest, ParcelTable } from "@/data/types";
import type { GameState, Contract, DevUse, UseMix, BuiltClass, BtsCommitment } from "@/engine/types";
import { newGame, advanceMonth, advanceUntilAttentionAsync, attentionItems, firstListings, portfolioMonthlyCF, hangUpOnCall } from "@/engine/sim";
import { deliveriesThisMonth, cityDeliveriesThisMonth } from "@/engine/cycleDigest";
import { monthLabel } from "@/engine/types";
import { routeAttention } from "@/ui/attentionRoute";
import { buyListing, buyOffMarket, submitBlindBid, approachOwner, counterOffMarket, listForSale, delist, acceptSaleOffer, declineSaleOffer, counterSale, counterBid, repriceListing, startRenovation,  setBroker, setBrokerAll, assembleLots, offerGroundLease, pullGroundOffer, bestAndFinal, acceptBid, type BuyProduct } from "@/engine/actions";
import { negotiate, acceptCounter, walkAway, closeDeal } from "@/engine/acquire";
import {
  respondLOI, answerAsk, buildSpecSuites, blendExtend, buyOutTenants, setLeasingHold, workLeasingDesk,
  AGENT_FLOOR_MIN, AGENT_FLOOR_MAX, AGENT_PASS_MIN, AGENT_TI_MONTHS_MIN, AGENT_TI_MONTHS_MAX,
  AGENT_SIGNING_MONTHS_MIN, AGENT_SIGNING_MONTHS_MAX,
  agentFloor, agentPassBelow, type LOIAction,
} from "@/engine/leasing";
import type { Credit } from "@/engine/types";
import { cureWorkout, requestForbearance, deedInLieu, serviceWorkout } from "@/engine/workout";
import { fileTaxAppeal } from "@/engine/tax";
import { buyNote, modifyNote, fileOnNote, sellNote, discountedPayoff } from "@/engine/notes";
import {
  fundPrivateAsk, declinePrivateAsk,
  acceptPrivateBorrowQuote, declinePrivateBorrowQuote,
} from "@/engine/privateCredit";
import { registerAuctionBids } from "@/engine/auction";
import { listPortfolio, repricePortfolio, counterPortfolio, acceptPortfolioBid, delistPortfolio } from "@/engine/portfolio";
import { buyPortfolio } from "@/engine/portfoliosale";
import { fileVariance } from "@/engine/zoning";
import { refinance, buyRateCap, payOffLoan, placeMezz } from "@/engine/debt";
import { drawLoc, repayLoc } from "@/engine/credit";
import { openFacility, repayFacility, releaseFromFacility } from "@/engine/facility";
import { raiseFund, callFundCapital, distributeFund } from "@/engine/fund";
import { clearBuildToSuit, proposeBuildToSuit, startAdaptiveReuse, startDevelopment, startProgram, setStance, setOps, setOpsPolicy, demolish } from "@/engine/dev";
import {
  hire, fire, refreshPool, POOL_REFRESH_M,
  setSearchTier, assignStaff, unassignStaff,
  type OwnerStyle, type BenchStyle,
} from "@/engine/staff";
import { normalizeParcels } from "@/engine/mix";
import { netWorth, resolveRec } from "@/engine/value";
import { loadGame, saveGame, listSaves, deleteSave, clearAllSaves, prepareSaveForResume, type SaveMeta } from "@/engine/save";
import { currentCity, currentSeed, setSeed, rerollCity, setCity, currentSize, setSize, currentDev, setDev, currentCash0, setCash0 } from "@/state/city";
import { cityList, makeCity, type GeneratedCity } from "@/citygen/index.mjs";

export type Lens = "none" | "land" | "demand" | "owners" | "zoning" | "leases" | "listings";
/** Map emphasis filter — dims non-matching massing; never hides the city. */
export type MapFilter = "all" | "owned" | "construction";
export type Page = "none" | "portfolio" | "deals" | "market" | "research" | "economy" | "books" | "news" | "leasing" | "debt" | "property" | "saves" | "notes" | "settings" | "staff" | "primer";

/**
 * WHERE THE APP IS, and the reason this type exists at all.
 *
 * There was no start screen: mount generated a town and the player was in it
 * before they had chosen anything. `boot` is the IndexedDB read that finds out
 * whether there is a campaign to come back to, `menu` is the start screen,
 * `generating` is the half-second to a second and a half `makeCity` spends
 * holding the main thread, and only `playing` means a city and a game exist.
 */
export type Phase = "boot" | "menu" | "generating" | "playing";

/**
 * The campaign the start screen offers to continue — the newest autosave or
 * named snapshot. The save carries island/seed/size/build-out so Continue rebuilds
 * the right town even when this browser last chose a different one.
 */
export interface Resume {
  slot: string;
  island: string;
  seed: number;
  size: string;
  dev: string;
  month: number;
  cash: number;
  savedAt: number;
}

interface AppState {
  parcels: ParcelTable | null;
  bbls: string[];
  adjacency: Adjacency | null;
  manifest: DataManifest | null;
  /** The town this run is played on, generated from (island, seed). */
  city: GeneratedCity | null;
  game: GameState | null;
  selectedBBL: string | null;
  hoveredBBL: string | null;
  // A standing request to put the camera on a parcel. The counter is what makes
  // it fire — asking twice for the same building has to move the map twice, and
  // a bare bbl compares equal to itself.
  flyTo: { bbl: string; n: number } | null;
  /**
   * Fit the camera to the player's book. Counter-fired like `flyTo` so repeat
   * clicks still move the map.
   */
  fitBook: number;
  lens: Lens;
  mapFilter: MapFilter;
  setMapFilter: (f: MapFilter) => void;
  page: Page;
  toast: { text: string; kind: "ok" | "err"; at: number } | null;
  /**
   * The July docket, opened deliberately rather than thrown at you. Purely a
   * view flag — it is not part of the save, because whether a panel happens to
   * be open is not a fact about the campaign.
   */
  auctionOpen: boolean;
  fps: number;
  loadError: string | null;
  /** boot → menu → generating → playing. See Phase. */
  phase: Phase;
  /** The campaign the start screen can go back to, or null if there is none. */
  resume: Resume | null;
  /** The town being generated right now, so the screen can say what it is doing. */
  building: string | null;
  setData: (d: { parcels: ParcelTable; adjacency: Adjacency; manifest: DataManifest; city?: GeneratedCity }) => void;
  select: (bbl: string | null) => void;
  hover: (bbl: string | null) => void;
  /** Select it AND take the camera there. */
  focus: (bbl: string, closePanel?: boolean) => void;
  /** Route an attentionItems key to the right desk / parcel. */
  openAttention: (key: string) => void;
  /** Prior game snapshot for cycle digest deltas (UI only, not saved). */
  prevForDigest: GameState | null;
  /** Non-blocking delivery ceremony payload. */
  deliveryCeremony: {
    bbl: string; address: string; use: string; sf: number; value?: number; rival?: boolean;
  } | null;
  dismissDeliveryCeremony: () => void;
  setAuctionOpen: (v: boolean) => void;
  setLens: (l: Lens) => void;
  setPage: (p: Page) => void;
  setFps: (fps: number) => void;
  setLoadError: (e: string) => void;
  advance: () => void;
  advanceYear: () => void;
  advanceUntil: () => void;
  /** True while Year / Skip is ticking months — advance buttons disable. */
  advancing: boolean;
  counterOff: (bbl: string, px?: number) => void;
  buy: (bbl: string, product: BuyProduct, lev?: number, bid?: number) => void;
  buyOff: (bbl: string, product: BuyProduct, lev?: number, bid?: number) => void;
  /** Blind off-market bid — a number only; financing comes after they take it. */
  bidBlind: (bbl: string, bid: number) => void;
  approach: (bbl: string) => void;
  respondLoi: (id: number, action: LOIAction, fund?: boolean, counter?: { rentPsf?: number; tiPsf?: number; freeM?: number; bumpPct?: number; bestFinal?: boolean }) => { ok: boolean; msg: string };
  /** Answer a tenant's mid-lease relief letter. */
  answerAsk: (id: number, action: "grant" | "decline") => void;
  /**
   * THE MASTER SWITCH FOR POP-UP CARDS. Every decision the cards carry also
   * lives on a page (letters on the Deals desk, offers on the portfolio, the docket
   * on Marketplace), so turning the cards off loses nothing but the
   * interruption — which is the point when you are simulating twenty years.
   * UI preference, not save state: it persists in localStorage, not the file.
   */
  popupsOff: boolean;
  setPopupsOff: (v: boolean) => void;
  /**
   * SILENCE EVERYTHING, INCLUDING THE FAILURES.
   *
   * `popupsOff` covers the DECISION cards. This covers the alert cards on top
   * of them — a bank going down, a swan, a book taken back — which were exempt
   * because they had no page to live on. They do now: `raiseAlert` files every
   * one of them in the news feed as it fires, so this loses the interruption
   * and not the event. Off by default: a player who has not asked for silence
   * should still be stopped by a bank failure.
   * UI preference, not save state.
   */
  alertsOff: boolean;
  setAlertsOff: (v: boolean) => void;
  /**
   * THE FRAME COUNTER IS A QA INSTRUMENT AND IT WAS ALWAYS ON SCREEN.
   * It sat in the top-right corner of a shipped game reading "4 fps" at people
   * who had not asked. Off by default now, with a switch in Settings for when
   * somebody actually wants it. UI preference, not save state.
   */
  fpsOn: boolean;
  setFpsOn: (v: boolean) => void;
  /**
   * PREFER SMOOTHER FRAMES ON WEAK GPUS.
   * Off by default: a capable machine keeps native pixel density and 4× MSAA,
   * same as before this dial existed. On, it caps DPR, drops MSAA to 2×, and
   * reuses the harbour reflection a frame more often. Skyline, facades,
   * economy and sim depth are untouched — fill-rate only. UI preference, not
   * save state.
   */
  preferFps: boolean;
  setPreferFps: (v: boolean) => void;
  /**
   * Map-only mode — hide firm page sheets so the skyline is the desk.
   * HUD, inbox, digest and decision cards stay. UI preference, not save state.
   */
  mapOnly: boolean;
  setMapOnly: (v: boolean) => void;
  /**
   * Photo frame — hide chrome for a clean skyline still. Escape or P exits.
   * UI preference only; not saved with the campaign.
   */
  photoFrame: boolean;
  setPhotoFrame: (v: boolean) => void;
  /** Request MapView to fit the holdings bounding box. */
  showBookOnMap: () => void;
  /**
   * MARK THE OLDEST INTERRUPTION READ.
   *
   * The engine pushes onto `game.alerts` and the UI drains it one at a time —
   * the whole of the contract, from this side. It is a `shift`, not a filter by
   * id, because the modal shows the oldest and there is exactly one on screen:
   * anything cleverer would be a second opinion about which alert the player is
   * looking at, and the two could disagree.
   *
   * It goes through the store rather than `useStore.setState` at the call site
   * because dismissing has to STICK — an alert read and then reloaded past is a
   * bank failure the player is never told about again.
   */
  dismissAlert: () => void;
  /**
   * HANG UP ON ONE OFF-MARKET FILE. See `hangUpOnCall` in engine/sim.ts for
   * what it does to the record and, more to the point, what it refuses to do.
   */
  hangUpCall: (bbl: string) => void;
  refi: (bbl: string, product: string, lev?: number) => void;
  /** Cordage mezz behind a bank senior — Phase C private-credit stack. */
  placeMezz: (bbl: string) => void;
  /** Retire a mortgage with cash (and the line if needed) — balance + prepay penalty. */
  payOffLoan: (bbl: string) => void;
  develop: (bbl: string, use: DevUse, floors: number, coverage: number, contract: Contract, ltcWanted?: number, custom?: { mix?: UseMix; suites?: Partial<Record<BuiltClass, number>>; bts?: BtsCommitment }, lender?: string, spec?: number) => void;
  proposeBts: (bbl: string, use: DevUse, floors: number, coverage: number) => void;
  clearBts: (bbl: string) => void;
  convertUse: (bbl: string, target: "multifamily" | "mixed", mix?: UseMix) => void;
  offer: (bbl: string, price: number, finalOffer?: boolean) => void;
  closeDeal: (bbl: string, product: string, lev: number) => void;
  acceptCounter: (bbl: string) => void;
  walkAway: (bbl: string) => void;
  raze: (bbl: string) => void;
  program: (bbl: string, id: string) => void;
  stance: (bbl: string, v: -1 | 0 | 1) => void;
  ops: (bbl: string, v: { service?: -1 | 0 | 1; plan?: 0 | 1 | 2 }) => void;
  opsPolicy: (v: { service: -1 | 0 | 1; plan: 0 | 1 | 2; stance?: -1 | 0 | 1 }) => void;
  brokerAll: (on: boolean) => void;
  listSale: (bbl: string, ask: number, mode?: "quiet" | "marketed") => void;
  runBestAndFinal: (bbl: string) => void;
  takeBid: (bbl: string, index: number) => void;
  applyVariance: (bbl: string, targetFar?: number) => void;
  appealTax: (bbl: string) => void;
  prebuild: (bbl: string, use: string, sf: number) => void;
  extendLease: (bbl: string, idx: number) => void;
  cureDefault: (bbl: string) => void;
  serviceWorkout: (bbl: string, on: boolean) => void;
  sellPortfolio: (bbls: string[], ask: number) => void;
  repricePortfolioSale: (ask: number) => void;
  counterPortfolioBid: (price: number) => void;
  acceptPortfolio: (exchange?: boolean) => void;
  pullPortfolio: () => void;
  askForbearance: (bbl: string) => void;
  takeNote: (id: string) => void;
  restructureNote: (id: string) => void;
  fileNote: (id: string) => void;
  offloadNote: (id: string) => void;
  fundPrivateAsk: (id: string) => void;
  declinePrivateAsk: (id: string) => void;
  acceptPrivateBorrowQuote: (id: string) => void;
  declinePrivateBorrowQuote: (id: string) => void;
  /** Buy a street / REO book off Marketplace — see engine/portfoliosale.buyPortfolio. */
  buyStreetBook: (id: string) => void;
  bidAuction: (bids: Record<string, number>) => void;
  payOffAtDiscount: (bbl: string) => void;
  handBackKeys: (bbl: string) => void;
  buyOutLeases: (bbl: string) => void;
  holdLeasing: (bbl: string, on: boolean) => void;
  assemble: (bbls: string[]) => void;
  groundLease: (bbl: string, years: number, review?: import("@/engine/types").GroundReview) => void;
  pullGroundOffer: (bbl: string) => void;
  delistSale: (bbl: string) => void;
  acceptOffer: (bbl: string, exchange?: boolean) => void;
  declineOffer: (bbl: string) => void;
  counterSale: (bbl: string, price: number) => void;
  counterBid: (bbl: string, index: number, price: number) => void;
  reprice: (bbl: string, ask: number) => void;
  renovate: (bbl: string) => void;
  broker: (bbl: string, on: boolean) => void;
  rateCap: (bbl: string) => void;
  setAgent: (on: boolean) => void;
  /** Hand the book to in-house leasing staff (quiet desk at 4%/2%). */
  setTeamLeasing: (on: boolean) => void;
  setRenewalMgmt: (on: boolean) => void;
  /** Auto-sign at or above this share of market (net effective). */
  setAgentFloor: (f: number) => void;
  /** Auto-pass below this share; between pass and floor is referred back. */
  setAgentPassBelow: (f: number) => void;
  setAgentMinCredit: (c: Credit) => void;
  setAgentMaxTiMonths: (m: number) => void;
  setAgentMaxSigningMonths: (m: number) => void;
  /** Paper a cross-collateralised facility over a pool of buildings. */
  openFacility: (bbls: string[], productId: string, lev: number) => void;
  /** Pay the facility down out of cash. */
  repayFacility: (amount: number) => void;
  /** Buy one deed back out of the pool at the release price. */
  releaseFacility: (bbl: string) => void;
  /** Close a player fund vintage (earned — never a menu size). */
  raiseFund: () => void;
  callFundCapital: (amount: number) => void;
  distributeFund: (amount: number) => void;
  /** When true, purchases draw equity from the live fund in its invest period. */
  setFundPay: (on: boolean) => void;
  drawCredit: (amt: number) => void;
  repayCredit: (amt: number) => void;
  /**
   * THE DESK. Hiring is an offer and a notice period, not a purchase — see
   * engine/staff.ts. Nothing here moves money: the salary bills monthly
   * through the G&A line in sim.ts and the severance is charged inside
   * `fire`, which is where the ledger can see it.
   */
  hireStaff: (candidateId: number) => void;
  fireStaff: (staffId: number) => void;
  postJob: () => void;
  setStaffSearchTier: (key: "post" | "network" | "recruiter") => void;
  setStaffOwnerStyle: (style: OwnerStyle) => void;
  setStaffBenchStyle: (style: BenchStyle) => void;
  assignStaffBuilding: (staffId: number, bbl: string) => void;
  unassignStaffBuilding: (staffId: number, bbl: string) => void;
  /** Cut a brand new town on this island at this size and build-out, and play it. */
  startRun: (island: string, size: string, dev: string, cash0?: number) => Promise<void>;
  /** Rebuild the town in a named save and pick the campaign back up. */
  continueRun: () => Promise<void>;
  newRun: () => void;
  devGrant: () => void;
  saveTo: (slot: string) => Promise<void>;
  loadFrom: (slot: string) => Promise<void>;
  dropSave: (slot: string) => Promise<void>;
  slots: SaveMeta[];
  refreshSlots: () => Promise<void>;
}

/** Top 2% of standing stock by building area — only those get the delivery ceremony. */
function deliveryWorthCeremony(game: GameState, parcels: ParcelTable, bbl: string): boolean {
  const built = game.built?.[bbl];
  const rec = resolveRec(parcels, game, bbl);
  const sf = built?.bldgArea ?? rec?.bldgArea ?? 0;
  if (sf <= 0) return false;
  const areas: number[] = [];
  for (const id of Object.keys(game.built ?? {})) {
    const r = resolveRec(parcels, game, id);
    const a = game.built![id]?.bldgArea ?? r?.bldgArea ?? 0;
    if (a > 0) areas.push(a);
  }
  if (areas.length < 2) return sf > 0;
  areas.sort((a, b) => b - a);
  const cutoff = areas[Math.max(0, Math.ceil(areas.length * 0.02) - 1)] ?? 0;
  return sf >= cutoff;
}

function queueDeliveryCeremony(
  prev: GameState,
  next: GameState,
  parcels: ParcelTable | null,
  set: (partial: Partial<AppState>) => void,
) {
  const player = deliveriesThisMonth(prev, next);
  const rival = cityDeliveriesThisMonth(prev, next);
  const candidates = [...player, ...rival].filter((b) => parcels && deliveryWorthCeremony(next, parcels, b));
  const bbl = candidates[0];
  if (!bbl) return;
  const rec = parcels ? resolveRec(parcels, next, bbl) : null;
  const built = next.built?.[bbl];
  set({
    deliveryCeremony: {
      bbl,
      address: rec?.address ?? bbl,
      use: built?.class ?? rec?.class ?? "building",
      sf: built?.bldgArea ?? rec?.bldgArea ?? 0,
      rival: !player.includes(bbl),
    },
  });
  if (player.includes(bbl)) {
    toast(`◆ Delivered — ${rec?.address ?? bbl}.`, "ok");
  }
}

function toast(text: string, kind: "ok" | "err" = "ok") {
  useStore.setState({ toast: { text, kind, at: Date.now() } });
}

/** The live crash-protection slot and legacy auto-slot names. */
function isAutoSlot(slot: string): boolean {
  return slot === "auto" || slot.startsWith("auto@") || slot.startsWith("Auto · ");
}

// Set across a reload to say "this reload is finishing a load, do not stop at
// the menu". Session-scoped on purpose: it must not survive the tab.
const RESUME_FLAG = "bw:resume";
/** Named slot to finish loading after a town rebuild reload. */
const RESUME_SLOT = "bw:resumeSlot";

/** What the islands are called, for the screen that has not built one yet. */
function islandName(id: string): string {
  return cityList().find((c) => c.id === id)?.name ?? id;
}

/**
 * A FRAME ON THE SCREEN BEFORE THE MAIN THREAD GOES AWAY.
 *
 * `makeCity` is synchronous and holds the main thread for the whole build —
 * measured in a headless Chromium on this machine: 120ms for a Hamlet (378
 * lots), 265ms for the standard City (1,421 lots), 979ms for a Great City
 * (5,791 lots), and the game and the map that follow it push a Great City to
 * about six seconds end to end. Calling it in the same task as the click that
 * asked for it means the button never repaints and the player is looking at a
 * page that is, as far as they can tell, broken. Two animation frames put the
 * "laying out the streets" state through layout and paint; the timeout hands
 * the frame to the compositor before the generator takes the thread. Verified
 * by screencast: seven composited frames of the waiting screen, its bar still
 * sweeping, across the 1.1s the generator was holding the thread.
 */
function painted(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
}

/**
 * BUILD THE TOWN, WITHOUT PUBLISHING IT.
 *
 * Handing the parcel table to the store is a separate act because a continue
 * has to test the save against the town BEFORE the map mounts on it — a map
 * built for a town the campaign does not fit is a worse failure than a refusal.
 */
function buildTown(island: string, seed: number, size: string, dev: string) {
  const built = makeCity(island, seed, { size, density: dev });
  // Any record the pipeline still files as "mixed" becomes its dominant use
  // plus an explicit mix, once, at the door.
  const parcels = normalizeParcels(built.parcels as ParcelTable);
  return { built, parcels };
}
/**
 * AUTOSAVE WITHOUT PUTTING INDEXEDDB BACK ON THE CLICK PATH.
 *
 * The original autosave cloned the entire campaign into IDB after every click
 * and was removed because that synchronous structured-clone work was a visible
 * share of interaction latency. Removing it fixed a symptom by making a
 * hundred-year campaign depend on the player remembering to name a slot.
 *
 * Mutations now coalesce for 1.5 seconds, then write during browser idle time.
 * A sequence token prevents an older queued write from landing after a newer
 * one. Named slots remain deliberate snapshots; `auto` is crash protection and
 * the campaign Continue opens when it is newest.
 */
const AUTO_SLOT = "auto";
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;
function persist(game: GameState) {
  const seq = ++persistSeq;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const write = () => {
      if (seq !== persistSeq) return;
      void saveGame(AUTO_SLOT, game).catch(() => { /* private mode / quota: named save UI reports failures */ });
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(write, { timeout: 3000 });
    else setTimeout(write, 0);
  }, 1500);
}

export const useStore = create<AppState>((set, get) => ({
  parcels: null,
  bbls: [],
  adjacency: null,
  manifest: null,
  city: null,
  game: null,
  selectedBBL: null,
  hoveredBBL: null,
  flyTo: null,
  fitBook: 0,
  mapFilter: "all",
  lens: "none",
  page: "none",
  advancing: false,
  prevForDigest: null,
  deliveryCeremony: null,
  auctionOpen: false,
  popupsOff: typeof localStorage !== "undefined" && localStorage.getItem("bw:popups") === "off",
  alertsOff: typeof localStorage !== "undefined" && localStorage.getItem("bw:alerts") === "off",
  fpsOn: typeof localStorage !== "undefined" && localStorage.getItem("bw:fps") === "on",
  preferFps: typeof localStorage !== "undefined" && localStorage.getItem("bw:prefer-fps") === "on",
  mapOnly: typeof localStorage !== "undefined" && localStorage.getItem("bw:map-only") === "on",
  photoFrame: false,
  toast: null,
  fps: 0,
  loadError: null,
  phase: "boot",
  resume: null,
  building: null,
  slots: [],
  setData: (d) => set({ ...d, bbls: Object.keys(d.parcels) }),
  select: (bbl) => {
    // Keep the map click snappy: close overlays immediately, paint the heavy
    // parcel desk as a transition so React can yield to the pointer first.
    const page = bbl && get().page !== "property" ? "none" as const : get().page;
    if (bbl !== get().selectedBBL) {
      startTransition(() => set({ selectedBBL: bbl, page }));
    } else {
      set({ selectedBBL: bbl, page });
    }
  },
  hover: (bbl) => {
    if (bbl === get().hoveredBBL) return;
    set({ hoveredBBL: bbl });
  },
  // Reading about a building and finding it are two different things, and a
  // list of addresses in a panel is not a place. Every row that names a
  // property can put the camera on it.
  setAuctionOpen: (v) => set({ auctionOpen: v }),
  focus: (bbl, closePanel = false) => set((st) => ({
    selectedBBL: bbl,
    flyTo: { bbl, n: (st.flyTo?.n ?? 0) + 1 },
    ...(closePanel ? { page: "none" as Page } : {}),
  })),
  openAttention: (key) => {
    const game = get().game;
    const route = routeAttention(key, game);
    if (route.bbl) {
      set((st) => ({
        selectedBBL: route.bbl!,
        flyTo: { bbl: route.bbl!, n: (st.flyTo?.n ?? 0) + 1 },
      }));
    }
    if (route.auction) set({ auctionOpen: true });
    // Opening a desk leaves map-only — the skyline mode is for watching, not answering.
    if (route.page) {
      try { localStorage.setItem("bw:map-only", "off"); } catch { /* */ }
      startTransition(() => set({ page: route.page!, mapOnly: false }));
    }
  },
  dismissDeliveryCeremony: () => set({ deliveryCeremony: null }),
  setLens: (lens) => set({ lens }),
  setPage: (page) => {
    // Heavy pages (Books, Debt, Market) mount big trees — yield so the nav
    // highlight paints before the page body. Opening a desk leaves map-only.
    if (page !== "none" && get().mapOnly) {
      try { localStorage.setItem("bw:map-only", "off"); } catch { /* */ }
      startTransition(() => set({ page, mapOnly: false }));
      return;
    }
    startTransition(() => set({ page }));
  },
  setFps: (fps) => set({ fps }),
  setLoadError: (loadError) => set({ loadError }),

  advance: () => {
    const { game, parcels, bbls, adjacency, advancing } = get();
    if (!game || !parcels || game.gameOver || advancing) return;
    const cash0 = game.cash;
    const next = advanceMonth(game, parcels, bbls, adjacency);
    set({ game: next, prevForDigest: game });
    queueDeliveryCeremony(game, next, parcels, set);
    // Month-close feedback: the single-month Advance used to be silent, so
    // Yr/Skip felt like the only clock that answered. Stamp the new month,
    // cash movement, and the first thing waiting — short enough to read once.
    const dCash = next.cash - cash0;
    const attn = attentionItems(next)[0];
    // Ignore sub-$1k noise so a quiet month does not stamp "−$0.00M".
    const cashBit = Math.abs(dCash) < 1000 ? ""
      : dCash > 0 ? ` · +$${(dCash / 1e6).toFixed(2)}M`
      : ` · −$${(Math.abs(dCash) / 1e6).toFixed(2)}M`;
    toast(`${monthLabel(next.month)}${cashBit}${attn ? ` · ${attn.label}` : ""}`);
    void persist(next);
  },

  // A year in one click — but stop early the moment something new needs you.
  // Ticks yield between months so the tab stays responsive (the sync form used
  // to freeze the UI for the whole run once the street's book got large).
  advanceYear: () => {
    void (async () => {
      const { game, parcels, bbls, adjacency, advancing } = get();
      if (!game || !parcels || game.gameOver || advancing) return;
      set({ advancing: true });
      try {
        const r = await advanceUntilAttentionAsync(game, parcels, bbls, adjacency, 12, 1);
        // The async tick yields between months. If the player acted while it
        // was yielding, the store now holds a different state descended from
        // the same starting snapshot. Never overwrite that real action with
        // the simulated branch; discard the advance instead.
        if (get().game !== game) {
          toast("Year advance stopped because you made another decision.");
          return;
        }
        set({ game: r.s, prevForDigest: game });
        queueDeliveryCeremony(game, r.s, parcels, set);
        toast(r.reason ? `Stopped after ${r.months} mo: ${r.reason}` : "A year passes.");
        void persist(r.s);
      } finally {
        set({ advancing: false });
      }
    })();
  },

  // Skip ahead until the game needs a decision (up to 3 years).
  advanceUntil: () => {
    void (async () => {
      const { game, parcels, bbls, adjacency, advancing } = get();
      if (!game || !parcels || game.gameOver || advancing) return;
      set({ advancing: true });
      try {
        const r = await advanceUntilAttentionAsync(game, parcels, bbls, adjacency, 36, 1);
        if (get().game !== game) {
          toast("Skip stopped because you made another decision.");
          return;
        }
        set({ game: r.s, prevForDigest: game });
        queueDeliveryCeremony(game, r.s, parcels, set);
        toast(r.reason ? `${r.months} mo later: ${r.reason}` : "Three quiet years. The town hums along.");
        void persist(r.s);
      } finally {
        set({ advancing: false });
      }
    })();
  },

  counterOff: (bbl, px) => {
    const { game, parcels, adjacency } = get();
    if (!game || !parcels || !adjacency) return;
    const r = counterOffMarket(game, parcels, adjacency, bbl, px);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    if (r.msg) toast(r.msg);
    void persist(r.s);
  },

  buy: (bbl, product, lev, bid) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyListing(game, parcels, bbl, product, lev, bid);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    // A lowball can update the tape (news, a pulled listing) without a deed.
    // Do not congratulate the player for a closing that did not happen.
    toast(
      r.msg ?? "Deed recorded. The block knows your name now.",
      r.refused ? "err" : "ok",
    );
    void persist(r.s);
  },

  buyOff: (bbl, product, lev, bid) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyOffMarket(game, parcels, bbl, product, lev, bid);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Off-market. Nobody saw it trade.");
    void persist(r.s);
  },

  bidBlind: (bbl, bid) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = submitBlindBid(game, parcels, bbl, bid);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Bid in.");
    void persist(r.s);
  },

  approach: (bbl) => {
    const { game, parcels, adjacency } = get();
    if (!game || !parcels || !adjacency) return;
    const r = approachOwner(game, parcels, adjacency, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    // Match the panel: a "make me an offer" conversation has no ask on the
    // record. The old toast always said "They named a number" on any get-through,
    // so the next line of UI ("no asking price") looked like a bug.
    const ap = r.s.approaches[bbl];
    const toastMsg = r.refused
      ? "The owner isn't selling."
      : r.blind || ap?.ask === undefined
        ? "They took the call — make them an offer."
        : "They named a number.";
    toast(toastMsg, r.refused ? "err" : "ok");
    void persist(r.s);
  },

  // RETURNS WHAT HAPPENED, because the caller needs to say it.
  //
  // The tenant answers a counter in the same tick — took it, came back once
  // more, or walked — and the only place that answer appeared was a toast. So
  // the card you were working in closed and you had to go and find a small
  // notification somewhere else to learn the outcome of the thing you had just
  // clicked. The toast stays for every other caller; the modal now reads the
  // result and shows it in place.
  respondLoi: (id, action, fund, counter) => {
    const { game, parcels } = get();
    if (!game || !parcels) return { ok: false, msg: "" };
    const r = respondLOI(game, parcels, id, action, fund, counter);
    // An error can still carry a new state — a counter the tenant took but you
    // could not fund kills the deal, and that has to stick.
    if (r.err) { toast(r.err, "err"); if (r.s !== game) { set({ game: r.s }); void persist(r.s); } return { ok: false, msg: r.err }; }
    set({ game: r.s });
    if (r.msg) toast(r.msg);
    void persist(r.s);
    return { ok: true, msg: r.msg };
  },

  setPopupsOff: (v) => {
    try { localStorage.setItem("bw:popups", v ? "off" : "on"); } catch { /* private mode */ }
    set({ popupsOff: v });
  },

  setAlertsOff: (v) => {
    try { localStorage.setItem("bw:alerts", v ? "off" : "on"); } catch { /* private mode */ }
    set({ alertsOff: v });
  },

  setFpsOn: (v) => {
    try { localStorage.setItem("bw:fps", v ? "on" : "off"); } catch { /* private mode */ }
    set({ fpsOn: v });
  },

  setPreferFps: (v) => {
    try { localStorage.setItem("bw:prefer-fps", v ? "on" : "off"); } catch { /* private mode */ }
    set({ preferFps: v });
  },

  setMapOnly: (v) => {
    try { localStorage.setItem("bw:map-only", v ? "on" : "off"); } catch { /* private mode */ }
    set({ mapOnly: v, ...(v ? { page: "none" as Page } : {}) });
  },

  setPhotoFrame: (v) => {
    set({
      photoFrame: v,
      ...(v ? { page: "none" as Page, mapOnly: true } : {}),
    });
  },

  setMapFilter: (f) => set({ mapFilter: f }),

  showBookOnMap: () => {
    const st = get();
    set({
      page: "none" as Page,
      lens: "owners" as Lens,
      mapFilter: "owned" as MapFilter,
      mapOnly: true,
      fitBook: st.fitBook + 1,
    });
    try { localStorage.setItem("bw:map-only", "on"); } catch { /* */ }
  },

  dismissAlert: () => {
    const { game } = get();
    if (!game?.alerts?.length) return;
    const next = { ...game, alerts: game.alerts.slice(1) };
    set({ game: next });
    void persist(next);
  },

  hangUpCall: (bbl) => {
    const { game } = get();
    if (!game) return;
    const next = hangUpOnCall(game, bbl);
    // Nothing to hang up on — a stale click on a file that lapsed between the
    // render and the press. Say nothing rather than toast a lie.
    if (next === game) return;
    set({ game: next });
    toast("Told them it is not for you. The phone still works.");
    void persist(next);
  },

  answerAsk: (id, action) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = answerAsk(game, parcels, id, action);
    if (r.err) { toast(r.err, "err"); if (r.s !== game) { set({ game: r.s }); void persist(r.s); } return; }
    set({ game: r.s });
    if (r.msg) toast(r.msg);
    void persist(r.s);
  },

  refi: (bbl, product, lev) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = refinance(game, parcels, bbl, product, lev);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Repriced. New paper, new clock.");
    void persist(r.s);
  },
  placeMezz: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = placeMezz(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Mezz closed.");
    void persist(r.s);
  },

  payOffLoan: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = payOffLoan(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Paid off.");
    void persist(r.s);
  },

  develop: (bbl, use, floors, coverage, contract, ltcWanted, custom, lender, spec = 0.5) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = startDevelopment(game, parcels, bbl, use, floors, coverage, contract, ltcWanted, custom, lender, spec);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Ground broken. Watch it rise.");
    void persist(r.s);
  },

  proposeBts: (bbl, use, floors, coverage) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = proposeBuildToSuit(game, parcels, bbl, use, floors, coverage);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Listed for build-to-suit.");
    void persist(r.s);
  },

  clearBts: (bbl) => {
    const { game } = get();
    if (!game) return;
    const hadTerms = !!game.btsProspects?.[bbl];
    const next = clearBuildToSuit(game, bbl);
    set({ game: next });
    toast(hadTerms ? "Back on spec — the commitment is gone." : "BTS listing pulled.");
    void persist(next);
  },

  convertUse: (bbl, target, mix) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = startAdaptiveReuse(game, parcels, bbl, target, mix);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Conversion started.");
    void persist(r.s);
  },

  // Buying is a conversation now: the same call opens it and answers their
  // counter, which is why there is one action and not three. It never asks for
  // a lender — agreeing a price and funding the purchase are separate acts.
  offer: (bbl, price, finalOffer) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = negotiate(game, parcels, bbl, price, finalOffer);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },

  closeDeal: (bbl, product, lev) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = closeDeal(game, parcels, bbl, product, lev);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    toast(r.msg ?? "Closed. The deed is yours.");
  },

  acceptCounter: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = acceptCounter(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },

  walkAway: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = walkAway(game, parcels, bbl);
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },
  raze: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = demolish(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Down it comes.");
    void persist(r.s);
  },

  program: (bbl, id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = startProgram(game, parcels, bbl, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Program funded.");
    void persist(r.s);
  },

  stance: (bbl, v) => {
    const { game } = get();
    if (!game) return;
    const next = setStance(game, bbl, v);
    set({ game: next });
    void persist(next);
  },

  ops: (bbl, v) => {
    const { game } = get();
    if (!game) return;
    const next = setOps(game, bbl, v);
    set({ game: next });
    void persist(next);
  },

  brokerAll: (on) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = setBrokerAll(game, parcels, on);
    if (r.err) { toast(r.err, "err"); return; }
    let next = r.s;
    if (on && !next.agent) {
      next = structuredClone(next);
      workLeasingDesk(next, parcels);
    }
    set({ game: next });
    if (r.msg) toast(r.msg);
    else toast(on ? "Exclusives across the book." : "Exclusives ended.");
    void persist(next);
  },

  opsPolicy: (v) => {
    const { game } = get();
    if (!game) return;
    const next = setOpsPolicy(game, v);
    set({ game: next });
    toast("House policy set.");
    void persist(next);
  },

  listSale: (bbl, ask, mode = "quiet") => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = listForSale(game, parcels, bbl, ask, mode);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(mode === "marketed" ? "Campaign under way. Offers are due on the date." : "On the market. Now we wait.");
    void persist(r.s);
  },

  runBestAndFinal: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = bestAndFinal(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Bids refreshed.");
    void persist(r.s);
  },

  takeBid: (bbl, index) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = acceptBid(game, parcels, bbl, index);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Under contract.", r.msg === "They retraded you." ? "err" : undefined);
    void persist(r.s);
  },


  prebuild: (bbl, use, sf) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buildSpecSuites(game, parcels, bbl, use as never, sf);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Pre-build under way.");
    void persist(r.s);
  },

  extendLease: (bbl, idx) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = blendExtend(game, parcels, bbl, idx);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Extended.");
    void persist(r.s);
  },

  // The workout desk. Three ways off the table that you choose; the fourth
  // happens to you if you choose none of them.
  // THE BUNDLE. One process, many deeds — see engine/portfolio.ts.
  sellPortfolio: (bbls, ask) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = listPortfolio(game, parcels, bbls, ask);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "In the market.");
    void persist(r.s);
  },

  repricePortfolioSale: (ask) => {
    const { game } = get();
    if (!game) return;
    const r = repricePortfolio(game, ask);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Repriced.");
    void persist(r.s);
  },

  counterPortfolioBid: (price) => {
    const { game } = get();
    if (!game) return;
    const r = counterPortfolio(game, price);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Answered.");
    void persist(r.s);
  },

  acceptPortfolio: (exchange) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = acceptPortfolioBid(game, parcels, exchange);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Closed.");
    void persist(r.s);
  },

  pullPortfolio: () => {
    const { game } = get();
    if (!game) return;
    const next = delistPortfolio(game);
    set({ game: next });
    toast("Pulled from the market.");
    void persist(next);
  },

  // Elect to carry a defaulted loan out of the rest of the book. See
  // engine/workout.ts — the money is charged in tickWorkouts, not here.
  serviceWorkout: (bbl, on) => {
    const { game } = get();
    if (!game) return;
    const r = serviceWorkout(game, bbl, on);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Done.");
    void persist(r.s);
  },

  cureDefault: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = cureWorkout(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Cured.");
    void persist(r.s);
  },

  askForbearance: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = requestForbearance(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Asked.");
    void persist(r.s);
  },

  // THE NOTE DESK. Buying is a decision; servicing is not, and there is
  // deliberately no action here for it — the coupon arrives in tickNotes.
  takeNote: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyNote(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Bought."); void persist(r.s);
  },
  restructureNote: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = modifyNote(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Restructured."); void persist(r.s);
  },
  fileNote: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = fileOnNote(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Filed."); void persist(r.s);
  },
  offloadNote: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = sellNote(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Sold."); void persist(r.s);
  },
  fundPrivateAsk: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = fundPrivateAsk(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Funded."); void persist(r.s);
  },
  declinePrivateAsk: (id) => {
    const { game } = get();
    if (!game) return;
    const r = declinePrivateAsk(game, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Passed."); void persist(r.s);
  },
  acceptPrivateBorrowQuote: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = acceptPrivateBorrowQuote(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Borrowed."); void persist(r.s);
  },
  declinePrivateBorrowQuote: (id) => {
    const { game } = get();
    if (!game) return;
    const r = declinePrivateBorrowQuote(game, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Passed."); void persist(r.s);
  },
  // A RECEIVER'S BOOK — or a fund winding down. Lives on Marketplace; the
  // engine always put packages on game.portfolios, but nothing ever called
  // buyPortfolio from the UI, so the seizure alert had nowhere to go.
  buyStreetBook: (id) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyPortfolio(game, parcels, id);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s, page: "portfolio" });
    toast(r.msg ?? "Bought the book.");
    void persist(r.s);
  },
  // THE JULY AUCTION. One call, replacing whatever bids were down; ten per
  // cent leaves the account today and the hammer settles the rest next tick.
  bidAuction: (bids) => {
    const { game } = get();
    if (!game) return;
    const r = registerAuctionBids(game, bids);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Registered."); void persist(r.s);
  },
  payOffAtDiscount: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = discountedPayoff(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); toast(r.msg ?? "Paid off."); void persist(r.s);
  },

  handBackKeys: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = deedInLieu(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Keys handed over.", "err");
    void persist(r.s);
  },

  // Clear a building of its tenants, at a price. The only way to a demolition
  // that does not take a decade.
  buyOutLeases: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyOutTenants(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Empty.");
    void persist(r.s);
  },

  holdLeasing: (bbl, on) => {
    const { game } = get();
    if (!game) return;
    const next = setLeasingHold(game, bbl, on);
    set({ game: next });
    toast(on ? "Letting stopped. The roll runs off from here." : "Letting resumed.");
    void persist(next);
  },


  applyVariance: (bbl, targetFar) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = fileVariance(game, parcels, bbl, targetFar);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Filed.");
    void persist(r.s);
  },

  appealTax: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = fileTaxAppeal(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Assessment appealed.");
    void persist(r.s);
  },

  assemble: (bbls) => {
    const { game, parcels, adjacency } = get();
    if (!game || !parcels || !adjacency) return;
    const r = assembleLots(game, parcels, adjacency, bbls);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Assembled.");
    void persist(r.s);
  },

  groundLease: (bbl, years, review = "fixed") => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = offerGroundLease(game, parcels, bbl, years, review);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Offered.");
    void persist(r.s);
  },

  pullGroundOffer: (bbl) => {
    const { game } = get();
    if (!game) return;
    const r = pullGroundOffer(game, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(r.msg ?? "Offer withdrawn.");
    void persist(r.s);
  },

  delistSale: (bbl) => {
    const { game } = get();
    if (!game) return;
    const next = delist(game, bbl);
    set({ game: next });
    toast("Pulled from the market.");
    void persist(next);
  },

  acceptOffer: (bbl, exchange) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = acceptSaleOffer(game, parcels, bbl, exchange);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(exchange ? "Closed — the 1031 clock is running." : "Closed. Cash is position.");
    void persist(r.s);
  },

  counterBid: (bbl, index, price) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = counterBid(game, parcels, bbl, index, price);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },

  reprice: (bbl, ask) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = repriceListing(game, parcels, bbl, ask);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },

  counterSale: (bbl, price) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = counterSale(game, parcels, bbl, price);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s }); void persist(r.s);
    if (r.msg) toast(r.msg);
  },

  declineOffer: (bbl) => {
    const { game } = get();
    if (!game) return;
    const next = declineSaleOffer(game, bbl);
    set({ game: next });
    toast("Passed. The ask stands.");
    void persist(next);
  },

  renovate: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = startRenovation(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Crews mobilized.");
    void persist(r.s);
  },

  broker: (bbl, on) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = setBroker(game, parcels, bbl, on);
    if (r.err) { toast(r.err, "err"); return; }
    let next = r.s;
    // Hiring clears live letters the same month — otherwise the exclusive is
    // on the building and the popups still fire until the next tick.
    if (on && !next.agent) {
      next = structuredClone(next);
      workLeasingDesk(next, parcels);
    }
    set({ game: next });
    toast(on ? "Exclusive signed — they work that building quietly inside your mandate." : "Broker dismissed.");
    void persist(next);
  },

  rateCap: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = buyRateCap(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Capped. Sleep better.");
    void persist(r.s);
  },

  setRenewalMgmt: (on) => {
    const { game, parcels } = get();
    if (!game) return;
    let next: GameState = { ...game, renewalMgmt: on };
    if (on && parcels && !next.agent) {
      next = structuredClone(next);
      workLeasingDesk(next, parcels);
    }
    set({ game: next });
    toast(on
      ? "Management has the renewals. 2% of lease value on what they sign; new leases still come to you."
      : "You're handling your own renewals again.");
    void persist(next);
  },

  openFacility: (bbls, productId, lev) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = openFacility(game, parcels, bbls, productId, lev);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("The facility is papered.");
    void persist(r.s);
  },

  repayFacility: (amount) => {
    const { game } = get();
    if (!game) return;
    const r = repayFacility(game, amount);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    void persist(r.s);
  },

  releaseFacility: (bbl) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = releaseFromFacility(game, parcels, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    void persist(r.s);
  },

  raiseFund: () => {
    const { game } = get();
    if (!game) return;
    const r = raiseFund(game);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(`Fund raised — $${((r.s.fund?.size ?? 0) / 1e6).toFixed(0)}M vintage.`);
    void persist(r.s);
  },

  callFundCapital: (amount) => {
    const { game } = get();
    if (!game) return;
    const r = callFundCapital(game, amount);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(`Called $${(amount / 1e6).toFixed(2)}M into the vehicle.`);
    void persist(r.s);
  },

  distributeFund: (amount) => {
    const { game } = get();
    if (!game) return;
    const r = distributeFund(game, amount);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Distribution struck.");
    void persist(r.s);
  },

  setFundPay: (on) => {
    const { game } = get();
    if (!game) return;
    const next = { ...game, fundPay: on };
    set({ game: next });
    toast(on
      ? "New purchases draw from the vehicle while the investment period is open."
      : "New purchases draw from firm cash again.");
    void persist(next);
  },

  setAgentFloor: (f) => {
    const { game } = get();
    if (!game) return;
    const floor = Math.min(AGENT_FLOOR_MAX, Math.max(AGENT_FLOOR_MIN, f));
    // Keep the pass line under the sign line when the principal tightens up.
    const pass = Math.min(agentPassBelow({ ...game, agentFloor: floor }), floor - 0.02);
    const next = { ...game, agentFloor: floor, agentPassBelow: pass };
    set({ game: next });
    void persist(next);
  },

  setAgentPassBelow: (f) => {
    const { game } = get();
    if (!game) return;
    const floor = agentFloor(game);
    const pass = Math.min(floor - 0.02, Math.max(AGENT_PASS_MIN, f));
    const next = { ...game, agentPassBelow: pass };
    set({ game: next });
    void persist(next);
  },

  setAgentMinCredit: (c) => {
    const { game } = get();
    if (!game) return;
    const next = { ...game, agentMinCredit: c };
    set({ game: next });
    void persist(next);
  },

  setAgentMaxTiMonths: (m) => {
    const { game } = get();
    if (!game) return;
    const next = {
      ...game,
      agentMaxTiMonths: Math.min(AGENT_TI_MONTHS_MAX, Math.max(AGENT_TI_MONTHS_MIN, Math.round(m))),
    };
    set({ game: next });
    void persist(next);
  },

  setAgentMaxSigningMonths: (m) => {
    const { game } = get();
    if (!game) return;
    const next = {
      ...game,
      agentMaxSigningMonths: Math.min(
        AGENT_SIGNING_MONTHS_MAX,
        Math.max(AGENT_SIGNING_MONTHS_MIN, Math.round(m)),
      ),
    };
    set({ game: next });
    void persist(next);
  },

  setAgent: (on) => {
    const { game, parcels } = get();
    if (!game) return;
    // Hiring used to flip a flag and leave every live letter on the interrupt
    // stack until the next month tick — so "hand it to the agent" still meant
    // working the whole desk yourself for the rest of the month.
    let next: GameState = { ...game, agent: on };
    if (on) {
      // Outside firm takes over — team handoff is redundant while they are on.
      delete next.teamLeasing;
      if (parcels) {
        next = structuredClone(next);
        workLeasingDesk(next, parcels);
        const referred = next.lois.filter((l) => l.referred).length;
        const tally = next.deskMonth?.m === next.month ? next.deskMonth : null;
        toast(referred
          ? `Your agent has the book — ${referred} letter${referred === 1 ? "" : "s"} referred back; the rest are signed or passed. Routine LOIs no longer interrupt.`
          : tally
            ? `Your agent has the book — ${tally.signed} signed, ${tally.passed} passed this month. Routine LOIs no longer interrupt.`
            : "Your agent has the book. They sign inside your mandate, counter the soft ones, pass the junk — 6% on what they sign. Routine LOIs no longer interrupt.");
      }
    } else {
      toast(next.teamLeasing
        ? "Firm agent dismissed — your team still has the book."
        : "You're handling leasing yourself again.");
    }
    set({ game: next });
    void persist(next);
  },

  setTeamLeasing: (on) => {
    const { game, parcels } = get();
    if (!game) return;
    if (on && !(game.staff ?? []).some((x) => x.role === "leasing")) {
      toast("Hire a leasing person on Staff first — then hand them the book.", "err");
      return;
    }
    if (on && game.agent) {
      toast("Dismiss the firm agent first, or leave the book with them.", "err");
      return;
    }
    let next: GameState = { ...game, teamLeasing: on || undefined };
    if (!on) delete next.teamLeasing;
    if (on && parcels) {
      next = structuredClone(next);
      next.teamLeasing = true;
      workLeasingDesk(next, parcels);
      const referred = next.lois.filter((l) => l.referred).length;
      toast(referred
        ? `Your team has the book — ${referred} letter${referred === 1 ? "" : "s"} referred back. Routine LOIs no longer interrupt.`
        : "Your team has the book. They sign inside your mandate at the usual 4%/2% — no LOI popups unless they refer something.");
    } else {
      toast("You're handling leasing yourself again.");
    }
    set({ game: next });
    void persist(next);
  },

  drawCredit: (amt) => {
    const { game, parcels } = get();
    if (!game || !parcels) return;
    const r = drawLoc(game, parcels, amt);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Drawn. The meter is running.");
    void persist(r.s);
  },

  repayCredit: (amt) => {
    const { game } = get();
    if (!game) return;
    const r = repayLoc(game, amt);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Paid down.");
    void persist(r.s);
  },

  // THE PAYROLL. An offer is accepted on the spot and then nothing happens for
  // two months while they work out a notice, which is why this toast talks
  // about a start date rather than a hire.
  hireStaff: (candidateId) => {
    const { game } = get();
    if (!game) return;
    const r = hire(game, candidateId);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Offer accepted. They give notice first — the seat is empty until they walk in.");
    void persist(r.s);
  },

  fireStaff: (staffId) => {
    const { game } = get();
    if (!game) return;
    const r = fire(game, staffId);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    // Marked as a bad outcome deliberately, the way handing back keys is: it
    // succeeded, and it cost you three months' pay and your coverage.
    toast("Severance paid. Nobody is in that seat now.", "err");
    void persist(r.s);
  },

  /**
   * POST THE JOB.
   *
   * `refreshPool` is called every month by `tickStaff`, so in ordinary play
   * this never has anything to do — which is the point. It is deliberately
   * passed force=false so that a player cannot make the shortlist reshuffle
   * on demand: a hiring market you can spin produces the decision "spin
   * again" instead of "is this person worth $140,000 a year", and staff.ts
   * says so in as many words.
   *
   * What it is actually for is the two moments the tick cannot cover: a brand
   * new campaign, where the desk exists before the first month has been
   * advanced and there is no pool at all, and a save written before any of
   * this existed. In both, the pool is stale by construction and this posts
   * the first one.
   */
  postJob: () => {
    const { game } = get();
    if (!game) return;
    const age = game.month - (game.hirePool?.m ?? -999);
    if (game.hirePool && age < POOL_REFRESH_M) {
      const wait = POOL_REFRESH_M - age;
      toast(`That list went up ${age} month${age === 1 ? "" : "s"} ago. The next one is ${wait} month${wait === 1 ? "" : "s"} out.`, "err");
      return;
    }
    // refreshPool writes into the state it is handed, and zustand repaints on
    // identity — editing the live object would change the pool and render
    // nothing.
    const next: GameState = JSON.parse(JSON.stringify(game));
    refreshPool(next, false);
    set({ game: next });
    toast("The job is posted. Three names on each desk — property, leasing and construction.");
    void persist(next);
  },

  setStaffSearchTier: (key) => {
    const { game } = get();
    if (!game) return;
    const r = setSearchTier(game, key);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast(key === "post" ? "Posted. Cheap looks, wide bands."
      : key === "network" ? "Working the network — tighter first impressions."
        : "Recruiter retained. You paid for a sharper read.");
    void persist(r.s);
  },

  setStaffOwnerStyle: (_style) => {
    // Free capacity dial removed — firm shape emerges from headcount.
  },

  setStaffBenchStyle: (_style) => {
    // Free capacity dial removed — firm shape emerges from headcount.
  },

  assignStaffBuilding: (staffId, bbl) => {
    const { game } = get();
    if (!game) return;
    const r = assignStaff(game, staffId, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    const who = (r.s.staff ?? []).find((x) => x.id === staffId);
    toast(who?.role === "construction"
      ? "On that job — their cover is now that site's load."
      : "Pinned — that building is their load now, not a skill chip on the firm desk.");
    void persist(r.s);
  },

  unassignStaffBuilding: (staffId, bbl) => {
    const { game } = get();
    if (!game) return;
    const r = unassignStaff(game, staffId, bbl);
    if (r.err) { toast(r.err, "err"); return; }
    set({ game: r.s });
    toast("Back on the float desk.");
    void persist(r.s);
  },

  refreshSlots: async () => {
    const all = await listSaves();
    set({ slots: all.filter((m) => !isAutoSlot(m.slot)).sort((a, b) => b.savedAt - a.savedAt) });
  },

  saveTo: async (slot) => {
    const { game } = get();
    if (!game) return;
    // Stamp the island so Continue / a later load can rebuild the right coast.
    const stamped: GameState = {
      ...game,
      cityIsland: game.cityIsland ?? currentCity(),
      citySeed: game.citySeed ?? currentSeed(),
      citySize: game.citySize ?? currentSize(),
      cityDev: game.cityDev ?? currentDev(),
    };
    await saveGame(slot, stamped);
    set({ game: stamped });
    await get().refreshSlots();
    toast(`Saved to “${slot}”.`);
  },

  loadFrom: async (slot) => {
    const { parcels } = get();
    const raw = await loadGame(slot);
    if (!raw || !parcels) { toast("That save wouldn't open.", "err"); return; }
    const prepared = prepareSaveForResume(raw);
    if (!prepared.ok) { toast(`That save can't be opened — ${prepared.reason}.`, "err"); return; }
    const saved = prepared.state;

    // A SAVE CARRIES ITS OWN TOWN.
    //
    // Rebuild the town it was played in when the seed (or island) does not
    // match what is live — same reload choreography as Continue.
    const savedSeed = saved.citySeed;
    const savedIsland = saved.cityIsland ?? currentCity();
    const here = get().game?.citySeed ?? currentSeed();
    const hereIsland = currentCity();
    if (
      (savedSeed !== undefined && savedSeed !== here)
      || savedIsland !== hereIsland
    ) {
      toast(`Loading "${slot}" — rebuilding the town it was played in.`);
      try {
        sessionStorage.setItem(RESUME_FLAG, "1");
        sessionStorage.setItem(RESUME_SLOT, slot);
      } catch { /* private mode: the menu, with Continue offered */ }
      location.reload();
      return;
    }
    // Legacy saves with no seed fall back to the old fit test. BBL ids repeat
    // across seeds, so this is a weak check and only a fallback — a foreign
    // save with two holdings can pass it.
    if (savedSeed === undefined) {
      const fits = Object.keys(saved.holdings).every((b) => parcels[b])
        && saved.listings.every((l) => parcels[l.bbl]);
      if (!fits) { toast("That save was made on a different city — it can't be loaded here.", "err"); return; }
    }
    set({ game: saved, selectedBBL: null, page: "none" });
    toast(`Loaded “${slot}”.`);
  },

  dropSave: async (slot) => {
    await deleteSave(slot);
    await get().refreshSlots();
    toast("Save deleted.");
  },

  // Testing money. Not a game mechanic — a debug lever, and it says so.
  devGrant: () => {
    const { game } = get();
    if (!game) return;
    const g: GameState = { ...game, cash: game.cash + 100_000_000 };
    g.news = [{ q: g.month, kind: "info", text: "DEV: $100.0M of testing capital wired in. This never happens in the real game." }, ...g.news];
    set({ game: g });
    void persist(g);
    toast("+$100M (testing).");
  },

  /**
   * A NEW RUN IS A NEW TOWN.
   *
   * It used to reroll the market on the same fixed map: the same blocks, the
   * same lot lines, the same buildings in the same places, so by the third
   * campaign you knew which corner was the good corner before you had bought
   * anything. Now the island stays and everything on it is re-cut — new
   * blocks, new parcels, new building stock, new vacant ground.
   *
   * Which island, how big and how built up are asked on the start screen now,
   * so this no longer takes them: it ends the campaign and goes back there.
   * Named saves are left alone — erase those on the Saves page if you mean to.
   */
  newRun: () => {
    // Reload rather than swapping the city under a live map. The map's init
    // effect builds its sources, its skyline and its opening camera from the
    // city it mounted with, and a game that is already running has a parcel
    // table, an adjacency graph and twenty years of state hanging off it. A
    // reload with no city to build is instant — the generation happens when
    // the player presses Break ground, not on the way to the menu.
    // Do not offer the campaign the player just chose to end as Continue.
    void deleteSave(AUTO_SLOT).finally(() => location.reload());
  },

  /**
   * BREAK GROUND. The town does not exist until this runs.
   *
   * Everything that identifies a town is settled first — island, size,
   * build-out, then the seed, in that order, because `rerollCity` and
   * `setSize` both key off the current island and rolling a seed on the wrong
   * one leaves the pair (island, seed) pointing at a town nobody asked for.
   */
  startRun: async (island, size, dev, cash0) => {
    set({ phase: "generating", building: islandName(island), loadError: null });
    await painted();
    try {
      setCity(island);
      setSize(size, island);
      // The opening bankroll is settled here with the rest of the town's
      // identity, before anything is generated — see START_CASH_CHOICES.
      const money = cash0 ?? currentCash0();
      setCash0(money);
      setDev(dev);
      const seed = rerollCity();
      const { built, parcels } = buildTown(island, seed, size, dev);
      get().setData({
        parcels,
        adjacency: built.adjacency as Adjacency,
        manifest: built.manifest as DataManifest,
        city: built,
      });
      const g = firstListings(newGame(seed, parcels, money), parcels, Object.keys(parcels));
      g.cityIsland = island;
      g.citySeed = seed;
      g.citySize = size;
      g.cityDev = dev;
      set({ game: g, phase: "playing", building: null, resume: null });
      persist(g);
    } catch (e) {
      set({ phase: "menu", building: null });
      get().setLoadError(`The city would not build (${(e as Error).message}). This is a bug — please report it.`);
    }
  },

  /**
   * PICK IT BACK UP. The save carries its own town, so this rebuilds from the
   * save's (island, seed, size, build-out) and not from whatever this browser
   * last chose — the two disagree the moment you start a run on the other
   * island and then come back.
   */
  continueRun: async () => {
    const r = get().resume;
    if (!r) return;
    set({ phase: "generating", building: islandName(r.island), loadError: null });
    await painted();
    try {
      const raw = await loadGame(r.slot);
      const prepared = raw ? prepareSaveForResume(raw) : null;
      if (!prepared?.ok) {
        set({ phase: "menu", building: null, resume: null });
        toast("That campaign is from an older build and can't be opened.", "err");
        return;
      }
      const saved = prepared.state;
      setCity(r.island);
      setSeed(r.seed, r.island);
      setSize(r.size, r.island);
      setDev(r.dev);
      const { built, parcels } = buildTown(r.island, r.seed, r.size, r.dev);
      // A save only fits if every deed in it exists in THIS town. It should,
      // because the town was rebuilt from the save's own three fields — this
      // catches a generator change that moved the lot lines under an old
      // campaign, which is the one case where continuing would hand back a
      // portfolio of parcels that are not there.
      const fits = Object.keys(saved.holdings).every((b) => parcels[b])
        && saved.listings.every((l) => parcels[l.bbl]);
      if (!fits) {
        set({ phase: "menu", building: null, resume: null });
        toast("That campaign's town no longer builds the same way — it can't be continued.", "err");
        return;
      }
      get().setData({
        parcels,
        adjacency: built.adjacency as Adjacency,
        manifest: built.manifest as DataManifest,
        city: built,
      });
      set({ game: saved, phase: "playing", building: null });
    } catch (e) {
      set({ phase: "menu", building: null });
      get().setLoadError(`The city would not build (${(e as Error).message}). This is a bug — please report it.`);
    }
  },
}));

// handle for automated playtests and screenshots, same as window.__map
(window as unknown as { __store?: typeof useStore }).__store = useStore;


export function derivedNetWorth(): number {
  const { game, parcels } = useStore.getState();
  if (!game || !parcels) return 0;
  return netWorth(game, parcels);
}

export function derivedQuarterCF(): number {
  const { game, parcels } = useStore.getState();
  if (!game || !parcels) return 0;
  return portfolioMonthlyCF(game, parcels);
}

export async function fetchGzJson(url: string) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url.split("/").pop()} ${r.status}`);
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }
  // some hosts transparently decode .gz via Content-Encoding — already JSON
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * BOOT TO A MENU, NOT INTO A TOWN.
 *
 * Booting costs one IndexedDB read and generates nothing. Continue is offered
 * from the newest autosave or named snapshot.
 */
const SAVE_GEN_KEY = "bw:saveGen";

/**
 * EACH PLAYABLE BUILD RETIRES THE PREVIOUS CAMPAIGN.
 *
 * `pnpm package` writes `build.json` with a fresh `saveGen`. Same origin
 * (localhost from the launcher) would otherwise keep IndexedDB saves from the
 * last zip under different rules. When the stamp changes, wipe every slot once
 * and remember the new stamp. Dev servers with no `build.json` leave saves alone.
 */
async function retireSavesIfNewBuild(): Promise<void> {
  try {
    const r = await fetch(new URL("build.json", document.baseURI), { cache: "no-store" });
    if (!r.ok) return;
    const body = (await r.json()) as { saveGen?: string };
    if (!body.saveGen) return;
    let prev: string | null = null;
    try { prev = localStorage.getItem(SAVE_GEN_KEY); } catch { /* private mode */ }
    if (prev === body.saveGen) return;
    await clearAllSaves();
    try { localStorage.setItem(SAVE_GEN_KEY, body.saveGen); } catch { /* private mode */ }
  } catch {
    /* no stamp or no IDB: keep whatever is there */
  }
}

async function resumeFromSlot(slot: string): Promise<Resume | null> {
  const raw = await loadGame(slot);
  if (!raw) return null;
  const prepared = prepareSaveForResume(raw);
  if (!prepared.ok) return null;
  const g = prepared.state;
  return {
    slot,
    island: g.cityIsland ?? currentCity(),
    seed: g.citySeed! >>> 0,
    size: g.citySize ?? currentSize(),
    dev: g.cityDev ?? currentDev(),
    month: g.month,
    cash: g.cash,
    savedAt: Date.now(),
  };
}

export async function bootMenu() {
  await retireSavesIfNewBuild();

  let resume: Resume | null = null;
  // A save store that will not open is a reason to offer a new town, never a
  // reason to sit on "looking for a game in progress" forever. Private-mode
  // browsers land here.
  try {
    const metas = await listSaves();
    // Newest state first: usually the debounced autosave, but a named snapshot
    // written later is equally valid. Continue means "where I last left off."
    const latest = metas.sort((a, b) => b.savedAt - a.savedAt);
    for (const m of latest) {
      const r = await resumeFromSlot(m.slot);
      if (!r) continue;
      resume = { ...r, savedAt: m.savedAt };
      break;
    }
  } catch { /* no save store: there is nothing to continue, and that is fine */ }
  useStore.setState({ resume, phase: "menu" });

  // LOADING A NAMED SAVE FROM ANOTHER TOWN COMES BACK THROUGH HERE.
  // `loadFrom` stashes the slot and reloads so the town can rebuild cleanly.
  let asked = false;
  let askedSlot: string | null = null;
  try {
    asked = sessionStorage.getItem(RESUME_FLAG) === "1";
    askedSlot = sessionStorage.getItem(RESUME_SLOT);
    if (asked) sessionStorage.removeItem(RESUME_FLAG);
    if (askedSlot) sessionStorage.removeItem(RESUME_SLOT);
  } catch { /* private mode: the menu is the honest place to land */ }
  if (asked && askedSlot) {
    const r = await resumeFromSlot(askedSlot);
    if (r) {
      useStore.setState({ resume: r });
      await useStore.getState().continueRun();
    }
  } else if (asked && resume) {
    await useStore.getState().continueRun();
  }
}
