// Mixed-use is NOT here on purpose. It is not a market — there is no
// mixed-use cap rate and no mixed-use tenant. A building that is part shops,
// part offices and part apartments carries a `mix` and is described by it.
// See engine/mix.ts.
export type AssetClass = "office" | "retail" | "multifamily" | "industrial" | "land";

export interface ParcelRecord {
  bbl: string;
  address: string;
  borough: string;
  block: string;
  lot: string;
  zoneDist: string;
  farMaxComm: number;
  farMaxRes: number;
  bldgClass: string;
  district: string;     // the neighbourhood — the unit of a submarket
  class: AssetClass;              // the dominant use; the mix has the rest
  mix?: Partial<Record<Exclude<AssetClass, "land">, number>>;  // shares of floor area by use
  /**
   * HOW THE BUILDING IS CUT UP, in square feet per leasable space.
   *
   * Absent for everything the generator produced — those fall back to the
   * class defaults in leasing.useSuiteSf, which is what a building of that
   * size and use is normally demised into. It is present on buildings YOU
   * developed, because deciding whether a 200,000 sf tower is eight big floors
   * or ninety small suites is a real programming decision with real
   * consequences: small suites lease faster and cost far more to fit out and
   * to manage, big ones sit empty longer and never turn.
   */
  suites?: Partial<Record<Exclude<AssetClass, "land">, number>>;
  lotArea: number;      // sf
  bldgArea: number;     // sf
  floors: number;
  yearBuilt: number;
  unitsRes: number;
  assessedLand: number;
  assessedTotal: number;
  /**
   * HOW WELL THIS BUILDING WAS BUILT, 0..1, with 0.5 as ordinary market
   * standard. Set when the player or the street breaks ground and never
   * changes afterwards, because it describes the things a renovation cannot
   * reach: the floor-to-floor, the curtain wall, the structure, the plant.
   * Read by `condCeiling` — a trophy specification ages more slowly and keeps
   * a higher ceiling forever.
   */
  buildSpec?: number;
  demandScore: number;  // 0–100
  /** Hedonic multiplier from waterfront / corridor / corner (mean 1). Appraisal only. */
  locPremium?: number;
  shoreM?: number;
  corridorM?: number;
  corner?: boolean;
  landPsf: number;      // $/sf of land, engine-evolved in later phases
  landPsfHistory: number[];
  imputed: string[];
  centroid: [number, number];
}

export type ParcelTable = Record<string, ParcelRecord>;
export type Adjacency = Record<string, string[]>;

export interface DataManifest {
  source: "nyc-open-data" | "synthetic" | "fictional";
  district: string;
  city?: string;
  lots: number;
  adjacencyEdges: number;
}

export const CLASS_LABEL: Record<AssetClass, string> = {
  office: "Office",
  retail: "Retail",
  multifamily: "Multifamily",
  industrial: "Industrial",
  land: "Vacant Land",
};

export const CLASS_COLOR: Record<AssetClass, string> = {
  office: "#7f95ad",
  retail: "#c08552",
  multifamily: "#8aab8a",
  industrial: "#8f8f7a",
  land: "#b5a67f",
};
