import test from 'node:test';
import assert from 'node:assert/strict';
import {apiURL, createAPI, destinationURL, readJSONP, resolveClaim, sheetURL} from '../client.js';

const source = 'https://docs.google.com/spreadsheets/d/abc_123-XYZ';
const endpoint = 'https://script.google.com/macros/s/AKfycb_example-123/exec';
const attempt = {itemId:'item-1', token:'c'.repeat(32)};
const pause = async () => {};

test('sharing URL aliases identify the same spreadsheet tab', () => {
  const expected = `${source}/edit?gid=17`;
  assert.equal(sheetURL(`${source}/edit?usp=sharing#gid=17`), expected);
  assert.equal(sheetURL(`${source}/edit?gid=0017&usp=sharing`), expected);
  assert.equal(sheetURL(`${source}/export?gid=17&format=csv`), expected);
  assert.equal(sheetURL(`${source}/edit?gid=17#gid=99`), expected);
  assert.equal(sheetURL(`${source}/edit`), `${source}/edit?gid=0`);
});

test('sheet references reject other origins, credentials and malformed tab identifiers', () => {
  for (const value of [
    'not a URL',
    'http://docs.google.com/spreadsheets/d/abc/edit',
    'https://docs.google.com.evil.test/spreadsheets/d/abc/edit',
    'https://docs.google.com@evil.test/spreadsheets/d/abc/edit',
    'https://person:secret@docs.google.com/spreadsheets/d/abc/edit',
    'https://docs.google.com:444/spreadsheets/d/abc/edit',
    'https://docs.google.com/spreadsheets/d/e/published-id/pubhtml',
    `${source}/edit?gid=-1`,
    `${source}/edit?gid=abc`,
    `${source}/edit?gid=9007199254740992`,
    `${source}/edit?gid=1.2`,
    `${source}/edit?gid=`,
  ]) assert.throws(() => sheetURL(value), undefined, value);
});

test('backend URL requires a deployed Apps Script endpoint', () => {
  assert.equal(apiURL(`${endpoint}?ignored=yes#fragment`), endpoint);
  for (const value of [
    'javascript:alert(1)',
    'https://example.com/api',
    endpoint.replace('/exec', '/dev'),
    endpoint.replace('script.google.com', 'script.google.com.evil.test'),
    endpoint.replace('script.google.com', 'script.google.com@evil.test'),
    endpoint.replace('https://', 'https://person:secret@'),
    endpoint.replace('script.google.com', 'script.google.com:444'),
    `${endpoint}/extra`,
  ]) assert.throws(() => apiURL(value), undefined, value);
});

test('redirect destinations allow HTTP links but reject executable schemes and credentials', () => {
  assert.equal(destinationURL('https://example.com/a?q=1#score'), 'https://example.com/a?q=1#score');
  assert.equal(destinationURL('http://example.com/'), 'http://example.com/');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', '//example.com/', 'https://user:secret@example.com/']) {
    assert.throws(() => destinationURL(value), undefined, value);
  }
});

test('a successful opaque POST alone never confirms a reservation', async () => {
  const calls = [];
  const api = {
    async submit(...args) { calls.push(['submit', ...args]); return {type:'opaque'}; },
    async status(token) { calls.push(['status', token]); return {ok:true,status:'pending'}; },
  };
  await assert.rejects(resolveClaim(api, attempt, {pause,tries:2}), /still being checked/);
  assert.deepEqual(calls, [
    ['submit', attempt.itemId, attempt.token],
    ['status', attempt.token],
    ['status', attempt.token],
  ]);
});

test('a committed reservation is recovered when the POST response is lost', async () => {
  const receipt = {ok:true,status:'claimed',itemId:attempt.itemId,url:'https://example.com/score'};
  const api = {
    async submit() { throw new TypeError('Network error after commit'); },
    async status(token) { assert.equal(token, attempt.token); return receipt; },
  };
  assert.deepEqual(await resolveClaim(api, attempt, {pause,tries:1}), receipt);
});

