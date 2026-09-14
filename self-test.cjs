'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const elements = new Map();
const element = () => ({ value:'', hidden:true, style:{}, addEventListener(){}, appendChild(){}, textContent:'' });
const context = vm.createContext({ console, setTimeout, clearTimeout, document: {
  getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  createElement: element, addEventListener() {},
} });
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
// ブラウザ保存の自動読込のみ止め、実際のアプリ関数・イベント登録を評価する。
vm.runInContext(source.replace(/^loadCachedMaster\(\);$/m, '').replace(/^loadCachedInventory\(\);$/m, ''), context);
context.assert = assert;
vm.runInContext(`
const masters = types => types.map(api_stype => ({api_stype}));
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-12, a+' != '+b);
const target = (types,f) => targetProbabilities(masters(types),f);
for (const f of Object.keys(FORMATION)) {
  for (let n=1;n<=6;n++) for (let mask=0;mask<(1<<n);mask++) {
    const types = Array.from({length:n},(_,i) => mask&(1<<i) ? (i%2 ? 13:14) : 2);
    const p = target(types,f);
    close(p.reduce((a,b)=>a+b,0), types.every(t=>t===13||t===14) ? 0:1);
    p.forEach((x,i) => { assert.ok(Number.isFinite(x)&&x>=0&&x<=1); if(types[i]===13||types[i]===14) assert.equal(x,0); });
  }
  assert.equal(target([2,13,14],f)[0],1);
  assert.equal(target([13,2],f)[1],1);
}
close(target([2,2,13],'lineAhead')[0],0.275);
close(target([2,2,13],'lineAhead')[1],0.725);
close(target([13,2,2,2,2,2],'vanguard')[1],2/25);
close(target([13,2,2,2,2,2],'vanguard')[3],7/25);
close(target([2,2,2,2,2,2],'ring')[0],1/24);
assert.equal(target([], 'lineAhead').length,0);
for (const types of [[8,9,10,8],[11,18,11],[13],[14],[8,9,7,7,18]]) assert.ok(initialRouteAssessment(masters(types)).reasons.length);
for (const types of [[8,9,10,2],[11,18,2],[7,7,7],[20],[22],[8,9,7,18]]) assert.equal(initialRouteAssessment(masters(types)).reasons.length,0);
assert.equal(initialRouteAssessment([undefined]).unknown,true);
state.master = {};
state.shipsById = new Map([[1,{api_stype:13}],[2,{api_stype:2}]]);
state.deck = {f1:{s1:{id:1}},f2:{s1:{id:2}}};
els.fleetSelect.value='f1'; els.inventoryInput.value='[]';
updateReadyState(); assert.equal(els.optimizeBtn.disabled,false);
assert.equal($('routeWarning').hidden,false);
updateRouteWarning('f1','resultRouteWarning'); assert.equal($('resultRouteWarning').hidden,false);
els.fleetSelect.value='f2'; updateFormationAvailability(); assert.equal($('routeWarning').hidden,true);
els.fleetInput.value=''; parseDeckAndPopulate(); assert.equal($('routeWarning').hidden,true); assert.equal(els.optimizeBtn.disabled,true);
// 本物の被ダメ率計算まで通し、潜水艦のゼロ被弾と噴進100%を確認。
const assignments = types => masters(types).map((master,i)=>({shipKey:'s'+(i+1),ship:{master,deck:{id:i+1,lv:99}},config:{all:[],weightedAA:0,fleetBonus:0,barrageRate:null}}));
for(const f of Object.keys(FORMATION)) {
  const a=assignments([13,2,14]); const result=evaluateNoDamage(a,f,0);
  close(result.shipNoHit[0],1); close(result.shipNoHit[2],1); assert.ok(result.shipNoHit[1]<1);
  const allSub=evaluateNoDamage(assignments([13,14]),f,0); close(allSub.fleetNoHit,1); close(allSub.expectedHits,0);
  a[1].config.barrageRate=100; close(evaluateNoDamage(a,f,0).fleetNoHit,1);
}
`, context);
console.log('PASS: 全陣形・1～6隻の全潜水艦配置、分岐境界、警告更新、被ダメ率・噴進100%');
