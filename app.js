'use strict';

const MASTER_SOURCE_URL = 'https://api.kcwiki.moe/start2';
const MASTER_CACHE_DB = 'kancolle-521-optimizer';
const MASTER_CACHE_STORE = 'settings';
const MASTER_CACHE_KEY = 'start2-master-v1';
const INVENTORY_CACHE_KEY = 'inventory-json-v1';
const ROCKET_ID = 274;
const BARRAGE_STYPES = new Set([6, 7, 10, 11, 16, 18]);
const FORMATION = {
  lineAhead: { name: '単縦陣', factor: 1.0 },
  doubleLine: { name: '複縦陣', factor: 1.2 },
  ring: { name: '輪形陣', factor: 1.6 },
  vanguard: { name: '警戒陣', factor: 1.1 },
};
const ICON = { RADAR: 11, AA_SHELL: 12, MACHINE_GUN: 15, HIGH_ANGLE: 16, AA_DIRECTOR: 30 };
const EQUIP_TYPE = { RADAR_SMALL: 12, RADAR_LARGE: 13, AA_SHELL: 18, MACHINE_GUN: 21, AA_DIRECTOR: 36 };
const TYPE46CM_TRIPLE_ID = 9;
const MAX_SHIP_CONFIGS = 1600;
const MAX_GLOBAL_STATES = 24000;
const MAX_REGULAR_CANDIDATES = 64;
const MAX_EX_CANDIDATES = 40;
// 5-2-Cは制空権喪失固定。航空機は最適化候補から除外する。
const AIRCRAFT_EQUIP_TYPES = new Set([6,7,8,9,10,11,25,26,41,45,46,47,48,49,56,57,58,59,94]);
// 制空権喪失時の敵Stage1損耗を4分岐で近似（現仕様で固定）。
const AIR_DENIAL_STAGE1_LOSS_RATES = [0, 0.035, 0.065, 0.10];
// 5-2-C。出現率はユーザー指定どおり各1/3。艦戦スロットは攻撃しないため除外。
const ENEMY_521_PATTERNS = [
  { key:'P1', name:'白ヲ×1', slots:[32,27,5] },
  { key:'P2', name:'白ヲ＋通常ヲ', slots:[32,27,5,32,32] },
  { key:'P3', name:'白ヲ×2', slots:[32,27,5,32,27,5] },
];
const COVER_RATE = { lineAhead:0.45, doubleLine:0.60, ring:0.75, vanguard:0.75 };
const FINAL_METRIC_CACHE = new WeakMap();

const state = {
  master: null,
  shipsById: new Map(),
  itemsById: new Map(),
  stypesById: new Map(),
  equipShipById: new Map(),
  exslotItemRules: new Map(),
  exslotCommonTypes: new Set(),
  classIds: {},
  masterSource: null,
  deck: null,
  selectedFleetKey: null,
  lastOptimizedDeck: null,
  formationResults: null,
  activeFormationKey: null,
  recommendedFormationKey: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  masterStatus: $('masterStatus'), fleetInput: $('fleetInput'), inventoryInput: $('inventoryInput'),
  fleetSelect: $('fleetSelect'), optimizeBtn: $('optimizeBtn'), message: $('message'),
  masterInput: $('masterInput'), loadMasterBtn: $('loadMasterBtn'), openMasterBtn: $('openMasterBtn'),
  clipboardMasterBtn: $('clipboardMasterBtn'), clearMasterBtn: $('clearMasterBtn'), masterSavedAt: $('masterSavedAt'),
  inventorySavedAt: $('inventorySavedAt'), clearInventoryBtn: $('clearInventoryBtn'),
  resultSection: $('resultSection'), resultTitle: $('resultTitle'), summary: $('summary'), shipResults: $('shipResults'), copyDeckBtn: $('copyDeckBtn'),
  formationTabs: $('formationTabs'), formationPlan: $('formationPlan'),
};

function showMessage(text, isError = true) {
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.style.background = isError ? '#fff7ed' : '#ecfdf3';
  els.message.style.color = isError ? '#9a3412' : '#166534';
}

function setMasterStatus(text, kind) {
  els.masterStatus.textContent = text;
  els.masterStatus.className = `status ${kind}`;
}

function parseJson(text, label) {
  try { return JSON.parse(text.trim()); }
  catch (e) { throw new Error(`${label}のJSONを解析できません: ${e.message}`); }
}

function toIdSet(value) {
  if (value == null) return new Set();
  if (Array.isArray(value)) return new Set(value.map(Number));
  if (typeof value === 'object') {
    return new Set(Object.entries(value).filter(([,v]) => Boolean(v) || v === null).map(([k]) => Number(k)));
  }
  return new Set([Number(value)]);
}

function indexEquipShip(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const id = Number(x?.api_ship_id ?? x?.api_id);
      if (Number.isFinite(id)) map.set(id, x);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k,v] of Object.entries(raw)) {
      const id = Number(v?.api_ship_id ?? k);
      if (Number.isFinite(id)) map.set(id, v);
    }
  }
  return map;
}

function indexExslotRules(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const id = Number(x?.api_slotitem_id ?? x?.api_id);
      if (!Number.isFinite(id)) continue;
      const old = map.get(id);
      if (!old) map.set(id, x);
      else if (Array.isArray(old)) old.push(x);
      else map.set(id, [old, x]);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k,v] of Object.entries(raw)) {
      const id = Number(v?.api_slotitem_id ?? k);
      if (Number.isFinite(id)) map.set(id, v);
    }
  }
  return map;
}

function normalizeMaster(raw, sourceLabel = 'ローカル') {
  const data = raw?.api_data ?? raw;
  if (!data?.api_mst_ship || !data?.api_mst_slotitem || !data?.api_mst_stype) {
    throw new Error('Start2マスターデータとして必要な項目が見つかりません。');
  }
  state.master = data;
  state.masterSource = sourceLabel;
  state.shipsById = new Map(data.api_mst_ship.map(x => [Number(x.api_id), x]));
  state.itemsById = new Map(data.api_mst_slotitem.map(x => [Number(x.api_id), x]));
  state.stypesById = new Map(data.api_mst_stype.map(x => [Number(x.api_id), x]));
  state.equipShipById = indexEquipShip(data.api_mst_equip_ship);
  state.exslotItemRules = indexExslotRules(data.api_mst_equip_exslot_ship);
  state.exslotCommonTypes = toIdSet(data.api_mst_equip_exslot);
  const findCtype = (names) => {
    for (const name of names) {
      const hit = data.api_mst_ship.find(x => String(x.api_name || '') === name || String(x.api_name || '').startsWith(name));
      if (hit) return Number(hit.api_ctype);
    }
    return null;
  };
  state.classIds = {
    akizuki: findCtype(['秋月']),
    atlanta: findCtype(['Atlanta']),
    fletcher: findCtype(['Fletcher']),
  };
  setMasterStatus(`マスター準備完了（艦${state.shipsById.size} / 装備${state.itemsById.size}）`, 'ok');
  updateReadyState();
}

function openMasterDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('このブラウザではIndexedDBを利用できません。'));
      return;
    }
    const req = indexedDB.open(MASTER_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MASTER_CACHE_STORE)) db.createObjectStore(MASTER_CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした。'));
  });
}

async function idbGet(key) {
  const db = await openMasterDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MASTER_CACHE_STORE, 'readonly');
      const req = tx.objectStore(MASTER_CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('キャッシュを読み込めませんでした。'));
    });
  } finally { db.close(); }
}

async function idbSet(key, value) {
  const db = await openMasterDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MASTER_CACHE_STORE, 'readwrite');
      tx.objectStore(MASTER_CACHE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('キャッシュを保存できませんでした。'));
      tx.onabort = () => reject(tx.error || new Error('キャッシュ保存が中断されました。'));
    });
  } finally { db.close(); }
}

async function idbDelete(key) {
  const db = await openMasterDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MASTER_CACHE_STORE, 'readwrite');
      tx.objectStore(MASTER_CACHE_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('キャッシュを削除できませんでした。'));
    });
  } finally { db.close(); }
}

function formatSavedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

function updateMasterSavedAt(iso) {
  if (!els.masterSavedAt) return;
  els.masterSavedAt.textContent = iso ? `ブラウザ保存: ${formatSavedAt(iso)}` : 'ブラウザ保存: なし';
}

function updateInventorySavedAt(iso, text = null) {
  if (!els.inventorySavedAt) return;
  if (!iso) {
    els.inventorySavedAt.textContent = '所持装備のブラウザ保存: なし';
    return;
  }
  let countText = '';
  if (text) {
    try {
      const raw = JSON.parse(text);
      if (Array.isArray(raw)) countText = ` / ${raw.length}件`;
    } catch {}
  }
  els.inventorySavedAt.textContent = `所持装備をブラウザ保存済み: ${formatSavedAt(iso)}${countText}`;
}

async function saveInventoryToBrowser(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const raw = parseJson(trimmed, '所持装備');
  if (!Array.isArray(raw)) throw new Error('所持装備データはJSON配列である必要があります。');
  if (raw.length && !raw.some(x => x && Number.isFinite(Number(x.api_slotitem_id)))) {
    throw new Error('所持装備JSONとして認識できません。');
  }
  const savedAt = new Date().toISOString();
  await idbSet(INVENTORY_CACHE_KEY, { text: trimmed, savedAt });
  updateInventorySavedAt(savedAt, trimmed);
  return true;
}

async function loadCachedInventory() {
  try {
    const cached = await idbGet(INVENTORY_CACHE_KEY);
    if (!cached?.text) {
      updateInventorySavedAt(null);
      return;
    }
    // ユーザーがページ読込直後に入力していた場合は上書きしない。
    if (!els.inventoryInput.value.trim()) els.inventoryInput.value = cached.text;
    updateInventorySavedAt(cached.savedAt, cached.text);
    updateReadyState();
  } catch (e) {
    console.error(e);
    updateInventorySavedAt(null);
  }
}

async function saveMasterToBrowser(raw) {
  const savedAt = new Date().toISOString();
  await idbSet(MASTER_CACHE_KEY, { raw, savedAt, source: MASTER_SOURCE_URL });
  updateMasterSavedAt(savedAt);
}

async function loadCachedMaster() {
  setMasterStatus('マスターデータ確認中…', 'pending');
  try {
    const cached = await idbGet(MASTER_CACHE_KEY);
    if (!cached?.raw) {
      setMasterStatus('マスターデータ未設定', 'pending');
      updateMasterSavedAt(null);
      showMessage('初回だけ「マスターJSONを開く」→ Ctrl+A / Ctrl+C →「クリップボードから読み込む」を行ってください。取得したJSONはこのブラウザ内だけに保存されます。', false);
      return;
    }
    normalizeMaster(cached.raw, 'ブラウザ保存');
    updateMasterSavedAt(cached.savedAt);
  } catch (e) {
    console.error(e);
    setMasterStatus('マスターデータ未設定', 'pending');
    updateMasterSavedAt(null);
    showMessage(`ブラウザ保存済みマスターを読み込めませんでした。再設定してください。
${e.message}`);
  }
}

async function importMasterRaw(raw, sourceLabel) {
  normalizeMaster(raw, sourceLabel);
  await saveMasterToBrowser(raw);
  showMessage('マスターデータを読み込み、このブラウザ内に保存しました。次回から再設定は不要です。', false);
}

async function importMasterText(text, sourceLabel) {
  if (!String(text || '').trim()) throw new Error('マスターJSONが空です。');
  const raw = parseJson(text, 'マスターデータ');
  await importMasterRaw(raw, sourceLabel);
}

