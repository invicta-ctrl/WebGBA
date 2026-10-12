'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');

const source = readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const slice = (a, b) => {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert.ok(start !== -1 && end !== -1, 'missing source region: ' + a);
  return source.slice(start, end);
};
const zipModule = new Function('Blob', 'DecompressionStream', 'TextDecoder',
  slice('const ZIP_LIMIT =', 'class ZipWriter {') + '\nreturn {zipEntries,zipRead,crc32};');
const { zipEntries, zipRead, crc32 } = zipModule(Blob, DecompressionStream, TextDecoder);

// Minimal ZIP writer for fixtures (independent of the app's ZIP writer).
function zip(name, content, method = 0, corruptCrc = false) {
  const nameB = Buffer.from(name, 'utf8'), raw = Buffer.from(content);
  const payload = method === 8 ? deflateRawSync(raw) : raw;
  const crc = (crc32(raw) ^ (corruptCrc ? 1 : 0)) >>> 0;
  const local = Buffer.alloc(30), dir = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameB.length, 26);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(method, 10); dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(payload.length, 20); dir.writeUInt32LE(raw.length, 24);
  dir.writeUInt16LE(nameB.length, 28);
  const cdOffset = 30 + nameB.length + payload.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + nameB.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameB, payload, dir, nameB, end]);
}

test('parses and verifies a stored ZIP entry', async () => {
  const archive = new Blob([zip('roms/test.gba', Buffer.from('game'))]);
  const [entry] = await zipEntries(archive);
  assert.equal(entry.name, 'roms/test.gba');
  assert.equal(Buffer.from(await zipRead(archive, entry)).toString(), 'game');
});

test('verifies deflated ZIP entries', async () => {
  const archive = new Blob([zip('roms/test.gba', Buffer.from('game'.repeat(100)), 8)]);
  const [entry] = await zipEntries(archive);
  assert.equal(Buffer.from(await zipRead(archive, entry)).toString(), 'game'.repeat(100));
});

test('rejects invalid CRC instead of trusting metadata', async () => {
  const archive = new Blob([zip('roms/test.gba', Buffer.from('game'), 0, true)]);
  const [entry] = await zipEntries(archive);
  await assert.rejects(zipRead(archive, entry), /CRC validation/);
});

test('rejects traversal and absolute ZIP paths', async () => {
  for (const name of ['../file.gba', '/rom.gba', 'a/../b.gba', 'a\\b.gba']) {
    await assert.rejects(zipEntries(new Blob([zip(name, Buffer.from('data'))])), /unsafe ZIP path/);
  }
});

test('rejects oversized declared entries before decompression', async () => {
  const content = zip('rom.gba', Buffer.from('game'));
  const dir = content.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  content.writeUInt32LE(65 * 1024 * 1024, dir + 24);
  await assert.rejects(zipEntries(new Blob([content])), /oversized ZIP entry/);
});

test('rejects invalid ZIP central directory offsets', async () => {
  const content = zip('rom.gba', Buffer.from('game'));
  content.writeUInt32LE(0xffffffff, content.length - 6);
  await assert.rejects(zipEntries(new Blob([content])), /limit/);
});

test('failed SRAM persistence stays dirty and can retry', async () => {
  let attempts = 0;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const R = { lastSave: null, importing: false };
  const state = { running: true, id: 'game' };
  const store = { put: async () => { if (++attempts === 1) throw new Error('quota'); } };
  const Core = { saveData: () => bytes.slice() };
  const factory = new Function('Core','store','state','R','toast',
    slice('const isBlank =', 'setInterval(saveSaveNow, 2000);') + '\nreturn {saveSaveNow};');
  const { saveSaveNow } = factory(Core,store,state,R,()=>{});
  assert.equal(await saveSaveNow(), false);
  assert.equal(R.lastSave, null);
  assert.equal(await saveSaveNow(), true);
  assert.deepEqual(R.lastSave, bytes);
  assert.equal(attempts, 2);
});

test('active-game save import bypasses outgoing autosave', async () => {
  const events = [];
  const state = { running: true, paused: false, id: 'sha256_game', title: 'test' };
  const R = { importing: false, lastRom: { bytes: new Uint8Array([1,2]), name: 'test.gba' } };
  const old = new Uint8Array([4,5,6]), newer = Buffer.from([8,9,10]);
  const factory = new Function('SAVE_MAX','state','R','set','Core','isBlank','download','writeSave','startRom','toast',
    slice('async function importSav(file) {', '/* ---------------------------------------------------------------------- controls */') + '\nreturn importSav;');
  const set = (patch) => Object.assign(state,patch);
  const save = factory(128*1024,state,R,set,{ saveData: () => old },
    () => false,(name) => events.push('backup'),
    async (_id, bytes) => { assert.deepEqual(Buffer.from(bytes),newer); events.push('persist'); },
    async (_rom,_name,opts) => { assert.equal(opts.skipOutgoingSave,true); assert.deepEqual(Buffer.from(opts.saveOverride),newer); events.push('load'); return true; },
    (msg) => events.push(msg));
  await save(new Blob([newer]));
  assert.deepEqual(events.slice(0,3),['backup','persist','load']);
  assert.equal(R.importing,false);
});

test('content-addressed ROM IDs distinguish matching-header variants', async () => {
  const {legacyRomId,romId} = new Function('crypto',
    slice('function legacyRomId(rom) {', 'async function openFile(file) {') +
    '\nreturn {legacyRomId,romId};')(globalThis.crypto);
  const a = new Uint8Array(0xc0), b = new Uint8Array(0xc0);
  a.set(Buffer.from('ABCD'),0xac); b.set(Buffer.from('ABCD'),0xac);
  a[3] = 2; b[3] = 3;
  assert.equal(legacyRomId(a), legacyRomId(b));
  assert.notEqual(await romId(a), await romId(b));
});

test('invalid backup ZIP never writes to stored saves', async () => {
  const archive = new Blob([zip('saves/ABCD.sav', Buffer.from([1,2,3]), 0, true)]);
  let writes = 0;
  const notifications = [];
  const code = slice('async function importBackup(file) {', '/* -------------------------------------------------------------- drag and drop */');
  const run = new Function('zipEntries','zipRead','store','Library','mergeConfig','commitConfig','set','toast','refreshLibrary','ROM_RE','SAVE_MAX','ROM_MAX','TextDecoder',
    code + '\nreturn importBackup;');
  const restore = run(zipEntries,zipRead,
    { put: async () => { writes++; } },
    { add: async () => { writes++; } },
    (x) => x, () => {}, () => {}, (msg) => notifications.push(msg),
    async () => {}, /\.(gba|agb|bin|mb)$/i, 128*1024, 32*1024*1024, TextDecoder);
  await restore(archive);
  assert.equal(writes, 0);
  assert.ok(notifications.some((msg) => /Restore failed:/.test(msg)));
});
