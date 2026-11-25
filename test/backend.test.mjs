import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const code = readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8');
const source = 'https://docs.google.com/spreadsheets/d/ExampleSheet_123/edit#gid=0';
const tokens = ['a'.repeat(48), 'b'.repeat(48), 'c'.repeat(48)];

function harness(initialRows = [['Label', 'URL'], ['First option', 'https://example.org/one']]) {
  const store = { committed: [], pending: [], rows: initialRows, locked: false, events: [], fetches: [], properties: {}, fetchStatus: 200, fetchText: 'csv data', onFetch: null };
  const sheet = {
    setName() {}, setFrozenRows() {},
    appendRow(row) {
      assert.equal(store.locked, true, 'every state write must hold the script lock');
      store.pending.push([...row]); store.events.push('append');
    },
    getLastRow: () => store.committed.length,
    getRange: (start, _column, count) => ({ getValues: () => store.committed.slice(start - 1, start - 1 + count).map(row => [...row]) })
  };
  const book = { getId: () => 'private-state', getUrl: () => 'https://docs.google.com/spreadsheets/d/private-state/edit', getSheets: () => [sheet], getSheetByName: () => sheet };
  const context = vm.createContext({
    console: { log() {}, error() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(store.locked, false); store.locked = true; store.events.push('lock'); },
      tryLock() { if (store.locked) return false; store.locked = true; store.events.push('lock'); return true; },
      releaseLock() {
        assert.equal(store.pending.length, 0, 'writes must be flushed before unlocking');
        assert.equal(store.locked, true); store.locked = false; store.events.push('release');
      }
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => store.properties[key], setProperty: (key, value) => { store.properties[key] = value; } }) },
    SpreadsheetApp: {
      create: () => book,
      openById: id => { assert.equal(id, 'private-state', 'only the private state spreadsheet is opened with owner permissions'); return book; },
      flush: () => { assert.equal(store.locked, true); store.committed.push(...store.pending); store.pending.length = 0; store.events.push('flush'); }
    },
    UrlFetchApp: { fetch: (url, options) => {
      store.fetches.push({ url, options });
      if (store.onFetch) store.onFetch();
      return { getResponseCode: () => store.fetchStatus, getContentText: () => store.fetchText };
    } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text, encoding) => [...createHash(algorithm).update(text, encoding).digest()],
      parseCsv: () => store.rows.map(row => [...row])
    },
    ContentService: {
      MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript' },
      createTextOutput: body => ({ body, setMimeType(type) { this.type = type; return this; } })
    }
  });
  vm.runInContext(code, context);
  context.setup();
  const get = (params = {}) => JSON.parse(context.doGet({ parameter: { action: 'list', sheet: source, ...params } }).body);
  const post = (params = {}) => JSON.parse(context.doPost({ parameter: { action: 'claim', sheet: source, token: tokens[0], ...params } }).body);
  return { context, store, get, post };
}

test('only one claimant wins, retry is idempotent, and all visitors see the claim', () => {
  const { get, post, store } = harness();
  const itemId = get().items[0].id;
  const first = post({ itemId });
  assert.equal(first.status, 'claimed');
  assert.equal(first.url, 'https://example.org/one');
  assert.deepEqual(post({ itemId }), first);
  const other = post({ itemId, token: tokens[1] });
  assert.equal(other.status, 'taken');
  assert.equal(other.url, undefined);
  assert.equal(get().items[0].available, false);
  assert.equal(store.committed.length, 3, 'header and exactly two terminal receipts');
  assert.ok(store.committed.every(row => !row.includes(tokens[0])));
});

test('racing request cannot write inside the lock and can safely retry afterward', () => {
  const { get, post, store } = harness();
  const itemId = get().items[0].id;
  let racingResult;
  store.onFetch = () => { racingResult = post({ itemId, token: tokens[1] }); };
  assert.equal(post({ itemId }).status, 'claimed');
  store.onFetch = null;
  assert.equal(racingResult.code, 'busy');
  assert.equal(get({ action: 'status', token: tokens[1] }).status, 'pending');
  assert.equal(post({ itemId, token: tokens[1] }).status, 'taken');
  assert.deepEqual(store.events.slice(-4), ['lock', 'append', 'flush', 'release']);
});

test('receipts recover a committed response, are isolated by list, and bind a token to one request', () => {
  const { get, post } = harness([['A', 'https://example.org/a'], ['B', 'https://example.org/b']]);
  const [a, b] = get().items;
  assert.equal(get({ action: 'status', token: tokens[0] }).status, 'pending');
  post({ itemId: a.id });
  assert.equal(get({ action: 'status', token: tokens[0] }).url, 'https://example.org/a');
  assert.equal(get({ action: 'status', token: tokens[1] }).status, 'pending');
  assert.equal(get({ action: 'status', token: tokens[0], sheet: source.replace('gid=0', 'gid=1') }).status, 'pending');
  assert.equal(post({ itemId: b.id }).code, 'token_reused');
  assert.equal(get().items[1].available, true);
});