test('pending and transient read failures poll the same receipt until a definitive result', async () => {
  let reads = 0;
  const delays = [];
  const api = {
    async submit() {},
    async status(token) {
      assert.equal(token, attempt.token);
      reads++;
      if (reads === 1) throw new Error('Temporary read failure');
      if (reads === 2) return {ok:true,status:'pending'};
      return {ok:true,status:'taken',itemId:attempt.itemId};
    },
  };
  assert.deepEqual(await resolveClaim(api, attempt, {pause:async ms => delays.push(ms),tries:3}), {ok:true,status:'taken',itemId:attempt.itemId});
  assert.deepEqual(delays, [1500,2000]);
});

test('a receipt for another option cannot authorize this reservation', async () => {
  const api = {async submit() {}, async status() { return {ok:true,status:'claimed',itemId:'another-item',url:'https://example.com/'}; }};
  await assert.rejects(resolveClaim(api, attempt, {pause,tries:1}), /does not match/);
});

test('retries preserve both item and receipt token; recovery can read without another POST', async () => {
  const submissions = [];
  const api = {
    async submit(itemId,token) { submissions.push({itemId,token}); },
    async status() { return {ok:true,status:'claimed',itemId:attempt.itemId,url:'https://example.com/'}; },
  };
  await resolveClaim(api, attempt, {pause,tries:1});
  await resolveClaim(api, attempt, {pause,tries:1});
  await resolveClaim(api, attempt, {pause,tries:1,submit:false});
  assert.deepEqual(submissions, [attempt,attempt]);
});

test('claim transport submits form data without credentials or a CORS preflight', async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); return {type:'opaque'}; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = createAPI(endpoint, `${source}/edit?gid=0`);
  await api.submit(attempt.itemId,attempt.token);
  const [url,request] = calls[0];
  assert.equal(url,endpoint);
  assert.equal(request.method,'POST');
  assert.equal(request.mode,'no-cors');
  assert.equal(request.credentials,'omit');
  assert.equal(request.referrerPolicy,'no-referrer');
  assert.equal(request.headers,undefined);
  assert.ok(request.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(request.body), {action:'claim',sheet:`${source}/edit?gid=0`,...attempt});
});

test('JSONP accepts only its isolated frame and request ID, then removes the frame and listener', async t => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Set();
  const frames = [];
  globalThis.window = {
    addEventListener(type, listener) { assert.equal(type,'message'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type,'message'); listeners.delete(listener); },
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag,'iframe');
      return {
        contentWindow:{}, attributes:{}, removed:false,
        setAttribute(name,value) { this.attributes[name] = value; },
        remove() { this.removed = true; },
      };
    },
    body:{append(frame) { frames.push(frame); }},
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  let settled = false;
  const reading = readJSONP(endpoint,{action:'list',sheet:source},1000);
  reading.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(frames.length,1);
  const frame = frames[0];
  assert.equal(frame.attributes.sandbox,'allow-scripts');
  assert.equal(frame.hidden,true);
  assert.equal(frame.referrerPolicy,'no-referrer');
  assert.match(frame.srcdoc,/default-src 'none'/);
  const request = frame.srcdoc.match(/window\.(fc_jsonp_[a-f0-9]{32})=/)[1];
  const listener = [...listeners][0];
  const receipt = {ok:true,items:[]};

  // A foreign frame that knows the request ID cannot spoof a result.
  listener({source:{},data:{request,result:receipt}});
  // Nor can another request in the same frame accidentally resolve this one.
  listener({source:frame.contentWindow,data:{request:'different-request',result:receipt}});
  await Promise.resolve();
  assert.equal(settled,false);
  assert.equal(listeners.size,1);
  assert.equal(frame.removed,false);

  listener({source:frame.contentWindow,origin:'null',data:{request,result:receipt}});
  assert.deepEqual(await reading,receipt);
  assert.equal(listeners.size,0);
  assert.equal(frame.removed,true);
});
