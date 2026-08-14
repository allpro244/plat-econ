/**
 * Person card — principal display + estate bill when succession has fired.
 *
 * Your own attributes are visible. Nobody else's true attrs are ever shown.
 * Markup matches DebtPage `Row` / `.grid` (sibling `.k` + `.v`).
 */
import type { GameState } from "@/engine/types";
import { monthLabel } from "@/engine/types";
import {
  ageYears, birthYear, ATTR_LABEL_PERSON, GENERAL_PERSON_ATTRS, topCareerLines,
  type Person,
} from "@/engine/people";
import { personProgress } from "@/engine/firmCapital";
import { elect6166, ESTATE_TAX_RATE } from "@/engine/estate";
import { useStore } from "@/state/store";
import { usd } from "./format";

// toast is a module helper on the store file — same pattern as StaffPage actions.

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="k">{k}</div>
      <div className="v mono">{v}</div>
    </>
  );
}

export function PersonCard({
  person,
  game,
  showAttrs = false,
  title,
}: {
  person: Person;
  game: GameState;
  /** True only for seat "you". */
  showAttrs?: boolean;
  title?: string;
}) {
  const age = ageYears(person, game.month);
  const bill = person.seat === "you" ? game.estateDue : undefined;
  const prog = personProgress(person, game.month);

  return (
    <div className="page-section" style={{ marginTop: 8 }}>
      <div className="page-section-head">{title ?? person.name}</div>
      <div className="grid" style={{ margin: "6px 0" }}>
        <Row k="Principal" v={person.name} />
        <Row k="Age" v={String(age)} />
        <Row k="Born" v={String(birthYear(person))} />
        {person.seat === "you" && (
          <Row k="Firm" v={game.firm?.name ?? "—"} />
        )}
        {person.seat === "rival" && (
          <Row k="Seat" v="Operating principal" />
        )}
        {prog.careerYears > 0 && (
          <Row k="Career" v={`${prog.careerYears.toFixed(1)} years operating exposure`} />
        )}
        {topCareerLines(person.career).length > 0 && (
          <Row k="Knows" v={topCareerLines(person.career).join(" · ")} />
        )}
        {person.seat === "you" && prog.deathAge != null && (
          <Row
            k="Clock"
            v={`drawn death age ~${prog.deathAge.toFixed(0)}`}
          />
        )}
      </div>
      {showAttrs && person.seat === "you" ? (
        <>
          <div className="hint" style={{ marginTop: 4 }}>
            Deal sense, Bandwidth, Rigor, Access — temperament, not a skill build.
            Career (“Knows …”) is what you have actually done. Nobody else's true
            ability is a number on a screen; you narrow a read by dealing with them.
          </div>
          <div className="grid" style={{ marginTop: 8 }}>
            {GENERAL_PERSON_ATTRS.map((k) => {
              const v = person.attrs[k] ?? 50;
              return (
                <div key={k} style={{ display: "contents" }}>
                  <div className="k">{ATTR_LABEL_PERSON[k] ?? k}</div>
                  <div className="v mono">
                    <span style={{
                      display: "inline-block", width: 120, height: 6,
                      background: "rgba(43,37,26,0.12)", borderRadius: 2, verticalAlign: "middle",
                      marginRight: 8,
                    }}>
                      <span style={{
                        display: "block", height: "100%", width: `${v}%`,
                        background: "rgba(43,37,26,0.55)", borderRadius: 2,
                      }} />
                    </span>
                    {v}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : person.seat !== "you" ? (
        <div className="hint">
          What they are actually worth is something you will find out by dealing with them —
          not from a card.
        </div>
      ) : null}

      {bill && (bill.remaining ?? 0) > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="page-section-head">Estate tax</div>
          <div className="hint">
            {(ESTATE_TAX_RATE * 100).toFixed(0)}% above the exclusion on the estate of {bill.decedentName}.
            Bases stepped up at death. The rate is a fact about the world — counterplay is §6166, sales, and cash.
          </div>
          <div className="grid" style={{ marginTop: 6 }}>
            <Row k="Gross estate" v={usd(bill.gross)} />
            <Row k="Tax remaining" v={usd(bill.remaining)} />
            <Row k="Due" v={bill.elect6166 ? "§6166 instalments" : monthLabel(bill.deadlineM)} />
          </div>
          {!bill.elect6166 && (
            <button
              type="button"
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => {
                const r = elect6166(useStore.getState().game!);
                if (r.err) {
                  useStore.setState({ toast: { text: r.err, kind: "err", at: Date.now() } });
                  return;
                }
                useStore.setState({ game: r.s, toast: { text: "§6166 election filed — fourteen-year instalments.", kind: "ok", at: Date.now() } });
              }}
            >
              Elect §6166 · 14-year instalments
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact one-liner for tables. */
export function personAgeLine(person: Person | undefined, month: number): string {
  if (!person) return "—";
  return `${person.name}, ${ageYears(person, month)}`;
}