function fleetShipCount(fleet) {
  if (!fleet) return 0;
  return Object.keys(fleet).filter(k => /^s[1-7]$/.test(k) && fleet[k] && Number(fleet[k].id) > 0).length;
}

function formationKeysForShipCount(n) {
  if (n <= 3) return ['lineAhead'];
  if (n === 4) return ['lineAhead', 'doubleLine', 'vanguard'];
  return ['lineAhead', 'doubleLine', 'ring', 'vanguard'];
}

function recommendableFormationKeys(n) {
  // 警戒陣も含め、純粋に5-2-Cでの推定無被弾率が最も高い陣形を推奨する。
  // 警戒陣はイベント期間限定であることだけ結果画面に併記する。
  return formationKeysForShipCount(n);
}

function updateFormationAvailability() {
  const fleetKey = els.fleetSelect.value || state.selectedFleetKey;
  const n = state.deck && fleetKey ? fleetShipCount(state.deck[fleetKey]) : 0;
  if (!els.formationPlan) return;
  if (!n) { els.formationPlan.textContent = '自動比較'; return; }
  const names = formationKeysForShipCount(n).map(k => FORMATION[k].name);
  els.formationPlan.textContent = names.length === 1 ? names[0] : `${names.length}陣形を自動比較`;
}

function parseDeckAndPopulate() {
  if (!els.fleetInput.value.trim()) return;
  try {
    state.deck = parseJson(els.fleetInput.value, '編成');
    const fleets = Object.keys(state.deck).filter(k => /^f[1-4]$/.test(k) && state.deck[k]);
    if (!fleets.length) throw new Error('f1～f4の艦隊データがありません。');
    els.fleetSelect.innerHTML = '';
    fleets.forEach(k => {
      const no = Number(k.slice(1));
      const f = state.deck[k];
      const opt = document.createElement('option');
      opt.value = k;
      const ships = fleetShipCount(f);
      opt.textContent = `第${no}艦隊：${f.name || '(名称なし)'}（${ships}隻）`;
      els.fleetSelect.appendChild(opt);
    });
    state.selectedFleetKey = fleets[0];
    els.fleetSelect.disabled = false;
    updateFormationAvailability();
    showMessage('', false);
    updateReadyState();
  } catch (e) {
    state.deck = null;
    els.fleetSelect.disabled = true;
    showMessage(e.message);
    updateReadyState();
  }
}

function updateReadyState() {
  els.optimizeBtn.disabled = !(state.master && state.deck && els.inventoryInput.value.trim());
}

function itemIcon(item) { return Number(item?.api_type?.[3] ?? -1); }
function itemEquipType(item) { return Number(item?.api_type?.[2] ?? -1); }
function itemAA(item) { return Number(item?.api_tyku ?? 0); }
function itemEvasion(item) { return Number(item?.api_houk ?? 0); }
function isMachineGun(item) { return itemEquipType(item) === EQUIP_TYPE.MACHINE_GUN || itemIcon(item) === ICON.MACHINE_GUN; }
function isHighAngleGun(item) { return itemIcon(item) === ICON.HIGH_ANGLE; }
function isAADirector(item) { return itemEquipType(item) === EQUIP_TYPE.AA_DIRECTOR || itemIcon(item) === ICON.AA_DIRECTOR; }
function isRadar(item) {
  const t = itemEquipType(item);
  return t === EQUIP_TYPE.RADAR_SMALL || t === EQUIP_TYPE.RADAR_LARGE || itemIcon(item) === ICON.RADAR;
}
function isAAShell(item) { return itemEquipType(item) === EQUIP_TYPE.AA_SHELL || itemIcon(item) === ICON.AA_SHELL; }
function isAircraft(item) { return AIRCRAFT_EQUIP_TYPES.has(itemEquipType(item)); }
function isAARadar(item) { return isRadar(item) && itemAA(item) >= 2; }
function itemNameText(item) { return String(item?.api_name || ''); }
function isSpecialHighAngle(item) { return isHighAngleGun(item) && /高射装置/.test(itemNameText(item)); }
function isSpecialMachineGun(item) { return isMachineGun(item) && itemAA(item) >= 9; }
function isAtlantaGFCSGun(item) { return /GFCSMk\.37[＋+]5inch連装両用砲\(集中配備\)/.test(itemNameText(item).replace(/\s/g,'')); }
function isAtlantaGun(item) { return /5inch連装両用砲\(集中配備\)/.test(itemNameText(item).replace(/\s/g,'')); }
function isGFCS37(item) { return itemNameText(item).replace(/\s/g,'') === 'GFCSMk.37'; }
function isFletcherGFCSGun(item) { return /5inch単装砲Mk\.30改[＋+]GFCSMk\.37/.test(itemNameText(item).replace(/\s/g,'')); }
function isFletcherGun(item) { return /5inch単装砲Mk\.30/.test(itemNameText(item).replace(/\s/g,'')); }
function isAkizukiImprovedGun(item) { return /10cm連装高角砲改[＋+]高射装置改/.test(itemNameText(item).replace(/\s/g,'')); }
function sameClass(shipMaster, key) { const id = state.classIds[key]; return id != null && Number(shipMaster?.api_ctype) === id; }
function isAtlantaAaciShip(shipMaster) {
  const name = String(shipMaster?.api_name || '');
  // RenoはAtlanta級。Start2側のctype差異があっても専用CIを落とさないため艦名でも補完する。
  return sameClass(shipMaster, 'atlanta') || /^(Atlanta|Reno)(改)?/.test(name);
}

// Wiki「対空砲火」の装備倍率・改修係数。装備ボーナス(対空)は別項。
function weightedEquipContribution(item, rf) {
  const aa = itemAA(item);
  let mult = 0, improve = 0;
  if (isMachineGun(item)) { mult = 6; improve = aa >= 8 ? 6 : 4; }
  else if (isHighAngleGun(item)) { mult = 4; improve = aa >= 8 ? 3 : 2; }
  else if (isAADirector(item)) { mult = 4; improve = 2; }
  else if (isRadar(item)) { mult = 3; }
  return mult * aa + improve * Math.sqrt(rf || 0);
}

// Wiki「対空砲火」の艦隊防空用 装備倍率・改修係数。
function fleetEquipContribution(item, rf) {
  const aa = itemAA(item);
  let mult = 0.2, improve = 0;
  if (isAAShell(item)) mult = 0.6;
  else if (isRadar(item)) { mult = 0.4; improve = 1.5; }
  else if (isHighAngleGun(item)) { mult = 0.35; improve = aa >= 8 ? 3 : 2; }
  else if (isAADirector(item)) { mult = 0.35; improve = 2; }
  else if (Number(item.api_id) === TYPE46CM_TRIPLE_ID) mult = 0.25;
  return mult * aa + improve * Math.sqrt(rf || 0);
}

// 5-2-1最適化で実際に評価値へ寄与する装備だけを探索対象にする。
// 単純な「対空>0」だけにすると、回避装備や改修で対空砲火へ寄与する装備、
// 対空CIの構成要素を落とす可能性があるため、現在の評価モデルに対する寄与で判定する。
function isSupportedAaciComponent(item) {
  return isHighAngleGun(item)
    || isAADirector(item)
    || isAARadar(item)
    || (isMachineGun(item) && itemAA(item) >= 3);
}

function isAntiAirRelevant(item, rf = 0) {
  if (isAircraft(item)) return false;
  if (Number(item.api_id) === ROCKET_ID) return true;
  if (itemEvasion(item) > 0) return true;
  if (weightedEquipContribution(item, rf) > 0) return true;
  if (fleetEquipContribution(item, rf) > 0) return true;
  if (isSupportedAaciComponent(item)) return true;
  return false;
}

function shipSlotCount(shipMaster, shipDeck) {
  const n = Number(shipMaster?.api_slot_num ?? 0);
  if (n > 0) return n;
  const keys = Object.keys(shipDeck?.items || {}).filter(k => /^i\d+$/.test(k));
  return Math.max(1, ...keys.map(k => Number(k.slice(1))));
}

function shipStype(shipMaster) { return Number(shipMaster?.api_stype ?? -1); }
function barrageEligible(shipMaster) { return BARRAGE_STYPES.has(shipStype(shipMaster)); }
function isIseClass(shipMaster) { return /^(伊勢|日向)/.test(shipMaster?.api_name || ''); }

function equipRuleAllows(rule, itemId) {
  if (rule === null || rule === undefined) return rule === null;
  if (Array.isArray(rule)) return rule.includes(Number(itemId));
  return Boolean(rule);
}

function canEquipRegular(shipMaster, item) {
  const typeId = itemEquipType(item);
  const special = state.equipShipById.get(Number(shipMaster.api_id))?.api_equip_type;
  if (special) {
    if (!(String(typeId) in special)) return false;
    return equipRuleAllows(special[String(typeId)], item.api_id);
  }
  const st = state.stypesById.get(shipStype(shipMaster));
  const rules = st?.api_equip_type;
  if (!rules) return true; // API差異時のフォールバック
  const value = rules[String(typeId)];
  return value === 1 || value === true || value === null;
}

function valueHasId(value, id) {
  if (value == null) return false;
  const n = Number(id);
  if (Array.isArray(value)) return value.map(Number).includes(n);
  if (typeof value === 'object') {
    if (String(n) in value) return value[String(n)] !== false && value[String(n)] !== 0;
    return Object.values(value).map(Number).includes(n);
  }
  return Number(value) === n;
}

function conditionMapMatches(cond, shipMaster, shipDeck) {
  if (!cond) return false;
  if (Array.isArray(cond)) return cond.some(x => conditionMapMatches(x, shipMaster, shipDeck));
  const reqLv = Number(cond.api_req_level || 0);
  if (Number(shipDeck?.lv || 0) < reqLv) return false;
  if (valueHasId(cond.api_ship_ids, shipMaster.api_id)) return true;
  if (valueHasId(cond.api_stypes, shipMaster.api_stype)) return true;
  if (valueHasId(cond.api_ctypes, shipMaster.api_ctype)) return true;
  // 条件フィールドが無い形式は対象装備そのものが許可を表す。
  const hasTarget = cond.api_ship_ids != null || cond.api_stypes != null || cond.api_ctypes != null;
  return !hasTarget;
}

function canEquipEx(shipMaster, shipDeck, item) {
  const typeId = itemEquipType(item);
  if (state.exslotCommonTypes.has(typeId) && canEquipRegular(shipMaster, item)) return true;
  const cond = state.exslotItemRules.get(Number(item.api_id));
  if (conditionMapMatches(cond, shipMaster, shipDeck)) return true;
  return false;
}

function buildInventory(raw) {
  if (!Array.isArray(raw)) throw new Error('所持装備データはJSON配列である必要があります。');
  const groups = new Map();
  raw.forEach((x, idx) => {
    const id = Number(x.api_slotitem_id), rf = Number(x.api_level || 0);
    if (!Number.isFinite(id)) throw new Error(`所持装備 ${idx + 1}件目にapi_slotitem_idがありません。`);
    const master = state.itemsById.get(id);
    if (!master || !isAntiAirRelevant(master, rf)) return;
    const key = `${id}:${rf}`;
    const g = groups.get(key) || { key, id, rf, count: 0, master };
    g.count++;
    groups.set(key, g);
  });
  return [...groups.values()];
}

