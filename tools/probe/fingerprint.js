// A GEOMETRY FINGERPRINT OF THE WHOLE SCENE.
//
// For the one class of change that cannot be reviewed by reading it: lifting
// geometry code out of one closure and into another. `Mason`, `crownTop` and
// `roofDeck` were all pulled out of the generator's rebuild loop, and "looks
// the same" is not a check — five thousand buildings, and a wrong hash stream
// reshuffles every crown in the city while leaving the screenshot plausible.
//
// So: mesh count, vertex count, the summed x and z of every position, and the
// vertex count per style id. A behaviour-preserving extraction leaves all four
// EXACTLY where they were. Anything else is a regression, named.
//
//   node tools/shoot.mjs http://127.0.0.1:5173/ /tmp/fp.png --wait 12000 \
//     --profile /tmp/bw-prof --verbose --settle 6000 \
//     --eval "$(cat tools/probe/fingerprint.js)"
//
// --profile matters: without it every run is a different town (see shoot.mjs).
(async () => { try {
  const S = () => window.__store.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!S().parcels) {
    const b = [...document.querySelectorAll("button")];
    (b.find((x) => /Continue|Resume|Pick it back up/i.test(x.textContent || "")) ||
     b.find((x) => /Break ground/.test(x.textContent || ""))).click();
  }
  for (let i = 0; i < 90 && !S().parcels; i++) await sleep(500);
  await sleep(9000);                     // the opening flyTo, and the first bake
  let verts = 0, meshes = 0, px = 0, pz = 0;
  const st = new Map();
  window.__three.scene.traverse((o) => {
    const g = o.geometry;
    const p = g?.getAttribute?.("position");
    if (!p) return;
    meshes++; verts += p.count;
    for (let i = 0; i < p.count; i++) { px += p.array[i * 3]; pz += p.array[i * 3 + 2]; }
    const a = g.getAttribute("aStyle");
    if (a) for (let i = 0; i < a.count; i++) st.set(a.array[i], (st.get(a.array[i]) || 0) + 1);
  });
  console.error(`FP meshes=${meshes} verts=${verts} sx=${Math.round(px)} sz=${Math.round(pz)} seed=${S().game.citySeed}`);
  console.error("FPSTYLES " + [...st.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => s + ":" + n).join(","));
} catch (e) { console.error("FP ERR " + e.message); } })()
