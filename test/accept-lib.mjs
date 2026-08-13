// THE LETTERED SUITES MEASURE. THEY DO NOT GATE.
//
// This is an OWNER DECISION taken on 2026-08-06, not a technical one, and it
// is written down here and in ECONOMY.md so the next reader can tell the
// difference. In the owner's words, across two messages: *"I don't know if I
// want you to follow that rigorous economy testing anymore. The one with
// letters"* and *"Yeah I think there's some of these policies the test that we
// can consider too strict."*
//
// A human has narrowed what is ENFORCED. Nothing here narrows what is
// MEASURED. Every number the lettered suites computed before, they compute
// now, with the same arithmetic and the same bands printed beside them; what
// changed is that a reading outside a band prints BAND and returns zero
// instead of stopping the build.
//
// ------------------------------------------------------------------- why
//
// CLAUDE.md's rule is that a test which cannot fail is a fake. Its mirror is
// just as true and this repo has now paid for it three times: a test that
// fails on a healthy economy is measuring its own noise, and it costs an
// afternoon each time somebody proves the model did not move. Measured this
// session, before any of this was touched:
//
//   sim F   its seven-seed median moved from +1.11%/yr to +1.95%/yr on an
//           unrelated change; per-seed spread -5.21 to +3.63. Raised to 20.
//   sim G   a sign test decided by a median of fifteen, per-seed r from
//           -0.65 to +0.73. Raised to 40 and re-specified.
//   sim H   breached on 13 of 30 NEUTRAL seeds at baseline — a gate that
//           failed on a working economy, from one draw.
//   econ D  a median of three from a distribution with sd 22pp against a
//           15pp budget: over budget 24% of the time regardless of the engine.
//
// Each of those was repaired, and each repair cost more than the fault it
// caught. That is the evidence behind the owner's call, and it is a fair one.
//
// ------------------------------------------------------- what stays a gate
//
// Two things do NOT become reports, and the distinction is not taste:
//
//   `pnpm conserve` is an IDENTITY. Cash reconciled against the ledger every
//   month for fifty years, failing on a single unexplained dollar. There is no
//   band in it to be strict about — either every dollar came from somewhere or
//   one did not. It is untouched by any of this.
//
//   city M is the same shape: no NaN, no negative area, no building standing
//   on no land. Its threshold is ZERO, and a zero is not a calibration. It is
//   marked `identity` below and it still fails the build.
//
// Everything else in A-M is a BAND: a number somebody chose, defensibly, from
// what real markets do. Bands are now reported.
//
// `ACCEPT_STRICT=1` restores the old behaviour for anyone who wants the whole
// suite to gate again — the arithmetic to do it never went away.

export const STRICT = process.env.ACCEPT_STRICT === "1";

/**
 * A suite that prints its readings and knows which of them are allowed to
 * stop the build.
 *
 * report(name, pass, detail)              a BAND — printed, never fatal
 * report(name, pass, detail, "identity")  an IDENTITY — fatal on a breach
 */
export function makeSuite() {
  const results = [];
  const report = (name, pass, detail, kind = "band") => {
    results.push({ name, pass, kind });
    // OK / BAND for a measurement, PASS / FAIL for an identity. The words are
    // different on purpose: "FAIL" on a band reads as a broken build to every
    // human who has ever seen a test runner, and it is not one.
    const tag = kind === "identity" ? (pass ? "PASS" : "FAIL") : (pass ? "  OK" : "BAND");
    console.log(`\n${tag}  ${name}`);
    for (const d of detail) console.log("      " + d);
    if (!pass && kind !== "identity") {
      console.log("      ^ outside the band. REPORTED, NOT GATED — see test/accept-lib.mjs.");
    }
  };
  const verdict = () => {
    const bands = results.filter((r) => r.kind !== "identity");
    const ids = results.filter((r) => r.kind === "identity");
    const outOfBand = bands.filter((r) => !r.pass);
    const broken = ids.filter((r) => !r.pass);
    const letter = (r) => r.name.split(".")[0];
    console.log("\n" + "=".repeat(64));
    console.log(`\n${bands.length - outOfBand.length} of ${bands.length} measurements sit inside their band`
      + (outOfBand.length ? `   outside: ${outOfBand.map(letter).join(", ")}` : ""));
    if (ids.length) {
      console.log(`${ids.length - broken.length} of ${ids.length} identities hold`
        + (broken.length ? `   BROKEN: ${broken.map(letter).join(", ")}` : ""));
    }
    if (broken.length) {
      console.log(`\nAn identity is not a band. This is a real failure.`);
      process.exit(1);
    }
    if (STRICT && outOfBand.length) {
      console.log(`\nACCEPT_STRICT=1: gating on bands as well.`);
      process.exit(1);
    }
    if (outOfBand.length) {
      console.log(`A band is a calibration, not an identity — this run does not fail on one.`);
      console.log(`Run with ACCEPT_STRICT=1 to gate on them.`);
    }
  };
  return { results, report, verdict };
}