function originalDeckEquipment(shipDeck) {
  return Object.entries(shipDeck?.items || {})
    .filter(([k, v]) => (/^i\d+$/.test(k) || k === 'ix') && v && Number(v.id) > 0)
    .map(([, v]) => ({ id: Number(v.id), rf: Number(v.rf || 0), master: state.itemsById.get(Number(v.id)) }))
    .filter(x => x.master);
}

// 74式のDeckBuilderの aa は装備込みの表示対空値。
// 最適化後の装備で加重対空を再計算するには、まずコピー時点の装備素対空を引いて素対空を復元する。
// 装備ボーナス(対空)が付く元装備では、その分だけ推定誤差が残るためUI/READMEで明示する。
function estimateBaseAA(shipDeck) {
  const displayedAA = Number(shipDeck?.aa || 0);
  const originalEquipmentAA = originalDeckEquipment(shipDeck).reduce((sum, x) => sum + itemAA(x.master), 0);
  return Math.max(0, displayedAA - originalEquipmentAA);
}

// DeckBuilderのevも現在装備込みとして扱い、元装備の回避値を引いて素回避を推定する。
function estimateBaseEvasion(shipDeck) {
  const displayed = Number(shipDeck?.ev || 0);
  const original = originalDeckEquipment(shipDeck).reduce((sum, x) => sum + itemEvasion(x.master), 0);
  return Math.max(0, displayed - original);
}

function cappedBaseEvasion(v) {
  if (v < 40) return Math.floor(v);
  if (v < 65) return Math.floor(40 + 3 * Math.sqrt(v - 40));
  return Math.floor(55 + 2 * Math.sqrt(v - 65));
}

function calcAirEvasionTerm(shipDeck, selectedGroups) {
  const raw = Math.floor(estimateBaseEvasion(shipDeck)
    + selectedGroups.reduce((s,g) => s + itemEvasion(g.master), 0)
    + Math.sqrt(2 * Number(shipDeck?.luck || 0)));
  return cappedBaseEvasion(raw); // 燃料ペナルティなし、航空戦陣形補正1.0
}

function calcAirHitRate(shipDeck, selectedGroups, isFlagship) {
  const evasion = calcAirEvasionTerm(shipDeck, selectedGroups);
  const fatigue = isFlagship ? 1.0 : 1.4; // 旗艦cond49 / 随伴cond0
  const preFatigue = Math.max(10, 95 - evasion);
  const capped = Math.min(96, preFatigue * fatigue);
  return Math.min(1, (Math.floor(capped) + 1) / 100);
}

function countGroups(groups, pred) { return groups.reduce((n,g) => n + (pred(g.master) ? 1 : 0), 0); }

function localAaciCandidates(shipDeck, shipMaster, groups) {
  return detectAaciForAssignment({ ship:{ deck:shipDeck, master:shipMaster }, config:{ all:groups } }, 0);
}
function localAaciScore(shipDeck, shipMaster, groups) {
  const cis = localAaciCandidates(shipDeck, shipMaster, groups);
  if (!cis.length) return 0;
  return Math.max(...cis.map(ci => ci.rate * (ci.fixed * 4 + ci.variable * 10)));
}

// v1で扱う主要対空CI。単体発動率はWikiの検証推定値。
function detectAaciForAssignment(a, shipIndex) {
  const m = a.ship.master, groups = a.config.all;
  const cis = [];
  const add = (type, rate, variable, fixed, priority, label) => cis.push({ type, rate, variable, fixed, priority, shipIndex, label });
  const high = countGroups(groups, isHighAngleGun);
  const specialHigh = countGroups(groups, isSpecialHighAngle);
  const director = countGroups(groups, isAADirector);
  const aaRadar = countGroups(groups, isAARadar);
  const mg3 = countGroups(groups, x => isMachineGun(x) && itemAA(x) >= 3);
  const mg9 = countGroups(groups, x => isMachineGun(x) && itemAA(x) >= 9);

  if (isAtlantaAaciShip(m)) {
    const gfcsGun = countGroups(groups, isAtlantaGFCSGun);
    const atlGun = countGroups(groups, isAtlantaGun);
    const plainAtlGun = Math.max(0, atlGun - gfcsGun);
    const gfcs = countGroups(groups, isGFCS37);
    if (gfcsGun >= 2) add(38, .594, 1.85, 10, 1, 'Atlanta 38');
    if (gfcsGun >= 1 && plainAtlGun >= 1) add(39, .550, 1.70, 10, 2, 'Atlanta 39');
    if (atlGun >= 2 && gfcs >= 1) add(40, .550, 1.70, 10, 3, 'Atlanta 40');
    if (atlGun >= 2) add(41, .594, 1.65, 9, 5, 'Atlanta 41');
  }

  if (/^摩耶改二/.test(String(m.api_name || ''))) {
    if (high >= 1 && mg9 >= 1 && aaRadar >= 1) add(10, .594, 1.65, 8, 6, '摩耶 10');
    if (high >= 1 && mg9 >= 1) add(11, .544, 1.50, 6, 9, '摩耶 11');
  }

  if (sameClass(m, 'akizuki')) {
    const improved = countGroups(groups, isAkizukiImprovedGun);
    if (improved >= 2 && aaRadar >= 1) add(48, .643, 1.75, 8, 11, '秋月型 48');
    if (high >= 2 && (aaRadar >= 1 || countGroups(groups, isRadar) >= 1)) add(1, .643, 1.70, 7, 12, '秋月型 1');
    if (high >= 1 && countGroups(groups, isRadar) >= 1) add(2, .574, 1.70, 6, 17, '秋月型 2');
    if (high >= 2) add(3, .495, 1.60, 4, 27, '秋月型 3');
  }

  if (sameClass(m, 'fletcher')) {
    const gfcsF = countGroups(groups, isFletcherGFCSGun);
    const fgun = countGroups(groups, isFletcherGun);
    const mk30kai = countGroups(groups, x => /5inch単装砲Mk\.30改/.test(itemNameText(x).replace(/\s/g,'')) && !isFletcherGFCSGun(x));
    if (gfcsF >= 2) add(34, .594, 1.60, 7, 13, 'Fletcher 34');
    if (gfcsF >= 1 && fgun - gfcsF >= 1) add(35, .544, 1.55, 6, 18, 'Fletcher 35');
    if (fgun >= 2 && countGroups(groups, isGFCS37) >= 1) add(36, .495, 1.55, 6, 19, 'Fletcher 36');
    if (mk30kai >= 2) add(37, .396, 1.45, 4, 31, 'Fletcher 37');
  }

  // 秋月型では汎用5/8/7は発動しないため除外。9は全艦で可。
  if (!sameClass(m, 'akizuki')) {
    if (specialHigh >= 2 && aaRadar >= 1) add(5, .500, 1.50, 4, 30, '汎用 5');
    if (specialHigh >= 1 && aaRadar >= 1) add(8, .495, 1.40, 4, 34, '汎用 8');
    if (high >= 1 && director >= 1 && aaRadar >= 1) add(7, .445, 1.35, 3, 37, '汎用 7');
  }
  if (high >= 1 && director >= 1) add(9, .396, 1.30, 2, 47, '汎用 9');
  if (mg9 >= 1 && mg3 >= 2 && aaRadar >= 1) add(12, .445, 1.25, 3, 41, '汎用 12');
  return cis;
}

function aaciOutcomeDistribution(assignments) {
  const list = [];
  assignments.forEach((a,i) => list.push(...detectAaciForAssignment(a,i)));
  list.sort((a,b) => a.priority - b.priority || a.shipIndex - b.shipIndex || a.type - b.type);
  const outcomes = [];
  let remaining = 1;
  for (const ci of list) {
    const p = remaining * ci.rate;
    if (p > 1e-12) outcomes.push({ prob:p, variable:ci.variable, fixed:ci.fixed, label:ci.label, type:ci.type });
    remaining *= (1 - ci.rate);
  }
  if (remaining > 1e-12) outcomes.push({ prob:remaining, variable:1, fixed:0, label:'不発', type:0 });
  return outcomes;
}

function barrageOutcomeDistribution(assignments) {
  let states = [{ prob:1, active:new Set() }];
  assignments.forEach((a,i) => {
    const r = a.config.barrageRate;
    if (r == null || r <= 0) return;
    const p = Math.min(1, Math.max(0, r / 100));
    if (p >= 1) {
      states.forEach(s => s.active.add(i));
      return;
    }
    const next = [];
    for (const s of states) {
      next.push({ prob:s.prob*(1-p), active:new Set(s.active) });
      const on = new Set(s.active); on.add(i);
      next.push({ prob:s.prob*p, active:on });
    }
    states = next;
  });
  return states;
}

function targetProbabilities(n, formationKey) {
  if (n <= 0) return [];
  let raw = new Array(n).fill(1);
  if (formationKey === 'vanguard' && n >= 4) {
    const mainCount = n >= 6 ? 3 : 2;
    raw = raw.map((_,i) => i < mainCount ? 1 : 3); // 警戒艦へ約3倍集中の近似
  }
  const total = raw.reduce((a,b)=>a+b,0);
  raw = raw.map(x => x/total);
  const cover = COVER_RATE[formationKey] || 0;
  if (n <= 1 || cover <= 0) return raw;
  const out = [...raw];
  const flagRaw = raw[0];
  out[0] = flagRaw * (1-cover);
  for (let i=1;i<n;i++) out[i] += flagRaw * cover / (n-1);
  return out;
}

function stage2SurvivalProbability(slotCount, assignments, fleetAA, ci) {
  if (slotCount <= 0) return 0;
  let survive = 0;
  const n = assignments.length;
  for (const a of assignments) {
    const weighted = a.config.weightedAA;
    const proportional = Math.floor((weighted / 400) * slotCount);
    const fixed = Math.floor(((weighted + fleetAA) * ci.variable) / 10);
    const guarantee = 1 + ci.fixed;
    let local = 0;
    for (const propSuccess of [0,1]) for (const fixedSuccess of [0,1]) {
      let remain = slotCount;
      if (propSuccess) remain -= proportional;
      if (fixedSuccess) remain -= fixed;
      remain -= guarantee;
      if (remain > 0) local += 0.25;
    }
    survive += local / n;
  }
  return survive;
}

function slotSurvivalProbability(initialSlot, assignments, fleetAA, ci) {
  let p = 0;
  for (const lossRate of AIR_DENIAL_STAGE1_LOSS_RATES) {
    const lost = Math.floor(initialSlot * lossRate);
    const after1 = Math.max(0, initialSlot - lost);
    p += 0.25 * stage2SurvivalProbability(after1, assignments, fleetAA, ci);
  }
  return p;
}

