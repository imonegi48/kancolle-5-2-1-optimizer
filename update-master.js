'use strict';

const fs = require('fs/promises');
const path = require('path');

const OUT = path.join(__dirname, 'master.json');
const SOURCES = [
  'https://raw.githubusercontent.com/Nishisonic/gkcoi/master/static/START2.json',
  'https://api.kcwiki.moe/start2',
];

function normalize(raw) {
  const data = raw?.api_data ?? raw;
  if (!data?.api_mst_ship || !data?.api_mst_slotitem || !data?.api_mst_stype) {
    throw new Error('Start2として必要な項目がありません。');
  }
  return {
    api_result: 1,
    _meta: {
      generated_at: new Date().toISOString(),
      note: '5-2-1 optimizer local master snapshot',
    },
    api_data: {
      api_mst_ship: data.api_mst_ship.map(x => ({
        api_id: x.api_id,
        api_name: x.api_name,
        api_stype: x.api_stype,
        api_ctype: x.api_ctype,
        api_slot_num: x.api_slot_num,
        api_taiku: x.api_taiku,
      })),
      api_mst_slotitem: data.api_mst_slotitem.map(x => ({
        api_id: x.api_id,
        api_name: x.api_name,
        api_type: x.api_type,
        api_tyku: x.api_tyku,
      })),
      api_mst_stype: data.api_mst_stype.map(x => ({
        api_id: x.api_id,
        api_name: x.api_name,
        api_equip_type: x.api_equip_type,
      })),
      api_mst_equip_ship: data.api_mst_equip_ship ?? [],
      api_mst_equip_exslot: data.api_mst_equip_exslot ?? [],
      api_mst_equip_exslot_ship: data.api_mst_equip_exslot_ship ?? [],
    },
  };
}

(async () => {
  const errors = [];
  for (const url of SOURCES) {
    try {
      console.log(`取得中: ${url}`);
      const res = await fetch(url, { headers: { 'user-agent': 'kancolle-5-2-1-optimizer' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const compact = normalize(raw);
      await fs.writeFile(OUT, JSON.stringify(compact), 'utf8');
      const d = compact.api_data;
      console.log(`master.json を更新しました: 艦${d.api_mst_ship.length} / 装備${d.api_mst_slotitem.length}`);
      console.log(OUT);
      return;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  console.error('マスターデータを取得できませんでした。');
  errors.forEach(x => console.error(`- ${x}`));
  process.exitCode = 1;
})();
