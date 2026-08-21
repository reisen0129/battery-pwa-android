/* db.js —— 纯本地 IndexedDB 数据层（不上传任何服务器）
 * 数据模型：
 *   - vehicles: {id, name, capacity(满电电量 kWh), initPct(默认初始电量 %)}
 *   - records: {id, vehicleId, date, ts(数值时间戳), initPct, remainPct, mileage, note, createdAt}
 * 两个对象仓库均用 id 作主键；records 另建 byDate / byVehicle 索引。
 * 全部数据保存于本机 IndexedDB（库名 battery-logger-db），不上传任何服务器。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'battery-logger-db';
  const DB_VERSION = 1;
  const STORE_VEHICLES = 'vehicles';
  const STORE_RECORDS = 'records';

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_VEHICLES)) {
          db.createObjectStore(STORE_VEHICLES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
          s.createIndex('byDate', 'date');
          s.createIndex('byVehicle', 'vehicleId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(store, mode) {
    return openDB().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function promise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ---------- 通用 CRUD ----------
  function getAll(store) {
    return tx(store, 'readonly').then((os) => promise(os.getAll()));
  }
  function get(store, id) {
    return tx(store, 'readonly').then((os) => promise(os.get(id)));
  }
  function put(store, value) {
    return tx(store, 'readwrite').then((os) => promise(os.put(value))).then(() => value);
  }
  function del(store, id) {
    return tx(store, 'readwrite').then((os) => promise(os.delete(id)));
  }
  function clearStore(store) {
    return tx(store, 'readwrite').then((os) => promise(os.clear()));
  }

  // ---------- 业务接口 ----------
  const DB = {
    open: openDB,

    // 车辆
    getVehicles: () => getAll(STORE_VEHICLES),
    saveVehicle: (v) => put(STORE_VEHICLES, v),
    deleteVehicle: (id) => del(STORE_VEHICLES, id),

    // 记录
    getRecords: () => getAll(STORE_RECORDS),
    saveRecord: (r) => put(STORE_RECORDS, r),
    deleteRecord: (id) => del(STORE_RECORDS, id),

    // 备份：导出全部 + 清空后导入
    exportAll: () =>
      Promise.all([getAll(STORE_VEHICLES), getAll(STORE_RECORDS)]).then(
        ([vehicles, records]) => ({
          app: 'battery-logger',
          version: 1,
          exportedAt: new Date().toISOString(),
          vehicles,
          records,
        })
      ),

    importAll: (data) => {
      // 在单个事务里清空并写入，保证一致性
      return openDB().then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction([STORE_VEHICLES, STORE_RECORDS], 'readwrite');
            const vOs = t.objectStore(STORE_VEHICLES);
            const rOs = t.objectStore(STORE_RECORDS);
            vOs.clear();
            rOs.clear();
            (data.vehicles || []).forEach((v) => vOs.put(v));
            (data.records || []).forEach((r) => rOs.put(r));
            t.oncomplete = () => resolve({ vehicles: (data.vehicles || []).length, records: (data.records || []).length });
            t.onerror = () => reject(t.error);
          })
      );
    },

    // 仅合并导入（不清空已有数据）
    mergeImport: (data) => {
      const tasks = [];
      (data.vehicles || []).forEach((v) => tasks.push(put(STORE_VEHICLES, v)));
      (data.records || []).forEach((r) => tasks.push(put(STORE_RECORDS, r)));
      return Promise.all(tasks).then(() => ({ vehicles: (data.vehicles || []).length, records: (data.records || []).length }));
    },

    clearAll: () => Promise.all([clearStore(STORE_VEHICLES), clearStore(STORE_RECORDS)]),
  };

  global.BatteryDB = DB;
})(window);