function evaluateNoDamage(assignments, formationKey, fleetAA) {
  const n = assignments.length;
  const targetP = targetProbabilities(n, formationKey);
  const hitP = assignments.map((a,i) => calcAirHitRate(a.ship.deck, a.config.all, i === 0));
  const ciOutcomes = aaciOutcomeDistribution(assignments);
  const barrageOutcomes = barrageOutcomeDistribution(assignments);
  let fleetNoHit = 0, expectedHitShips = 0, expectedHits = 0, flagNoHit = 0, allSlotsDead = 0;
  const shipNoHit = new Array(n).fill(0);
  const patternDetails = [];

  for (const pattern of ENEMY_521_PATTERNS) {
    let pNoHitPattern = 0, pDeadPattern = 0, hitsPattern = 0, hitShipsPattern = 0, flagNoHitPattern = 0;
    const shipNoHitPattern = new Array(n).fill(0);
    for (const ci of ciOutcomes) {
      const slotSurvive = pattern.slots.map(s => slotSurvivalProbability(s, assignments, fleetAA, ci));
      const deadAllGivenCi = slotSurvive.reduce((prod,p)=>prod*(1-p),1);
      pDeadPattern += ci.prob * deadAllGivenCi;
      for (const barr of barrageOutcomes) {
        const branch = ci.prob * barr.prob;
        if (branch <= 0) continue;
        const vulnerableHit = assignments.map((a,i) => barr.active.has(i) ? 0 : targetP[i] * hitP[i]);
        const anyTargetHit = vulnerableHit.reduce((x,y)=>x+y,0);
        let noHit = 1;
        let expHits = 0;
        for (const survive of slotSurvive) {
          noHit *= (1 - survive * anyTargetHit);
          expHits += survive * anyTargetHit;
        }
        pNoHitPattern += branch * noHit;
        hitsPattern += branch * expHits;

        let expHitShips = 0;
        for (let i=0;i<n;i++) {
          let shipNoHit = 1;
          const q = vulnerableHit[i];
          for (const survive of slotSurvive) shipNoHit *= (1 - survive * q);
          expHitShips += 1 - shipNoHit;
          shipNoHitPattern[i] += branch * shipNoHit;
          if (i === 0) flagNoHitPattern += branch * shipNoHit;
        }
        hitShipsPattern += branch * expHitShips;
      }
    }
    patternDetails.push({ key:pattern.key, name:pattern.name, noHit:pNoHitPattern, allDead:pDeadPattern });
    fleetNoHit += pNoHitPattern / 3;
    allSlotsDead += pDeadPattern / 3;
    expectedHits += hitsPattern / 3;
    expectedHitShips += hitShipsPattern / 3;
    flagNoHit += flagNoHitPattern / 3;
    for (let i=0;i<n;i++) shipNoHit[i] += shipNoHitPattern[i] / 3;
  }
  return { fleetNoHit, expectedHitShips, expectedHits, flagNoHit, allSlotsDead, shipNoHit, patternDetails, ciOutcomes, targetP, hitP };
}

function calcWeightedAA(shipDeck, selectedGroups, equipmentBonusAA = 0) {
  const baseAA = estimateBaseAA(shipDeck);
  const x = baseAA
    + selectedGroups.reduce((s,g) => s + weightedEquipContribution(g.master, g.rf), 0)
    + 0.75 * equipmentBonusAA;
  // A は「装備数0なら1、1個以上なら2」。最適化後に実際に積む装備で判定する。
  const A = selectedGroups.length > 0 ? 2 : 1;
  return A * Math.floor(x / A);
}

function calcShipFleetBonus(selectedGroups, equipmentBonusAA = 0) {
  const raw = selectedGroups.reduce((s,g) => s + fleetEquipContribution(g.master, g.rf), 0)
    + 0.5 * equipmentBonusAA;
  return Math.floor(raw);
}

function calcBarrageRate(shipDeck, shipMaster, selectedGroups) {
  if (!barrageEligible(shipMaster)) return null;
  const rockets = selectedGroups.filter(g => g.id === ROCKET_ID).length;
  if (!rockets) return 0;
  const weighted = calcWeightedAA(shipDeck, selectedGroups);
  let rate = ((0.9 * Number(shipDeck.luck || 0) + weighted) / 281) * 100;
  if (rockets >= 2) rate += 15;
  if (rockets >= 3) rate += 15; // Wiki記載の「3積み +30%程度」を採用
  if (isIseClass(shipMaster)) rate += 25;
  return rate;
}

function localConfigScore(shipDeck, shipMaster, groups) {
  const rate = calcBarrageRate(shipDeck, shipMaster, groups);
  const capped = rate == null ? 0 : Math.min(100, rate);
  const hundred = rate != null && rate >= 100 ? 1 : 0;
  const fb = calcShipFleetBonus(groups);
  const wa = calcWeightedAA(shipDeck, groups);
  const ev = groups.reduce((sum,g) => sum + itemEvasion(g.master), 0);
  const ci = localAaciScore(shipDeck, shipMaster, groups);
  return hundred * 1e9 + capped * 1e6 + ci * 1e4 + fb * 1e3 + wa + ev * 2;
}

function addCount(counts, key) { counts[key] = (counts[key] || 0) + 1; }
function cloneCounts(c) { return Object.assign({}, c); }
function withinLocalInventory(counts, invMap) {
  for (const [k,v] of Object.entries(counts)) if (v > (invMap.get(k)?.count || 0)) return false;
  return true;
}

function candidateRank(g, isBarrage) {
  const rocket = g.id === ROCKET_ID ? 1 : 0;
  const w = weightedEquipContribution(g.master, g.rf);
  const f = fleetEquipContribution(g.master, g.rf);
  const ev = itemEvasion(g.master);
  if (isBarrage) {
    // 噴進艦はまず100%到達が目的。候補段階では艦隊防空より加重対空を優先する。
    // これにより機銃（加重対空×6）が高角砲より先に残りやすくなる。
    return rocket * 1e9 + w * 1000 + f * 10 + ev;
  }
  return f * 100 + w + ev * 2;
}

function trimCandidates(groups, shipMaster, shipDeck, isEx, limit) {
  const eligible = groups.filter(g => (isEx ? canEquipEx(shipMaster, shipDeck, g.master) : canEquipRegular(shipMaster, g.master)));
  if (eligible.length <= limit) return eligible;

  // 単純な総合点上位だけにすると、噴進100%用の高加重対空機銃や
  // Atlanta/Reno等の専用CI装備が候補落ちする。役割別に候補を予約する。
  const picked = [];
  const seen = new Set();
  const add = g => { if (g && !seen.has(g.key) && picked.length < limit) { seen.add(g.key); picked.push(g); } };
  const takeSorted = (arr, n, scoreFn) => {
    [...arr].sort((a,b) => scoreFn(b) - scoreFn(a)).slice(0, n).forEach(add);
  };

  // 噴進砲は必ず残す。
  eligible.filter(g => g.id === ROCKET_ID).forEach(add);

  const isBarrageShip = barrageEligible(shipMaster);

  // 専用CI艦では専用装備を候補上限の外側から先に予約する。
  // Reno/Atlantaが汎用高角砲だけで候補枠を埋めるのを防ぐ。
  if (isAtlantaAaciShip(shipMaster)) {
    eligible.filter(g => isAtlantaGun(g.master) || isAtlantaGFCSGun(g.master) || isGFCS37(g.master)).forEach(add);
  }
  if (sameClass(shipMaster, 'fletcher')) {
    eligible.filter(g => isFletcherGun(g.master) || isFletcherGFCSGun(g.master) || isGFCS37(g.master)).forEach(add);
  }
  if (sameClass(shipMaster, 'akizuki')) {
    eligible.filter(g => isHighAngleGun(g.master) || isAARadar(g.master)).forEach(add);
  }

  if (isBarrageShip) {
    // 第1段階：100%到達。加重対空が高い機銃を明示的に厚く残す。
    takeSorted(eligible.filter(g => isMachineGun(g.master)), Math.ceil(limit * 0.45),
      g => weightedEquipContribution(g.master, g.rf));
    takeSorted(eligible, Math.ceil(limit * 0.68),
      g => weightedEquipContribution(g.master, g.rf));
    // 第2段階：100%維持後に高角砲等で艦隊防空を伸ばすための候補。
    takeSorted(eligible, Math.ceil(limit * 0.24),
      g => fleetEquipContribution(g.master, g.rf));
  } else {
    // 非噴進艦は艦隊防空・CIを優先。
    takeSorted(eligible, Math.ceil(limit * 0.38),
      g => fleetEquipContribution(g.master, g.rf));
    takeSorted(eligible, Math.ceil(limit * 0.24),
      g => weightedEquipContribution(g.master, g.rf));
  }

  // 強対空CIの構成要素は数値順位に関係なく一定数残す。
  const ciItems = eligible.filter(g =>
    isSupportedAaciComponent(g.master) || isAtlantaGun(g.master) || isAtlantaGFCSGun(g.master) ||
    isGFCS37(g.master) || isFletcherGun(g.master) || isFletcherGFCSGun(g.master) || isAkizukiImprovedGun(g.master)
  );
  takeSorted(ciItems, Math.ceil(limit * 0.32), g =>
    fleetEquipContribution(g.master, g.rf) * 100 + weightedEquipContribution(g.master, g.rf)
  );

  // 回避装備も少数だけ残す。
  takeSorted(eligible.filter(g => itemEvasion(g.master) > 0), Math.ceil(limit * 0.12), g => itemEvasion(g.master));

  // 残りを従来の総合順位で埋める。
  takeSorted(eligible, limit, g => candidateRank(g, barrageEligible(shipMaster)));
  return picked.slice(0, limit);
}