test('row reordering preserves claims; edits invalidate a stale selection', () => {
  const { get, post, store } = harness([['A', 'https://example.org/a'], ['B', 'https://example.org/b']]);
  const [a, b] = get().items;
  post({ itemId: a.id });
  store.rows.reverse();
  const reordered = get().items;
  assert.equal(reordered[1].id, a.id);
  assert.equal(reordered[1].available, false);
  store.rows[0] = ['B changed', 'https://example.org/new'];
  assert.equal(post({ itemId: b.id, token: tokens[1] }).status, 'changed');
  assert.equal(get().items[0].available, true);
});

test('source URLs are canonical, anonymous and independent of share-link aliases', () => {
  const { get, store } = harness();
  const first = get();
  const alias = get({ sheet: 'https://docs.google.com/spreadsheets/d/ExampleSheet_123/edit?usp=sharing&gid=000' });
  assert.equal(first.listId, alias.listId);
  assert.equal(store.fetches[0].url, 'https://docs.google.com/spreadsheets/d/ExampleSheet_123/export?format=csv&gid=0');
  assert.equal(store.fetches[0].options.headers, undefined);
  for (const sheet of [
    'http://docs.google.com/spreadsheets/d/ExampleSheet_123/edit',
    'https://docs.google.com.evil.example/spreadsheets/d/ExampleSheet_123/edit',
    'https://docs.google.com/spreadsheets/d/e/PUBLISHED/pubhtml',
    source + '&gid=1',
    'https://docs.google.com/spreadsheets/d/ExampleSheet_123/edit?gid=1#gid=2',
    'https://docs.google.com/spreadsheets/d/ExampleSheet_123/edit?gid=hello',
    'file:///etc/passwd'
  ]) assert.equal(get({ sheet }).ok, false, sheet);
});

test('GET cannot claim and JSONP is read-only, narrowly named and HTML-safe', () => {
  const { context, get, store } = harness([['</script>\u2028\u2029', 'https://example.org/']]);
  const item = get().items[0];
  assert.equal(get({ action: 'claim', itemId: item.id, token: tokens[0] }).code, 'bad_action');
  assert.equal(store.committed.length, 1);
  const malicious = context.doGet({ parameter: { action: 'list', sheet: source, callback: 'alert(1);//' } });
  assert.equal(JSON.parse(malicious.body).code, 'bad_callback');
  assert.equal(malicious.type, 'application/json');
  const callback = 'fc_jsonp_' + 'f'.repeat(32);
  const output = context.doGet({ parameter: { action: 'list', sheet: source, callback } });
  assert.equal(output.type, 'application/javascript');
  assert.ok(output.body.startsWith(callback + '('));
  assert.ok(!output.body.includes('<'));
  assert.ok(!output.body.includes('\u2028'));
  assert.ok(!output.body.includes('\u2029'));
  assert.ok(!output.body.includes('https://example.org'), 'list has no destination or receipt secrets');
});

test('invalid rows, unsafe destinations and duplicate options fail closed', () => {
  for (const [rows, code] of [
    [[['A', 'javascript:alert(1)']], 'bad_url'],
    [[['A', 'https://example.org\\@evil.example']], 'bad_url'],
    [[['A', 'https://name:password@example.org/']], 'bad_url'],
    [[['', 'https://example.org/']], 'bad_label'],
    [[['A', 'https://example.org/', 'hidden data']], 'bad_columns'],
    [[['A', 'https://example.org/'], ['A', 'https://example.org/']], 'duplicate_item']
  ]) assert.equal(harness(rows).get().code, code);
});

test('private/unavailable sources fail without leaking a service error; terminal errors are receipted', () => {
  const { get, post, store } = harness();
  const itemId = get().items[0].id;
  store.fetchStatus = 403;
  assert.equal(get().code, 'sheet_unavailable');
  assert.equal(post({ itemId }).status, 'error');
  assert.equal(get({ action: 'status', token: tokens[0] }).status, 'error');
  store.fetchStatus = 200;
  assert.equal(post({ itemId, token: tokens[1] }).status, 'claimed');
});

test('setup is idempotent; missing setup and invalid secrets never create claims', () => {
  const { get, post, store, context } = harness();
  const itemId = get().items[0].id;
  context.setup();
  assert.equal(store.committed.length, 1);
  assert.equal(post({ itemId, token: 'too-short' }).code, 'bad_token');
  store.properties = {};
  assert.equal(get().code, 'not_configured');
  assert.equal(post({ itemId }).code, 'not_configured');
  assert.equal(store.committed.length, 1);
  assert.equal(store.locked, false);
});
