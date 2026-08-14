import type { ReactNode } from "react";
import { useStore } from "@/state/store";

/**
 * Inline CRE literacy — hover for a short definition, click to open Primer.
 * Does not change any game numbers.
 */
const TERMS: Record<string, { def: string; primerHint?: string }> = {
  NOI: {
    def: "Net operating income — rent collected minus operating costs. Does not subtract the mortgage.",
  },
  "cap rate": {
    def: "Capitalisation rate — one year's NOI divided by price. A low cap means an expensive building.",
  },
  DSCR: {
    def: "Debt service coverage ratio — NOI ÷ annual debt service. Lenders usually want ≥1.25×.",
  },
  LTV: {
    def: "Loan-to-value — loan balance ÷ appraisal. Coverage often binds before leverage does.",
  },
  WALT: {
    def: "Weighted average lease term — how long the rent roll has left, weighted by rent.",
  },
  NNN: {
    def: "Triple-net lease — tenant reimburses taxes, insurance and operating expenses.",
  },
  TI: {
    def: "Tenant improvement allowance — cash you spend to fit out space for a new lease.",
  },
  IO: {
    def: "Interest-only period — you pay coupon but not principal until amortisation starts.",
  },
  "going-in cap": {
    def: "In-place NOI ÷ purchase price — the yield you buy at before lease-up or growth.",
  },
  "negative leverage": {
    def: "When the loan coupon exceeds the cap rate you buy at — debt compresses equity returns.",
  },
  balloon: {
    def: "Principal due at maturity. Must be refinanced or repaid — the classic cycle risk.",
  },
  FAR: {
    def: "Floor area ratio — max buildable floor space as a multiple of lot area.",
  },
};

export function Gloss({
  term,
  children,
}: {
  term: keyof typeof TERMS | string;
  children?: ReactNode;
}) {
  const setPage = useStore((s) => s.setPage);
  const entry = TERMS[term] ?? TERMS[term.toLowerCase()];
  if (!entry) return <>{children ?? term}</>;
  return (
    <button
      type="button"
      className="gloss"
      title={entry.def}
      onClick={(e) => {
        e.stopPropagation();
        setPage("primer");
      }}
    >
      {children ?? term}
    </button>
  );
}

export const GLOSSARY_TERMS = TERMS;
