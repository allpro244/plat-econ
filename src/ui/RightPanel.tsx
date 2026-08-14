// The game's chrome: a glance card on the map, and firm desks as big rooms.
// Detail pages are parchment sheets sized for underwriting — not a narrow
// right-hand column that crams a rent roll into six hundred pixels.
import { useEffect } from "react";
import { useStore } from "@/state/store";
import StaffPage from "@/ui/StaffPage";
import InboxRail from "@/ui/InboxRail";
import { ParcelPanel } from "@/ui/panels/ParcelDesk";
import { PortfolioPage } from "@/ui/panels/PortfolioPage";
import { DealsPage } from "@/ui/panels/DealsPage";
import { MarketPage } from "@/ui/panels/MarketPage";
import { ResearchPage } from "@/ui/panels/ResearchPage";
import { NotesPage } from "@/ui/panels/NotesPage";
import { EconomyPage } from "@/ui/panels/EconomyPage";
import { BooksPage } from "@/ui/panels/BooksPage";
import { NewsPage } from "@/ui/panels/NewsPage";
import { SavesPage, SettingsPage, PrimerPage } from "@/ui/panels/MiscPages";
import { LeasingPage } from "@/ui/panels/LeasingPage";
import { DebtPage } from "@/ui/panels/DebtPage";
import { PropertyPage } from "@/ui/panels/PropertyPage";
import {
  DecisionModal, AlertModal, AuctionModal, DefaultNoticeModal, GameOverPage,
} from "@/ui/panels/modals";

export { liveBrokerCalls } from "@/ui/panels/broker";

export default function GamePanels() {
  // Subscribe narrowly: a full `game` subscription re-rendered this shell (and
  // used to re-render the docked ParcelPanel) on every Advance/cash write.
  const gameOver = useStore((s) => !!s.game?.gameOver);
  const hasGame = useStore((s) => !!s.game);
  const page = useStore((s) => s.page);
  const mapOnly = useStore((s) => s.mapOnly);
  const setPage = useStore((s) => s.setPage);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        const st0 = useStore.getState();
        if (st0.photoFrame) {
          st0.setPhotoFrame(false);
          return;
        }
        if (document.querySelector(".modal-backdrop")) {
          useStore.setState({
            toast: { text: "Use the card’s action or defer button before closing it.", kind: "err", at: Date.now() },
          });
        } else if (page !== "none") setPage("none");
        else useStore.getState().select(null);
        return;
      }
      const st = useStore.getState();
      if (e.code === "KeyP" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        st.setPhotoFrame(!st.photoFrame);
        return;
      }
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (st.photoFrame) st.setPhotoFrame(false);
        else st.setMapOnly(!st.mapOnly);
        return;
      }
      if (st.advancing) return;
      const wantsTime = e.code === "Space" || e.code === "KeyY" || e.code === "KeyN";
      if (wantsTime && document.querySelector(".modal-backdrop")) {
        e.preventDefault();
        useStore.setState({
          toast: { text: "Answer or dismiss the card on your desk before advancing time.", kind: "err", at: Date.now() },
        });
        return;
      }
      if (e.code === "Space") { e.preventDefault(); st.advance(); }
      else if (e.code === "KeyY") st.advanceYear();
      else if (e.code === "KeyN") st.advanceUntil();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, setPage]);
  if (!hasGame) return null;
  const title = page === "portfolio" ? "Portfolio"
    : page === "deals" ? "The Deals Desk"
    : page === "books" ? "The Books"
    : page === "news" ? "The Tape"
    : page === "leasing" ? "Leasing & Occupancy"
    : page === "debt" ? "Debt"
    : page === "property" ? "Property"
    : page === "saves" ? "Saved Games"
    : page === "economy" ? "Economy"
    : page === "research" ? "Research"
    : page === "notes" ? "The Note Desk"
    : page === "staff" ? "The Desk"
    : page === "settings" ? "Settings"
    : page === "primer" ? "How this business works"
    : "The Marketplace";
  const kicker = page === "portfolio" || page === "leasing" || page === "staff" || page === "property" ? "Assets"
    : page === "deals" || page === "market" || page === "notes" ? "Acquire"
    : page === "debt" || page === "books" ? "Capital"
    : page === "economy" ? "Economy"
    : page === "research" || page === "news" ? "World"
    : page === "saves" ? "Campaign"
    : page === "settings" ? "Preferences"
    : page === "primer" ? "Primer"
    : "Acquire";
  const subtitle = page === "portfolio" ? "Value, income, concentration and the shape of what you own."
    : page === "deals" ? "Every live negotiation, bid, contract and clock on your desk."
    : page === "books" ? "Cash movement, operating results and the record of the firm."
    : page === "news" ? "What changed in the city, and what may change next."
    : page === "leasing" ? "Occupancy, expirations and the mandate you have delegated."
    : page === "debt" ? "Coverage, maturities, pricing and refinancing risk across the book."
    : page === "property" ? "The complete operating, financing and development record."
    : page === "saves" ? "Autosave status and named points you can return to."
    : page === "economy" ? "The real economy, space markets and construction cycle beneath every deal."
    : page === "research" ? "Comparable evidence, submarkets and the assumptions behind value."
    : page === "notes" ? "Buy bank paper, write private bridges, service what you hold."
    : page === "staff" ? "Capacity, judgment and the people carrying your mandates."
    : page === "settings" ? "Display, interruption and simulation controls."
    : page === "primer" ? "The quantities this game expects you to reason with."
    : "On-market listings, off-market calls and motivated sellers.";
  // The map card is a glance. Firm desks open as rooms (~1100px parchment)
  // so a rent roll, deal stage or debt book is readable — the narrow right
  // dock from the map-first pass was too small for that work.
  return (
    <>
      <InboxRail />
      {page === "none" && <ParcelPanel />}
      {page !== "none" && !mapOnly && (
        <div
          className="page-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPage("none");
          }}
        >
          <div className={`page page-${page}`}>
            <div className="page-head">
              <div className="page-heading">
                <div className="page-kicker">{kicker}</div>
                <div className="page-title">{title}</div>
                <div className="page-subtitle">{subtitle}</div>
              </div>
              <button className="panel-close page-close" aria-label={`Close ${title}`} onClick={() => setPage("none")}>×</button>
            </div>
            {page === "portfolio" && <PortfolioPage />}
            {page === "deals" && <DealsPage />}
            {page === "market" && <MarketPage />}
            {page === "research" && <ResearchPage />}
            {page === "notes" && <NotesPage />}
            {page === "economy" && <EconomyPage />}
            {page === "books" && <BooksPage />}
            {page === "news" && <NewsPage />}
            {page === "saves" && <SavesPage />}
            {page === "leasing" && <LeasingPage />}
            {page === "debt" && <DebtPage />}
            {page === "property" && <PropertyPage />}
            {page === "staff" && <StaffPage />}
            {page === "settings" && <SettingsPage />}
            {page === "primer" && <PrimerPage />}
          </div>
        </div>
      )}
      {/* THE INTERRUPTIONS THE ENGINE RAISES, ABOVE THE ONES IT SCHEDULES. An
          alert and a letter of intent can land in the same month, and the order
          matters: the bank that failed is the reason you would answer the letter
          differently. Both render at the same z-index, so the one written last
          is the one on top. */}
      <DecisionModal />
      <AlertModal />
      <AuctionModal />
      <DefaultNoticeModal />
      {/* yield to the saves page — this used to paint over it at the same
          z-index, leaving every control on it visible and dead */}
      {gameOver && page !== "saves" && <GameOverPage />}
    </>
  );
}