function pruneLocalStates(states, shipDeck, shipMaster, max) {
  const unique = new Map();
  for (const s of states) {
    const ids = s.items.map(g => g.key).sort().join('|') + `#${s.ex?.key || ''}`;
    const groups = [...s.items, ...(s.ex ? [s.ex] : [])];
    const score = localConfigScore(shipDeck, shipMaster, groups);
    const old = unique.get(ids);
    if (!old || score > old.score) unique.set(ids, { ...s, score });
  }

  const all = [...unique.values()].sort((a,b) => b.score - a.score);
  if (all.length <= max) return all;

  // ビームサーチで「高得点だが同じ高級装備ばかり使う構成」だけが残るのを防ぐ。
  // 噴進砲本数・装備数・発動率帯ごとに代表解を残し、艦隊全体での在庫配分余地を確保する。
  const reserve = new Map();
  for (const s of all) {
    const groups = [...s.items, ...(s.ex ? [s.ex] : [])];
    const rockets = groups.filter(g => g.id === ROCKET_ID).length;
    const rate = calcBarrageRate(shipDeck, shipMaster, groups);
    const band = rate == null ? 'N' : rate >= 100 ? '100' : String(Math.max(0, Math.floor(rate / 10) * 10));
    const ciSig = localAaciCandidates(shipDeck, shipMaster, groups).map(ci=>ci.type).sort((a,b)=>a-b).join(',') || '-';
    const fbBand = Math.floor(calcShipFleetBonus(groups) / 5);
    const waBand = Math.floor(calcWeightedAA(shipDeck, groups) / 20);
    const high = countGroups(groups, isHighAngleGun);
    const mg = countGroups(groups, isMachineGun);
    // 100%到達後に「機銃を高角砲へ置き換えて艦隊防空を伸ばす」解を消さない。
    const key = `${rockets}:${groups.length}:${band}:${ciSig}:fb${fbBand}:wa${waBand}:h${high}:m${mg}`;
    if (!reserve.has(key)) reserve.set(key, s);
  }

  const picked = [];
  const seen = new Set();
  const add = s => {
    if (!s) return;
    const sig = s.items.map(g => g.key).sort().join('|') + `#${s.ex?.key || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig); picked.push(s);
  };
  for (const s of reserve.values()) add(s);
  for (const s of all) {
    if (picked.length >= max) break;
    add(s);
  }
  return picked.slice(0, max).sort((a,b) => b.score - a.score);
}

function generateShipConfigs(shipDeck, shipMaster, invGroups, invMap, forceFill = false, options = {}) {
  const slots = shipSlotCount(shipMaster, shipDeck);
  const sourceGroups = options.groupFilter ? invGroups.filter(options.groupFilter) : invGroups;
  const regularLimit = Number(options.regularLimit || MAX_REGULAR_CANDIDATES);
  const exLimit = Number(options.exLimit || MAX_EX_CANDIDATES);
  const maxConfigs = Number(options.maxConfigs || MAX_SHIP_CONFIGS);
  const regular = trimCandidates(sourceGroups, shipMaster, shipDeck, false, regularLimit);
  const ex = shipDeck.exa ? trimCandidates(sourceGroups, shipMaster, shipDeck, true, exLimit) : [];
  let states = [{ items: [], ex: null, counts: {} }];
  for (let si = 0; si < slots; si++) {
    const next = [];
    for (const st of states) {
      // 非噴進弾幕艦が混在する5-2-1編成では、対空に使える装備がある限り通常スロットを空けない。
      // 全艦が噴進弾幕可能な場合は、全員100%達成後の不要な装備消費を避けるため空きを許容する。
      if (!forceFill || regular.length === 0) {
        next.push({ items: [...st.items], ex: null, counts: cloneCounts(st.counts) }); // 空きスロット
      }
      for (const g of regular) {
        const c = cloneCounts(st.counts); addCount(c, g.key);
        if (!withinLocalInventory(c, invMap)) continue;
        next.push({ items: [...st.items, g], ex: null, counts: c });
      }
    }
    states = pruneLocalStates(next, shipDeck, shipMaster, maxConfigs * 2);
  }
  if (shipDeck.exa) {
    const next = [];
    for (const st of states) {
      // 混成艦隊では、増設に対空候補を積めるなら空けない。
      if (!forceFill || ex.length === 0) next.push({ ...st, ex: null });
      for (const g of ex) {
        const c = cloneCounts(st.counts); addCount(c, g.key);
        if (!withinLocalInventory(c, invMap)) continue;
        next.push({ items: st.items, ex: g, counts: c });
      }
    }
    states = next;
  }
  states = pruneLocalStates(states, shipDeck, shipMaster, maxConfigs);
  return states.map(st => {
    const all = [...st.items, ...(st.ex ? [st.ex] : [])];
    return {
      ...st,
      all,
      weightedAA: calcWeightedAA(shipDeck, all),
      fleetBonus: calcShipFleetBonus(all),
      barrageRate: calcBarrageRate(shipDeck, shipMaster, all),
      evasionTerm: calcAirEvasionTerm(shipDeck, all),
      rocketCount: all.filter(g => g.id === ROCKET_ID).length,
    };
  });
}

function countsFit(total, add, invMap) {
  for (const [k,v] of Object.entries(add)) if ((total[k] || 0) + v > (invMap.get(k)?.count || 0)) return false;
  return true;
}
function mergeCounts(a,b) { const c = cloneCounts(a); for (const [k,v] of Object.entries(b)) c[k]=(c[k]||0)+v; return c; }

function partialScore(assignments, defenseMode = false) {
  let rocketCovered = 0, hundred = 0, capped = 0, fleetBonusSum = 0, weighted = 0, filled = 0, ciPotential = 0, rocketTotal = 0;
  for (const a of assignments) {
    if (a.config.barrageRate != null) {
      const rockets = a.config.rocketCount || 0;
      rocketTotal += rockets;
      if (rockets > 0) rocketCovered++;
      if (a.config.barrageRate >= 100) hundred++;
      capped += Math.min(100, a.config.barrageRate);
    }
    const cis = detectAaciForAssignment(a, 0);
    if (cis.length) ciPotential += Math.max(...cis.map(ci => ci.rate * (ci.fixed * 4 + ci.variable * 10)));
    fleetBonusSum += a.config.fleetBonus;
    weighted += a.config.weightedAA;
    filled += a.config.all.length;
  }
  // ビーム探索途中は噴進条件を守りつつ、強CI候補と艦隊防空を残して最終無被弾評価へ渡す。
  // 同じ噴進達成度なら、まず1本ずつ配れるよう「100%達成に不要な余分な噴進砲」を軽く不利にする。
  // これがないと、序盤艦へ希少装備を集中した状態だけが上位1万件を占有し、後続艦に装備を残せず全状態が消えることがある。
  const extraRockets = Math.max(0, rocketTotal - rocketCovered);
  if (defenseMode) {
    // 全噴進艦100%が可能と分かった後は、100%超過そのものを評価しない。
    // 強CI候補と艦隊防空を優先して残し、最終段で実際の5-2-C無被弾率を比較する。
    return rocketCovered * 1e15 + hundred * 1e12
      + ciPotential * 1e9 + fleetBonusSum * 1e7 + weighted * 1e3
      - extraRockets * 1e6 + filled * 1e-3;
  }
  return rocketCovered * 1e15 + hundred * 1e12 + capped * 1e8 - extraRockets * 1e7 + ciPotential * 1e6 + fleetBonusSum * 1e4 + weighted + filled * 1e-3;
}

function finalMetrics(assignments, formationKey) {
  let cache = FINAL_METRIC_CACHE.get(assignments);
  if (!cache) { cache = new Map(); FINAL_METRIC_CACHE.set(assignments, cache); }
  if (cache.has(formationKey)) return cache.get(formationKey);

  const formation = FORMATION[formationKey];
  let rocketCovered = 0, hundred = 0, capped = 0, bonusSum = 0, weightedSum = 0, filled = 0;
  for (const a of assignments) {
    const r = a.config.barrageRate;
    if (r != null) {
      if ((a.config.rocketCount || 0) > 0) rocketCovered++;
      if (r >= 100) hundred++;
      capped += Math.min(100, r);
    }
    bonusSum += a.config.fleetBonus;
    weightedSum += a.config.weightedAA;
    filled += a.config.all.length;
  }
  const fleetAA = Math.floor(formation.factor * bonusSum) * (2 / 1.3);
  const combat = evaluateNoDamage(assignments, formationKey, fleetAA);
  const metrics = { rocketCovered, hundred, capped, bonusSum, weightedSum, filled, fleetAA, formation, ...combat };
  cache.set(formationKey, metrics);
  return metrics;
}

function compareFinal(a,b, formationKey) {
  const A = finalMetrics(a.assignments, formationKey), B = finalMetrics(b.assignments, formationKey);
  // 噴進砲の最低1本配布は最優先。全員100%が可能な場合は別途ハード制約化される。
  if (A.rocketCovered !== B.rocketCovered) return B.rocketCovered - A.rocketCovered;
  // 全員100%が不可能な場合も、100%化できる艦数をまず増やす。
  if (A.hundred !== B.hundred) return B.hundred - A.hundred;
  // 100%未達艦が残る間は、その発動率を100%へ近づけることを防空より優先する。
  // ここを後段に置くと、機銃を外して高角砲・電探を積み、50～80%の噴進率を許す解が選ばれてしまう。
  if (Math.abs(A.capped - B.capped) > 1e-9) return B.capped - A.capped;
  // 全噴進艦が100%（または同じ噴進達成度）になった後で、5-2-C無被弾率を最大化する。
  if (Math.abs(A.fleetNoHit - B.fleetNoHit) > 1e-12) return B.fleetNoHit - A.fleetNoHit;
  if (Math.abs(A.expectedHitShips - B.expectedHitShips) > 1e-12) return A.expectedHitShips - B.expectedHitShips;
  if (Math.abs(A.expectedHits - B.expectedHits) > 1e-12) return A.expectedHits - B.expectedHits;
  if (Math.abs(A.flagNoHit - B.flagNoHit) > 1e-12) return B.flagNoHit - A.flagNoHit;
  if (Math.abs(A.allSlotsDead - B.allSlotsDead) > 1e-12) return B.allSlotsDead - A.allSlotsDead;
  if (Math.abs(A.fleetAA - B.fleetAA) > 1e-9) return B.fleetAA - A.fleetAA;
  if (A.filled !== B.filled) return B.filled - A.filled;
  return B.weightedSum - A.weightedSum;
}

function configResourceCost(cfg, invMap) {
  let cost = 0;
  for (const [key, n] of Object.entries(cfg.counts)) {
    const stock = Math.max(1, invMap.get(key)?.count || 1);
    cost += n / stock;
  }
  // 100%達成に2本目・3本目が不要なら、他艦へ回しやすい1本構成から試す。
  cost += Math.max(0, (cfg.rocketCount || 0) - 1) * 2;
  return cost;
}

// 「全噴進艦100%が実現可能なのにビーム探索で落とす」事故を防ぐための可否探索。
// 最大6隻なので、100%構成だけに絞ったDFSは実用時間内に収まりやすい。
// ビーム探索は最適解探索用なので、状態上限によって「実際には可能な在庫配分」を落とすことがある。
// そこで候補集合の中に少なくとも1つ完全な在庫割当があるかをDFSで確認し、最低保証解として保持する。
function findFeasibleWitness(searchShips, configs, invMap, nodeLimit = 500000) {
  const filtered = new Map();
  for (const s of searchShips) {
    const list = [...(configs.get(s.key) || [])].sort((a,b) => {
      const d = configResourceCost(a, invMap) - configResourceCost(b, invMap);
      if (Math.abs(d) > 1e-9) return d;
      if ((a.rocketCount || 0) !== (b.rocketCount || 0)) return (a.rocketCount || 0) - (b.rocketCount || 0);
      if (a.fleetBonus !== b.fleetBonus) return b.fleetBonus - a.fleetBonus;
      return b.weightedAA - a.weightedAA;
    });
    if (!list.length) return null;
    filtered.set(s.key, list);
  }

  // 候補の少ない艦から置く。噴進艦を先にすることで噴進砲在庫の競合も早く判定できる。
  const ordered = [...searchShips].sort((a,b) => {
    const ba = barrageEligible(a.master) ? 0 : 1;
    const bb = barrageEligible(b.master) ? 0 : 1;
    if (ba !== bb) return ba - bb;
    return filtered.get(a.key).length - filtered.get(b.key).length;
  });
  const used = {};
  const chosen = [];
  let nodes = 0;

  function dfs(i) {
    if (++nodes > nodeLimit) return false;
    if (i >= ordered.length) return true;
    const ship = ordered[i];
    for (const cfg of filtered.get(ship.key)) {
      if (!countsFit(used, cfg.counts, invMap)) continue;
      const touched = [];
      for (const [k,v] of Object.entries(cfg.counts)) {
        if (!(k in used)) touched.push(k);
        used[k] = (used[k] || 0) + v;
      }
      chosen.push({ shipKey: ship.key, ship, config: cfg });
      if (dfs(i + 1)) return true;
      chosen.pop();
      for (const [k,v] of Object.entries(cfg.counts)) {
        used[k] -= v;
        if (used[k] <= 0) delete used[k];
      }
      for (const k of touched) if ((used[k] || 0) === 0) delete used[k];
    }
    return false;
  }

  if (!dfs(0)) return null;
  return [...chosen];
}

function findAllHundredWitness(searchShips, configs, invMap) {
  // 「噴進艦を全員100%にできるか」の可否判定では、非噴進艦の装備消費を混ぜない。
  // まず噴進100%を確保し、その残りで非噴進艦を守る、という優先順位をそのまま制約化する。
  const barrageShips = searchShips.filter(s => barrageEligible(s.master));
  if (!barrageShips.length) return null;

  const filtered = new Map();
  for (const s of barrageShips) {
    let list = (configs.get(s.key) || []).filter(c => (c.rocketCount || 0) >= 1 && c.barrageRate >= 100);
    if (!list.length) return null;
    // 100%を満たす中では、噴進砲や希少装備を食いにくく、艦隊防空が高い構成から試す。
    list = [...list].sort((a,b) => {
      const d = configResourceCost(a, invMap) - configResourceCost(b, invMap);
      if (Math.abs(d) > 1e-9) return d;
      if (a.fleetBonus !== b.fleetBonus) return b.fleetBonus - a.fleetBonus;
      return b.weightedAA - a.weightedAA;
    });
    filtered.set(s.key, list);
  }

  const ordered = [...barrageShips].sort((a,b) => filtered.get(a.key).length - filtered.get(b.key).length);
  const used = {};
  const chosen = [];
  let nodes = 0;
  const NODE_LIMIT = 1500000;

  function dfs(i) {
    if (++nodes > NODE_LIMIT) return false;
    if (i >= ordered.length) return true;
    const ship = ordered[i];
    for (const cfg of filtered.get(ship.key)) {
      if (!countsFit(used, cfg.counts, invMap)) continue;
      const before = cloneCounts(used);
      for (const [k,v] of Object.entries(cfg.counts)) used[k] = (used[k] || 0) + v;
      chosen.push({ shipKey: ship.key, ship, config: cfg });
      if (dfs(i + 1)) return true;
      chosen.pop();
      for (const k of Object.keys(used)) delete used[k];
      Object.assign(used, before);
    }
    return false;
  }

  if (!dfs(0)) return null;
  return [...chosen];
}

function assignmentCounts(assignments) {
  const out = {};
  for (const a of assignments || []) {
    for (const [k,v] of Object.entries(a.config?.counts || {})) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function configSignature(cfg) {
  return cfg.items.map(g => g.key).sort().join('|') + `#${cfg.ex?.key || ''}`;
}

function pushUniqueConfig(list, cfg) {
  const sig = configSignature(cfg);
  if (!list.some(x => configSignature(x) === sig)) list.push(cfg);
}

function phase1StateMetrics(assignments) {
  let covered = 0, hundred = 0, capped = 0, overkill = 0, rockets = 0, itemCount = 0, resource = 0;
  for (const a of assignments) {
    const c = a.config;
    const r = Number(c.barrageRate || 0);
    const rc = Number(c.rocketCount || 0);
    if (rc > 0) covered++;
    rockets += rc;
    if (r >= 100) hundred++;
    capped += Math.min(100, r);
    overkill += Math.max(0, r - 100);
    itemCount += c.all.length;
    resource += Object.values(c.counts || {}).reduce((x,y)=>x+y,0);
  }
  return { covered, hundred, capped, overkill, rockets, itemCount, resource };
}

function comparePhase1States(a, b) {
  const A = phase1StateMetrics(a.assignments), B = phase1StateMetrics(b.assignments);
  if (A.covered !== B.covered) return B.covered - A.covered;
  if (A.hundred !== B.hundred) return B.hundred - A.hundred;
  if (Math.abs(A.capped - B.capped) > 1e-9) return B.capped - A.capped;
  // 100%超過は価値がないので、同じ到達度なら過剰な加重対空を避けて装備を温存する。
  if (Math.abs(A.overkill - B.overkill) > 1e-9) return A.overkill - B.overkill;
  if (A.rockets !== B.rockets) return A.rockets - B.rockets;
  if (A.itemCount !== B.itemCount) return A.itemCount - B.itemCount;
  return A.resource - B.resource;
}

function phase1MachineGunAllocation(barrageShips, inventory, invMap, rocketStock) {
  if (!barrageShips.length) return { assignments: [], allHundred: true, configs: new Map() };
  const configs = new Map();
  const mgFilter = g => g.id === ROCKET_ID || isMachineGun(g.master);

  for (const s of barrageShips) {
    let list = generateShipConfigs(s.deck, s.master, inventory, invMap, false, {
      groupFilter: mgFilter,
      regularLimit: 26,
      exLimit: 18,
      maxConfigs: 320,
    });
    // 噴進砲がない構成で機銃だけ消費する意味はフェーズ1にはない。
    list = list.filter(c => (c.rocketCount || 0) > 0 || c.all.length === 0);
    if (!list.length) throw new Error(`${s.master.api_name}のフェーズ1候補を生成できませんでした。`);
    list.sort((a,b) => {
      const A = { assignments:[{ shipKey:s.key, ship:s, config:a }] };
      const B = { assignments:[{ shipKey:s.key, ship:s, config:b }] };
      return comparePhase1States(A,B);
    });

    // 噴進砲不足時は、各艦が「噴進砲なし」でフェーズ1を抜けられる候補を必ず残す。
    // ここを上位240件の単純切り捨てにすると、噴進砲あり候補だけで埋まり、
    // stock < 噴進可能艦数のときに全艦へロケットを要求する形になって探索不能になる。
    const limited = list.slice(0, 240);
    if (rocketStock < barrageShips.length) {
      const noRocket = list.find(c => (c.rocketCount || 0) === 0 && c.all.length === 0);
      if (noRocket) pushUniqueConfig(limited, noRocket);
    }
    configs.set(s.key, limited);
  }

  const requireRocketOnAll = rocketStock >= barrageShips.length;
  if (requireRocketOnAll) {
    for (const s of barrageShips) {
      const list = configs.get(s.key).filter(c => (c.rocketCount || 0) >= 1);
      if (!list.length) throw new Error(`${s.master.api_name}に噴進砲改二を装備できる候補がありません。`);
      configs.set(s.key, list);
    }
  }

  // まず機銃だけで全員100%が可能かを確認。可能ならここでハード制約化する。
  const allHundredWitness = requireRocketOnAll ? findAllHundredWitness(barrageShips, configs, invMap) : null;
  if (allHundredWitness) {
    return { assignments: allHundredWitness, allHundred: true, configs };
  }

  // 不可能なら「100%艦数 → 100%未達分の合計発動率 → 過剰装備の少なさ」の順で小さなビーム探索。
  const BEAM = 1800;
  let states = [{ counts:{}, assignments:[] }];
  const ordered = [...barrageShips].sort((a,b) => (configs.get(a.key)?.length || 0) - (configs.get(b.key)?.length || 0));
  for (const s of ordered) {
    const next = [];
    for (const st of states) {
      for (const cfg of configs.get(s.key)) {
        if (!countsFit(st.counts, cfg.counts, invMap)) continue;
        next.push({
          counts: mergeCounts(st.counts, cfg.counts),
          assignments: [...st.assignments, { shipKey:s.key, ship:s, config:cfg }],
        });
      }
    }
    next.sort(comparePhase1States);
    states = next.slice(0, BEAM);
    if (!states.length) break;
  }
  if (!states.length) {
    const witness = findFeasibleWitness(barrageShips, configs, invMap, 300000);
    if (!witness) throw new Error('フェーズ1で噴進艦への装備割当を作れませんでした。');
    return { assignments:witness, allHundred:false, configs };
  }
  states.sort(comparePhase1States);
  return { assignments: states[0].assignments, allHundred:false, configs };
}

function phase1bScore(assignments) {
  let bonus = 0, weighted = 0, filled = 0, extraRockets = 0;
  for (const a of assignments) {
    bonus += a.config.fleetBonus;
    weighted += a.config.weightedAA;
    filled += a.config.all.length;
    extraRockets += Math.max(0, (a.config.rocketCount || 0) - 1);
  }
  return bonus * 1e9 + weighted * 1e4 + filled - extraRockets * 1e2;
}

function optimizeHundredBarrageDefense(barrageShips, baselineAssignments, inventory, invMap) {
  const baseByKey = new Map(baselineAssignments.map(a => [a.shipKey, a]));
  const fixed = baselineAssignments.filter(a => Number(a.config.barrageRate || 0) < 100);
  const adjustableShips = barrageShips.filter(s => Number(baseByKey.get(s.key)?.config?.barrageRate || 0) >= 100);
  if (!adjustableShips.length) return baselineAssignments;

  const baseCounts = assignmentCounts(fixed);
  const configs = new Map();
  const defenseFilter = g => g.id === ROCKET_ID
    || weightedEquipContribution(g.master, g.rf) > 0
    || fleetEquipContribution(g.master, g.rf) > 0;

  for (const s of adjustableShips) {
    let list = generateShipConfigs(s.deck, s.master, inventory, invMap, false, {
      groupFilter: defenseFilter,
      regularLimit: 30,
      exLimit: 20,
      maxConfigs: 420,
    }).filter(c => (c.rocketCount || 0) >= 1 && c.barrageRate >= 100);
    const baseline = baseByKey.get(s.key)?.config;
    if (baseline) pushUniqueConfig(list, baseline);
    if (!list.length) throw new Error(`${s.master.api_name}の100%維持候補を生成できませんでした。`);
    // フェーズ1bは発動率超過ではなく艦隊防空を稼ぐ。
    list.sort((a,b) => {
      if (a.fleetBonus !== b.fleetBonus) return b.fleetBonus - a.fleetBonus;
      if (a.weightedAA !== b.weightedAA) return b.weightedAA - a.weightedAA;
      return (a.rocketCount || 0) - (b.rocketCount || 0);
    });
    configs.set(s.key, list.slice(0, 160));
  }

  const BEAM = 1400;
  let states = [{ counts:cloneCounts(baseCounts), assignments:[...fixed], score:phase1bScore(fixed) }];
  const ordered = [...adjustableShips].sort((a,b) => configs.get(a.key).length - configs.get(b.key).length);
  for (const s of ordered) {
    const next = [];
    for (const st of states) {
      for (const cfg of configs.get(s.key)) {
        if (!countsFit(st.counts, cfg.counts, invMap)) continue;
        const assignments = [...st.assignments, { shipKey:s.key, ship:s, config:cfg }];
        next.push({ counts:mergeCounts(st.counts, cfg.counts), assignments, score:phase1bScore(assignments) });
      }
    }
    next.sort((a,b)=>b.score-a.score);
    states = next.slice(0, BEAM);
    if (!states.length) break;
  }
  if (!states.length) return baselineAssignments;
  states.sort((a,b)=>b.score-a.score);
  return states[0].assignments;
}

function stage2ExpectedRemaining(slotCount, assignments, fleetAA, ci) {
  if (slotCount <= 0) return 0;
  let expected = 0;
  const n = assignments.length;
  for (const a of assignments) {
    const weighted = a.config.weightedAA;
    const proportional = Math.floor((weighted / 400) * slotCount);
    const fixed = Math.floor(((weighted + fleetAA) * ci.variable) / 10);
    const guarantee = 1 + ci.fixed;
    let local = 0;
    for (const propSuccess of [0,1]) for (const fixedSuccess of [0,1]) {
      let remain = slotCount;
      if (propSuccess) remain -= proportional;
      if (fixedSuccess) remain -= fixed;
      remain -= guarantee;
      local += Math.max(0, remain) * 0.25;
    }
    expected += local / n;
  }
  return expected;
}

function slotExpectedRemaining(initialSlot, assignments, fleetAA, ci) {
  let out = 0;
  for (const lossRate of AIR_DENIAL_STAGE1_LOSS_RATES) {
    const lost = Math.floor(initialSlot * lossRate);
    const after1 = Math.max(0, initialSlot - lost);
    out += 0.25 * stage2ExpectedRemaining(after1, assignments, fleetAA, ci);
  }
  return out;
}

function evaluateExpectedShotdown(assignments, formationKey) {
  const formation = FORMATION[formationKey];
  const bonusSum = assignments.reduce((s,a)=>s+a.config.fleetBonus,0);
  const fleetAA = Math.floor(formation.factor * bonusSum) * (2 / 1.3);
  const ciOutcomes = aaciOutcomeDistribution(assignments);
  let expectedRemaining = 0;
  let expectedAfterStage1 = 0;
  let allSlotsDead = 0;
  for (const pattern of ENEMY_521_PATTERNS) {
    let remPattern = 0, after1Pattern = 0, deadPattern = 0;
    for (const initial of pattern.slots) {
      for (const lossRate of AIR_DENIAL_STAGE1_LOSS_RATES) {
        after1Pattern += 0.25 * Math.max(0, initial - Math.floor(initial * lossRate));
      }
    }
    for (const ci of ciOutcomes) {
      let rem = 0;
      const survive = [];
      for (const initial of pattern.slots) {
        rem += slotExpectedRemaining(initial, assignments, fleetAA, ci);
        survive.push(slotSurvivalProbability(initial, assignments, fleetAA, ci));
      }
      remPattern += ci.prob * rem;
      deadPattern += ci.prob * survive.reduce((prod,p)=>prod*(1-p),1);
    }
    expectedRemaining += remPattern / 3;
    expectedAfterStage1 += after1Pattern / 3;
    allSlotsDead += deadPattern / 3;
  }
  return {
    expectedRemaining,
    expectedShotdown: expectedAfterStage1 - expectedRemaining,
    expectedAfterStage1,
    allSlotsDead,
    fleetAA,
    ciOutcomes,
  };
}

function phase2LocalScore(assignments) {
  let ci = 0, bonus = 0, weighted = 0, filled = 0;
  for (const a of assignments) {
    const cis = detectAaciForAssignment(a, 0);
    if (cis.length) ci += Math.max(...cis.map(x => x.rate * (x.fixed * 8 + x.variable * 12)));
    bonus += a.config.fleetBonus;
    weighted += a.config.weightedAA;
    filled += a.config.all.length;
  }
  return ci * 1e9 + bonus * 1e6 + weighted * 1e2 + filled;
}

function optimizeNonBarrageDefense(nonBarrageShips, fixedAssignments, inventory, invMap, formationKey, forceFill = true) {
  if (!nonBarrageShips.length) return { assignments:fixedAssignments, defense:evaluateExpectedShotdown(fixedAssignments, formationKey) };
  const baseCounts = assignmentCounts(fixedAssignments);
  const configs = new Map();
  for (const s of nonBarrageShips) {
    let list = generateShipConfigs(s.deck, s.master, inventory, invMap, forceFill, {
      regularLimit: 32,
      exLimit: 22,
      maxConfigs: 480,
    });
    if (!list.length && forceFill) return optimizeNonBarrageDefense(nonBarrageShips, fixedAssignments, inventory, invMap, formationKey, false);
    if (!list.length) throw new Error(`${s.master.api_name}のフェーズ2候補を生成できませんでした。`);
    // 強CI候補・艦隊防空・加重対空の代表を残す。
    list.sort((a,b) => {
      const aa = { shipKey:s.key, ship:s, config:a };
      const bb = { shipKey:s.key, ship:s, config:b };
      const sa = phase2LocalScore([aa]), sb = phase2LocalScore([bb]);
      return sb-sa;
    });
    configs.set(s.key, list.slice(0, 180));
  }

  const BEAM = 1600;
  let states = [{ counts:cloneCounts(baseCounts), assignments:[], score:0 }];
  const ordered = [...nonBarrageShips].sort((a,b)=>configs.get(a.key).length-configs.get(b.key).length);
  for (const s of ordered) {
    const next = [];
    for (const st of states) {
      for (const cfg of configs.get(s.key)) {
        if (!countsFit(st.counts, cfg.counts, invMap)) continue;
        const local = [...st.assignments, { shipKey:s.key, ship:s, config:cfg }];
        next.push({ counts:mergeCounts(st.counts,cfg.counts), assignments:local, score:phase2LocalScore(local) });
      }
    }
    next.sort((a,b)=>b.score-a.score);
    states = next.slice(0, BEAM);
    if (!states.length) break;
  }
  if (!states.length) {
    if (forceFill) return optimizeNonBarrageDefense(nonBarrageShips, fixedAssignments, inventory, invMap, formationKey, false);
    throw new Error('フェーズ2で所持装備制約を満たす組合せを生成できませんでした。');
  }

  // 最終候補だけ実際の5-2-C三編成・対空CI込みの期待撃墜数で比較する。
  let best = null;
  for (const st of states) {
    const all = [...fixedAssignments, ...st.assignments];
    const defense = evaluateExpectedShotdown(all, formationKey);
    if (!best
      || defense.expectedRemaining < best.defense.expectedRemaining - 1e-9
      || (Math.abs(defense.expectedRemaining-best.defense.expectedRemaining) <= 1e-9 && defense.allSlotsDead > best.defense.allSlotsDead + 1e-12)
      || (Math.abs(defense.expectedRemaining-best.defense.expectedRemaining) <= 1e-9 && Math.abs(defense.allSlotsDead-best.defense.allSlotsDead) <= 1e-12 && defense.fleetAA > best.defense.fleetAA + 1e-9)) {
      best = { assignments:all, defense };
    }
  }
  return best;
}

function prepareFleetOptimization(deckFleet, inventory) {
  const invMap = new Map(inventory.map(g => [g.key, g]));
  const ships = Object.keys(deckFleet)
    .filter(k => /^s[1-6]$/.test(k) && deckFleet[k])
    .map(k => ({ key:k, deck:deckFleet[k], master:state.shipsById.get(Number(deckFleet[k].id)) }));
  if (!ships.length) throw new Error('選択艦隊に艦娘がありません。');
  for (const s of ships) if (!s.master) throw new Error(`艦ID ${s.deck.id} のマスターデータが見つかりません。`);

  const barrageShips = ships.filter(s => barrageEligible(s.master));
  const nonBarrageShips = ships.filter(s => !barrageEligible(s.master));
  const rocketStock = inventory.filter(g => g.id === ROCKET_ID).reduce((sum,g)=>sum+g.count,0);

  // フェーズ1A/1Bは陣形に依存しないため、一度だけ計算して全陣形で共有する。
  const p1 = phase1MachineGunAllocation(barrageShips, inventory, invMap, rocketStock);
  const barrageAssignments = optimizeHundredBarrageDefense(barrageShips, p1.assignments, inventory, invMap);

  // 噴進砲が足りない場合、フェーズ1で噴進砲を受け取れなかった噴進可能艦は、
  // フェーズ2では通常の非噴進弾幕艦と同じ「対空砲火で守る対象」として扱う。
  // その艦のフェーズ1空構成は固定せず、フェーズ2で高角砲・機銃・電探・対空CI候補を再探索する。
  const barrageByKey = new Map(barrageAssignments.map(a => [a.shipKey, a]));
  const uncoveredBarrageShips = barrageShips.filter(s => Number(barrageByKey.get(s.key)?.config?.rocketCount || 0) === 0);
  const coveredBarrageAssignments = barrageAssignments.filter(a => Number(a.config?.rocketCount || 0) > 0);
  const defenseShips = [...nonBarrageShips, ...uncoveredBarrageShips]
    .sort((a,b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));

  return {
    deckFleet, inventory, invMap, ships, barrageShips, nonBarrageShips, rocketStock, p1,
    barrageAssignments, coveredBarrageAssignments, uncoveredBarrageShips, defenseShips,
  };
}

function optimizePreparedFormation(prepared, formationKey, forceFillOverride = null) {
  const {
    inventory, invMap, ships, barrageShips, nonBarrageShips, rocketStock, p1,
    barrageAssignments, coveredBarrageAssignments, uncoveredBarrageShips, defenseShips,
  } = prepared;
  const p2 = optimizeNonBarrageDefense(
    defenseShips,
    coveredBarrageAssignments,
    inventory,
    invMap,
    formationKey,
    forceFillOverride == null ? true : Boolean(forceFillOverride)
  );

  const assignments = [...p2.assignments].sort((a,b)=>Number(a.shipKey.slice(1))-Number(b.shipKey.slice(1)));
  const best = { assignments, formationKey };
  best.metrics = finalMetrics(assignments, formationKey);
  best.metrics.expectedShotdown = p2.defense.expectedShotdown;
  best.metrics.expectedRemaining = p2.defense.expectedRemaining;
  best.metrics.stage2AllSlotsDead = p2.defense.allSlotsDead;
  best.constraints = {
    phased:true,
    rocketStock,
    barrageCount:barrageShips.length,
    allHundredByMachineGun:p1.allHundred,
    hasNonBarrageShip:defenseShips.length>0,
    nativeNonBarrageCount:nonBarrageShips.length,
    uncoveredBarrageCount:uncoveredBarrageShips.length,
    shipCount:ships.length,
  };
  return best;
}

function optimizeFleet(deckFleet, inventory, formationKey, forceFillOverride = null) {
  return optimizePreparedFormation(prepareFleetOptimization(deckFleet, inventory), formationKey, forceFillOverride);
}

function compareFormationResult(a, b) {
  // 陣形の推奨は「被弾率最小」=「艦隊無被弾率最大」で決める。
  const A = a.metrics, B = b.metrics;
  if (Math.abs(A.fleetNoHit - B.fleetNoHit) > 1e-12) return B.fleetNoHit - A.fleetNoHit;
  if (Math.abs(A.expectedHitShips - B.expectedHitShips) > 1e-12) return A.expectedHitShips - B.expectedHitShips;
  if (Math.abs(A.expectedHits - B.expectedHits) > 1e-12) return A.expectedHits - B.expectedHits;
  if (Math.abs(A.allSlotsDead - B.allSlotsDead) > 1e-12) return B.allSlotsDead - A.allSlotsDead;
  if (Math.abs(A.fleetAA - B.fleetAA) > 1e-9) return B.fleetAA - A.fleetAA;
  return 0;
}

function formatRf(rf) { return rf > 0 ? ` ★${rf === 10 ? 'max' : rf}` : ''; }
function itemName(g) { return `${g.master.api_name || `装備ID ${g.id}`}${formatRf(g.rf)}`; }

function renderFormationTabs() {
  if (!els.formationTabs || !state.formationResults) return;
  const { results, recommendedKey } = state.formationResults;
  els.formationTabs.innerHTML = '';
  for (const [key, result] of results.entries()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `formation-tab${key === state.activeFormationKey ? ' active' : ''}${key === recommendedKey ? ' recommended' : ''}${key === 'vanguard' ? ' event-only' : ''}`;
    const noHit = result.metrics.fleetNoHit * 100;
    const hit = 100 - noHit;
    btn.innerHTML = `<strong>${result.metrics.formation.name}</strong><small>無被弾 ${noHit.toFixed(2)}% / 被弾 ${hit.toFixed(2)}%</small>`;
    btn.addEventListener('click', () => {
      state.activeFormationKey = key;
      renderResult(result, state.formationResults.fleetKey, false);
    });
    els.formationTabs.appendChild(btn);
  }
}

function renderResult(best, fleetKey, shouldScroll = true) {
  const fleetNo = Number(fleetKey.slice(1));
  const fleet = state.deck[fleetKey];
  els.resultTitle.textContent = `第${fleetNo}艦隊：${fleet.name || '(名称なし)'}`;
  const barrageCount = best.assignments.filter(x => x.config.barrageRate != null).length;
  const isRecommended = state.recommendedFormationKey === best.formationKey;
  els.summary.innerHTML = `
    <div class="summary-primary">
      <span class="pill important">${best.metrics.formation.name}${isRecommended ? '・推奨' : ''}</span>
      <span class="pill important">噴進100% ${best.metrics.hundred}/${barrageCount}</span>
      <span class="pill important">無被弾 ${(best.metrics.fleetNoHit*100).toFixed(2)}%</span>
    </div>
    <div class="summary-secondary">
      噴進砲配布 ${best.metrics.rocketCovered}/${barrageCount}
      ・期待撃墜 ${Number(best.metrics.expectedShotdown || 0).toFixed(2)}機
      ・敵残存 ${Number(best.metrics.expectedRemaining || 0).toFixed(2)}機
      ・全枯れ ${(best.metrics.allSlotsDead*100).toFixed(2)}%
      ・艦隊防空 ${best.metrics.fleetAA.toFixed(2)}
    </div>
  `;
  renderFormationTabs();
  els.shipResults.innerHTML = '';
  best.assignments.forEach((a, idx) => {
    const c = a.config, m = a.ship.master, d = a.ship.deck;
    const card = document.createElement('article'); card.className = `ship-card${idx===0?' flagship':''}`;
    const regular = c.items.map(itemName);
    while (regular.length < shipSlotCount(m,d)) regular.push('（空き）');
    const exText = d.exa ? (c.ex ? itemName(c.ex) : '（空き）') : '未開放';
    const rate = c.barrageRate;
    const rateClass = rate == null ? '' : rate >= 100 ? 'ok-text' : rate > 0 ? 'warn-text' : 'bad-text';
    const ciList = detectAaciForAssignment(a, idx);
    const ciText = ciList.length ? ciList.map(x => `${x.label}(${(x.rate*100).toFixed(1)}%)`).join(' / ') : 'なし';
    const noDamage = best.metrics.shipNoHit?.[idx] ?? 0;
    const damageRate = Math.max(0, Math.min(1, 1 - noDamage));
    const damageClass = damageRate <= 0.0005 ? 'ok-text' : damageRate < 0.15 ? 'warn-text' : 'bad-text';
    const equipHtml = regular.map((x,i)=>`<div class="equip-item"><span class="slot-no">${i+1}.</span><span>${x}</span></div>`).join('');
    card.innerHTML = `
      <div class="ship-ident">
        <div class="ship-name">${m.api_name || `艦ID ${d.id}`}${idx===0?' <small>旗艦</small>':''}</div>
        <div class="ship-meta">Lv.${d.lv} / 運 ${d.luck} / 素対空 ${estimateBaseAA(d)}</div>
      </div>
      <div class="equip-block">
        <div class="equip-grid">${equipHtml}</div>
        <div class="ex-line"><span>増設</span><strong>${exText}</strong></div>
      </div>
      <div class="key-metrics">
        <div class="key-metric damage-key"><span>被ダメ率</span><b class="${damageClass}">${(damageRate*100).toFixed(1)}%</b></div>
        <div class="key-metric barrage-key"><span>噴進弾幕</span><b class="${rateClass}">${rate == null ? '使用不可' : `${rate.toFixed(1)}%`}</b></div>
        <div class="key-metric ci-key"><span>対空CI</span><b>${ciText}</b></div>
      </div>
      <div class="ref-metrics">
        <span>加重対空 <b>${c.weightedAA}</b></span>
        <span>艦隊対空 <b>${c.fleetBonus}</b></span>
        <span>割合撃墜 <b>${(c.weightedAA / 4).toFixed(1)}%</b></span>
        <span>航空被命中 <b>${(calcAirHitRate(d,c.all,idx===0)*100).toFixed(0)}%</b></span>
        <span>回避項 <b>${c.evasionTerm}</b> (${idx===0?'cond49':'cond0'})</span>
        <span>噴進砲 <b>${c.all.filter(g=>g.id===ROCKET_ID).length}</b></span>
      </div>`;
    els.shipResults.appendChild(card);
  });
  els.resultSection.hidden = false;
  buildOptimizedDeck(best, fleetKey);
  if (shouldScroll) els.resultSection.scrollIntoView({ behavior:'smooth', block:'start' });
}

function buildOptimizedDeck(best, fleetKey) {
  const out = JSON.parse(JSON.stringify(state.deck));
  for (const a of best.assignments) {
    const sd = out[fleetKey][a.shipKey];
    sd.items = {};
    a.config.items.forEach((g,i) => { sd.items[`i${i+1}`] = { id:g.id, rf:g.rf, ac:0 }; });
    if (a.config.ex) sd.items.ix = { id:a.config.ex.id, rf:a.config.ex.rf };

    // DeckBuilder の aa は装備込み表示値として扱う。最適化後の装備に合わせて更新する。
    // 艦固有の装備ボーナス(対空)は現版では未計算のため、その分は含まれない近似値。
    sd.aa = estimateBaseAA(a.ship.deck) + a.config.all.reduce((sum, g) => sum + itemAA(g.master), 0);
  }
  state.lastOptimizedDeck = out;
}

async function runOptimization() {
  try {
    showMessage('最適化中…', false);
    await new Promise(r => setTimeout(r, 30));
    state.deck = parseJson(els.fleetInput.value, '編成');
    const rawInv = parseJson(els.inventoryInput.value, '所持装備');
    // 正常な所持装備JSONは自動保存。次回以降のコピペを不要にする。
    try { await saveInventoryToBrowser(els.inventoryInput.value); } catch (cacheError) { console.warn('所持装備キャッシュ保存失敗', cacheError); }
    const inventory = buildInventory(rawInv);
    if (!inventory.length) throw new Error('対空計算対象になる所持装備が見つかりません。');
    const fleetKey = els.fleetSelect.value;
    const rocketCount = inventory.filter(g=>g.id===ROCKET_ID).reduce((s,g)=>s+g.count,0);
    const prepared = prepareFleetOptimization(state.deck[fleetKey], inventory);
    const formationKeys = formationKeysForShipCount(prepared.ships.length);
    const results = new Map();
    for (const formationKey of formationKeys) {
      showMessage(`最適化中… ${FORMATION[formationKey].name} を計算しています`, false);
      await new Promise(r => setTimeout(r, 0));
      results.set(formationKey, optimizePreparedFormation(prepared, formationKey));
    }

    const recommendable = recommendableFormationKeys(prepared.ships.length)
      .map(k => results.get(k)).filter(Boolean).sort(compareFormationResult);
    const recommended = recommendable[0] || [...results.values()].sort(compareFormationResult)[0];
    if (!recommended) throw new Error('陣形別の最適化結果を生成できませんでした。');

    state.formationResults = { fleetKey, results, recommendedKey:recommended.formationKey };
    state.recommendedFormationKey = recommended.formationKey;
    state.activeFormationKey = recommended.formationKey;
    renderResult(recommended, fleetKey);
    const compared = [...results.values()].map(x=>x.metrics.formation.name).join(' / ');
    showMessage(`最適化完了。${compared} を比較し、${recommended.metrics.formation.name}を推奨表示しています。所持12cm30連装噴進砲改二: ${rocketCount}本 / 対空候補装備: ${inventory.reduce((s,g)=>s+g.count,0)}個`, false);
  } catch (e) {
    console.error(e);
    showMessage(e.stack ? `${e.message}\n${e.stack.split('\n')[1] || ''}` : e.message);
  }
}

let fleetParseTimer = null;
els.fleetInput.addEventListener('input', () => {
  clearTimeout(fleetParseTimer);
  fleetParseTimer = setTimeout(parseDeckAndPopulate, 250);
});
els.fleetInput.addEventListener('change', parseDeckAndPopulate);
els.fleetInput.addEventListener('blur', parseDeckAndPopulate);
let inventorySaveTimer = null;
els.inventoryInput.addEventListener('input', () => {
  updateReadyState();
  clearTimeout(inventorySaveTimer);
  // 大きなJSONをキー入力ごとに保存しない。貼り付け/編集停止後に、妥当なJSONだけ保存する。
  inventorySaveTimer = setTimeout(async () => {
    if (!els.inventoryInput.value.trim()) return;
    try { await saveInventoryToBrowser(els.inventoryInput.value); }
    catch { /* 編集途中の不完全JSONでは既存キャッシュを保持する */ }
  }, 900);
});
els.inventoryInput.addEventListener('blur', async () => {
  if (!els.inventoryInput.value.trim()) return;
  try { await saveInventoryToBrowser(els.inventoryInput.value); } catch {}
});
els.fleetSelect.addEventListener('change', e => { state.selectedFleetKey = e.target.value; updateFormationAvailability(); });
els.optimizeBtn.addEventListener('click', runOptimization);
els.openMasterBtn?.addEventListener('click', () => {
  const w = window.open(MASTER_SOURCE_URL, '_blank', 'noopener,noreferrer');
  if (!w) showMessage('新しいタブを開けませんでした。ポップアップブロックを解除するか、取得先リンクを開いてください。');
  else showMessage('開いたJSONページで Ctrl+A → Ctrl+C。その後このページへ戻り「クリップボードから読み込む」を押してください。', false);
});

els.clipboardMasterBtn?.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) throw new Error('このブラウザではクリップボードの直接読み取りを利用できません。');
    const text = await navigator.clipboard.readText();
    await importMasterText(text, 'クリップボード');
  } catch (e) {
    console.error(e);
    showMessage(`クリップボードから直接読み込めませんでした。下の貼り付け欄に Ctrl+V して「貼り付け内容を読み込む」を押してください。
${e.message}`);
    els.masterInput?.focus();
  }
});

