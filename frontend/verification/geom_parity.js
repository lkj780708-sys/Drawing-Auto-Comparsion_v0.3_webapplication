const g = require("./build/geometry.js");
const R = Math.random; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const out = { cloud: [], ell: [], leader: [], bbox: [], hit: [], handles: [], drag: [], choose: [], suit: [], clampsz: [], origin: [] };
const rects = [[10,20,110,70],[0,0,3,200],[5.5,7.25,300.1,40.9],[0,0,10,10],[0,0,25,12.5],[1,1,23.5,9]];
for (const r of rects) { out.cloud.push(g.cloudOutline(...r)); out.ell.push(g.ellipsePoly(...r)); }
const ms = [];
for (let i = 0; i < 60; i++) {
  const kinds = ["textbox","callout","line","arrow","rect","ellipse","polygon","cloud"]; const kind = kinds[i % 8];
  const p = () => [rnd()*200, rnd()*200];
  const pts = kind === "polygon" ? [p(),p(),p(),p()] : kind === "callout" ? [p(),p(),p()] : [p(),p()];
  const m = { kind, pts, text: "", style: { fill: i % 3 ? null : "#FF0000" } }; ms.push(m);
  out.bbox.push(g.markupBBox(m));
  if (kind === "callout") out.leader.push(g.calloutLeader(m));
  const tests = []; for (let t = 0; t < 30; t++) { const x = rnd()*200, y = rnd()*200; tests.push([x,y,g.hitMarkup(m,x,y,6)]); }
  out.hit.push(tests);
  out.handles.push(g.handlesOf(m));
  const hn = Object.keys(g.handlesOf(m)); const name = hn[i % hn.length];
  { const x = rnd()*200, y = rnd()*200; out.drag.push([name, x, y, g.dragHandle(m.pts, name, x, y, 2.0)]); }
}
for (let i = 0; i < 40; i++) {
  const c = [800 + rnd()*800, 500 + rnd()*500], card = [420 + rnd()*400, 260 + rnd()*200];
  const a = [rnd()*c[0], rnd()*c[1]]; const anchor = [a[0], a[1], a[0] + rnd()*100, a[1] + rnd()*100];
  const avoid = i % 2 ? [[c[0]-151, 0, c[0], c[1]]] : [];
  out.choose.push([c, card, anchor, avoid, g.chooseCardPosition(c, card, anchor, avoid)]);
  out.suit.push([c, g.suitableCardSize(...c)]);
  out.clampsz.push([card[0]*1.7, card[1]*1.9, c[0], c[1], 37, 11, g.clampCardSize(card[0]*1.7, card[1]*1.9, c[0], c[1], 37, 11)]);
  const o = [rnd()*500, rnd()*400, 1 + rnd()*20, 200 + Math.floor(rnd()*300), 150 + Math.floor(rnd()*200)];
  out.origin.push([o, g.cardRegionOrigin(...o)]);
}
out.ms = ms; out.rects = rects;
console.log(JSON.stringify(out));
