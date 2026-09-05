'use strict';

// 主要な対空計算式の回帰テスト。依存パッケージなしで実行可能。
function weightedAA(baseAA, equips) {
  const x = baseAA + equips.reduce((s, e) => s + e.mult * e.aa + e.improve * Math.sqrt(e.rf), 0);
  const A = equips.length ? 2 : 1;
  return A * Math.floor(x / A);
}
function barrageRate(luck, weighted, rockets, ise = false) {
  let r = ((0.9 * luck + weighted) / 281) * 100;
  if (rockets >= 2) r += 15;
  if (rockets >= 3) r += 15;
  if (ise) r += 25;
  return r;
}
function fleetBonus(equips) {
  return Math.floor(equips.reduce((s, e) => s + e.fleetMult * e.aa + e.fleetImprove * Math.sqrt(e.rf), 0));
}
function fleetAA(bonusSum, formationFactor) {
  return Math.floor(formationFactor * bonusSum) * (2 / 1.3);
}
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
function assertNear(actual, expected, eps, label) {
  if (Math.abs(actual - expected) > eps) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

// ユーザー確認例: Béarn, 素対空推定32, 運18,
// 噴進砲改二×2 (対空8), Bofors 40mm四連装機関砲★4 (対空11)。
const rocket = { aa: 8, rf: 0, mult: 6, improve: 6, fleetMult: 0.2, fleetImprove: 0 };
const bofors4 = { aa: 11, rf: 4, mult: 6, improve: 6, fleetMult: 0.2, fleetImprove: 0 };
const gear = [rocket, rocket, bofors4];
const wa = weightedAA(32, gear);
assertEq(wa, 206, 'Béarn 加重対空');
assertNear(wa / 4, 51.50, 1e-9, 'Béarn 割合撃墜率(%)');
const br = barrageRate(18, wa, 2);
assertNear(br, 94.07473309608541, 1e-9, 'Béarn 噴進弾幕率');
assertEq(fleetBonus(gear), 5, 'Béarn 艦隊対空ボーナス');
assertNear(fleetAA(18, 1.6), 43.07692307692308, 1e-9, 'Wiki輪形陣例 艦隊防空');

console.log('calculation-selftest: OK');
console.log({ weightedAA: wa, proportionalPercent: wa / 4, barragePercent: br, shipFleetBonus: fleetBonus(gear) });

// 最適化優先順位の回帰テスト: 噴進砲3本・噴進可能艦3隻なら、
// 3本を1隻へ集中して100%にする解より、1本ずつ3隻へ配る解を優先する。
function objectiveTuple(assignments) {
  let covered = 0, hundred = 0, capped = 0;
  for (const x of assignments) {
    if (!x.eligible) continue;
    if (x.rockets > 0) covered++;
    if (x.rate >= 100) hundred++;
    capped += Math.min(100, x.rate);
  }
  return [covered, hundred, capped];
}
function tupleBetter(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
const spread = objectiveTuple([
  {eligible:true, rockets:1, rate:60},
  {eligible:true, rockets:1, rate:70},
  {eligible:true, rockets:1, rate:80},
]);
const concentrate = objectiveTuple([
  {eligible:true, rockets:3, rate:100},
  {eligible:true, rockets:0, rate:0},
  {eligible:true, rockets:0, rate:0},
]);
if (!tupleBetter(spread, concentrate)) throw new Error('噴進砲1本ずつ配布の優先順位テスト失敗');
console.log('rocket-distribution-priority: OK', { spread, concentrate });