els.loadMasterBtn.addEventListener('click', async () => {
  try { await importMasterText(els.masterInput.value, '手動貼り付け'); }
  catch(e) { showMessage(e.message); }
});

// Start2 JSONならページ上のどこで Ctrl+V しても自動認識して読み込む。
// 艦隊JSON・所持装備JSONの通常貼り付けとはシグネチャで区別する。
document.addEventListener('paste', async (event) => {
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text.includes('api_mst_ship') || !text.includes('api_mst_slotitem') || !text.includes('api_mst_stype')) return;
  try {
    event.preventDefault();
    await importMasterText(text, 'Ctrl+V貼り付け');
    if (els.masterInput) els.masterInput.value = '';
  } catch (e) {
    showMessage(`Start2らしきJSONを検出しましたが読み込めませんでした。
${e.message}`);
  }
});

els.clearMasterBtn?.addEventListener('click', async () => {
  if (!confirm('このブラウザに保存したマスターデータを削除しますか？')) return;
  try {
    await idbDelete(MASTER_CACHE_KEY);
    state.master = null;
    state.masterSource = null;
    state.shipsById = new Map(); state.itemsById = new Map(); state.stypesById = new Map();
    state.equipShipById = new Map(); state.exslotItemRules = new Map(); state.exslotCommonTypes = new Set(); state.classIds = {};
    setMasterStatus('マスターデータ未設定', 'pending');
    updateMasterSavedAt(null);
    updateReadyState();
    showMessage('ブラウザ保存済みのマスターデータを削除しました。', false);
  } catch (e) { showMessage(e.message); }
});

els.clearInventoryBtn?.addEventListener('click', async () => {
  if (!confirm('このブラウザに保存した所持装備データを削除しますか？')) return;
  try {
    await idbDelete(INVENTORY_CACHE_KEY);
    updateInventorySavedAt(null);
    showMessage('ブラウザ保存済みの所持装備データを削除しました。入力欄の内容はそのまま残しています。', false);
  } catch (e) { showMessage(e.message); }
});

els.copyDeckBtn.addEventListener('click', async () => {
  if (!state.lastOptimizedDeck) return;
  const text = JSON.stringify(state.lastOptimizedDeck);
  try { await navigator.clipboard.writeText(text); showMessage('最適化後DeckBuilder JSONをコピーしました。', false); }
  catch { showMessage('クリップボードへ直接コピーできませんでした。ブラウザの権限設定を確認してください。'); }
});

loadCachedMaster();
loadCachedInventory();
