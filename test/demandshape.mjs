// IS DEMAND ONE HILL, OR A CITY OF NEIGHBOURHOODS?
//
//   pnpm demandshape           six generated islands
//   N=20 pnpm demandshape      a wider sweep
//
// Owner: "it seems like there is one point which demand is based off... I don't
// want all the demand surrounding one specific point."
//
// The headline number is the CORRELATION, because it is the only one here that
// does not depend on picking a radius: how much of a lot's demand is explained
// by nothing but its distance from the single best address in town. Near 1.0 is
// one hill with a name on it. A real city is a set of centres that are good for
// different reasons, and the correlation falls as those reasons multiply.
//
// A WARNING WRITTEN INTO THIS FILE BECAUSE IT ALMOST COST A CORRECT CONCLUSION.
// Parcel centroids are lon/lat DEGREES. The first version of this probe counted
// peaks with a 250 "metre" radius applied to degree units — a radius wider than
// the island — so every parcel was inside every other parcel's neighbourhood
// and the peak count was 1 by construction, whatever the engine did. Two
// separate changes were measured as "moved nothing" before the ruler was
// checked. Degrees are converted here; do not undo it.
import { makeCity } from "../src/citygen/index.mjs";
const N = Number(process.env.N ?? 6);
const q=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(p*(b.length-1))];};
const corr=(a,b)=>{const m=(x)=>x.reduce((p,c)=>p+c,0)/x.length;const ma=m(a),mb=m(b);
  let n=0,da=0,db=0;for(let i=0;i<a.length;i++){n+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
  return n/Math.sqrt(da*db);};
console.log(`\nDEMAND SHAPE — ${N} generated islands\n`);
console.log("  seed    peaks(R=250m)   corr(demand, -dist to best point)   top-decile clusters   median  p90");
for(let i=0;i<N;i++){
  const seed=(2166136261 ^ ((i+1)*2654435761))>>>0;
  const c=makeCity("somewhere",seed,{});
  const ps=Object.values(c.parcels).filter(p=>p.cx!==undefined||p.x!==undefined||p.centroid);
  // METRES, NOT DEGREES. Parcel centroids are lon/lat; a 250 m radius in raw
  // degree units covers the whole island, so every parcel is "within range" of
  // every other and the peak count is 1 by construction whatever the engine
  // does. That is a bug in the ruler, not a finding about the city.
  const raw=Object.values(c.parcels).map(p=>{
    const xy=p.centroid ?? (p.cx!==undefined?[p.cx,p.cy]:null);
    return xy?{lon:xy[0],lat:xy[1],d:p.demandScore}:null;}).filter(Boolean);
  const lat0=raw.length?raw.reduce((a,b)=>a+b.lat,0)/raw.length:0;
  const MPD=111_320; // metres per degree of latitude
  const pts=raw.map(p=>({x:p.lon*MPD*Math.cos(lat0*Math.PI/180), y:p.lat*MPD, d:p.d}));
  if(!pts.length){console.log(`  seed ${seed}: no centroids on parcel records`);continue;}
  // local maxima: a point higher than everything within R
  const R=250, R2=R*R;
  let peaks=0;
  const strong=pts.filter(p=>p.d>=q(pts.map(z=>z.d),0.6));
  for(const p of strong){
    let best=true;
    for(const o of pts){const dx=o.x-p.x,dy=o.y-p.y;if(dx*dx+dy*dy<R2&&o.d>p.d+2){best=false;break;}}
    if(best) peaks++;
  }
  // dedupe peaks that are within R of each other
  const pk=[];
  for(const p of strong){
    let best=true;
    for(const o of pts){const dx=o.x-p.x,dy=o.y-p.y;if(dx*dx+dy*dy<R2&&o.d>p.d+2){best=false;break;}}
    if(best&&!pk.some(z=>(z.x-p.x)**2+(z.y-p.y)**2<R2)) pk.push(p);
  }
  const top=pts.reduce((a,b)=>a.d>b.d?a:b);
  const dist=pts.map(p=>-Math.hypot(p.x-top.x,p.y-top.y));
  const dd=pts.map(p=>p.d);
  // how many separate top-decile clusters are there?
  const cut=q(dd,0.9); const hot=pts.filter(p=>p.d>=cut); const cl=[];
  for(const h of hot) if(!cl.some(z=>(z.x-h.x)**2+(z.y-h.y)**2<(400*400))) cl.push(h);
  console.log(`  ${String(seed).slice(0,9).padStart(9)} ${String(pk.length).padStart(12)} ${corr(dd,dist).toFixed(3).padStart(32)} ${String(cl.length).padStart(20)} ${String(q(dd,0.5)).padStart(8)} ${String(q(dd,0.9)).padStart(4)}`);
}
console.log("\n  A city of neighbourhoods has several separated peaks and a WEAK correlation");
console.log("  with distance-to-the-single-best-point. One hill has r near -1 and one cluster.");
