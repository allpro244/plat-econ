// Drive the game: load, screenshot the start menu, press Break ground,
// wait for the map, screenshot the running game.
import { chromium } from "playwright-core";

const SHOTS = "/home/user/plat/renders";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://localhost:4573/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/game_start.png` });
console.log("start menu shot saved");

// Find and press the Break ground button (footer confirm).
const btn = page.locator("button", { hasText: /break ground/i }).first();
if (await btn.count()) {
  await btn.click();
  console.log("pressed Break ground");
} else {
  const labels = await page.locator("button").allTextContents();
  console.log("no Break ground button; buttons:", labels.slice(0, 12));
}
await page.waitForTimeout(9000);   // city generation + map init
const skip = page.locator("button", { hasText: /i know this/i }).first();
await page.evaluate(() => {
  for (const b of document.querySelectorAll("button")) if (/i know this/i.test(b.textContent)) b.click();
});
await page.waitForTimeout(1000);
console.log("skipped primer");
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/game_map.png` });
console.log("map shot saved; title:", await page.title());
const acquire = page.locator("button,div[role=button],span", { hasText: /^Acquire$/ }).first();
if (await acquire.count()) { await acquire.click({ force: true, timeout: 5000 }).catch(() => console.log("acquire click blocked")); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/game_acquire.png` }); console.log("acquire shot saved"); }
await browser.close();
