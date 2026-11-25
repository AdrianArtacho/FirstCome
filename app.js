import {DEFAULT_API_URL} from './config.js';
import {apiURL, sheetURL, destinationURL, randomToken, createAPI, resolveClaim} from './client.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
const state = {items:[], busy:false, ready:false, loading:false, attempt:null, last:null, key:'', api:null};
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function save() {
  if (!state.key) return;
  try { sessionStorage.setItem(state.key, JSON.stringify({attempt:state.attempt, last:state.last})); }
  catch { /* In-memory retry remains safe when storage is unavailable. */ }
}
function render() {
  const focused = document.activeElement?.dataset.item;
  $('choices').replaceChildren(...state.items.map(item => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    const mine = state.last?.itemId === item.id;
    const pending = state.attempt?.itemId === item.id;
    button.type = 'button';
    button.dataset.item = item.id;
    button.className = `choice${!item.available ? ' taken' : ''}`;
    button.disabled = state.busy || state.loading || Boolean(state.attempt) || !state.ready || !item.available;
    if (pending && state.busy) button.setAttribute('aria-busy', 'true');
    const number = document.createElement('span'); number.className = 'number'; number.textContent = `${item.number}.`; number.setAttribute('aria-hidden','true');
    const label = document.createElement('span'); label.className = 'label'; label.textContent = item.label;
    const status = document.createElement('span'); status.className = 'state';
    status.textContent = pending ? (state.busy ? 'Checking…' : 'Unconfirmed') : mine ? 'Yours' : item.available ? 'Choose' : 'Taken';
    button.append(number, label, status);
    button.addEventListener('click', () => claim(item));
    li.append(button); return li;
  }));
  if (focused) [...$('choices').querySelectorAll('button')].find(button => button.dataset.item === focused && !button.disabled)?.focus();
  const available = state.items.filter(item => item.available).length;
  $('availability').textContent = state.ready ? (state.items.length === 0 ? 'There are no options in this list yet.' : available ? `${available} of ${state.items.length} available` : 'All options have been taken.') : '';
  $('refresh').disabled = state.busy || state.loading;
  $('reset-demo').disabled = state.busy || state.loading;
  $('recover').hidden = !state.attempt;
  $('recover').disabled = state.busy || state.loading;
  $('reopen').hidden = !state.last || Boolean(state.attempt);
  if (state.last) $('reopen').href = destinationURL(state.last.url);
}

async function refresh(quiet = false) {
  if (state.loading || state.busy) return;
  state.loading = true;
  render();
  if (!quiet) notice('Loading the shared list…');
  try {
    const data = await state.api.list();
    state.items = data.items;
    state.ready = true;
    if (!state.attempt) notice();
  } catch (error) { state.ready = false; notice(error.message, true); }
  finally { state.loading = false; render(); }
}

async function claim(item) {
  if (state.busy || state.loading || state.attempt || !state.ready || !item.available) return;
  state.attempt = {itemId:item.id, token:randomToken()};
  save();
  await recover(true, true);
}

async function recover(submit = true, navigate = false) {
  if (state.busy || state.loading || !state.attempt) return;
  state.busy = true;
  notice('Reserving your choice…');
  render();
  try {
    const result = await resolveClaim(state.api, state.attempt, {submit});
    if (result.status === 'claimed') {
      const url = destinationURL(result.url);
      state.last = {itemId:result.itemId, url};
      state.items = state.items.map(item => item.id === result.itemId ? {...item, available:false} : item);
      state.attempt = null;
      save();
      notice(demo ? 'This is how a claim looks. In a live list, its link opens automatically.' : 'Your choice is reserved. You can open it again below.');
      if (navigate && !demo) location.assign(url);
    } else if (['taken','changed','error'].includes(result.status)) {
      state.attempt = null;
      save();
      state.items = state.items.map(item => item.id === result.itemId ? {...item, available:false} : item);
      notice(result.message || (result.status === 'taken' ? 'Someone got there first. Please choose another option.' : 'This option has changed. Refresh the list and choose again.'), true);
    } else { throw new Error('The reservation is unconfirmed. Check your choice again.'); }
  } catch (error) { notice(`${error.message} Your reservation may have succeeded; check it before choosing again.`, true); }
  finally { state.busy = false; render(); }
}

function exampleAPI() {
  let claimed = new Map();
  const receipts = new Map();
  const items = [
    {id:'example-1',label:'Bach · The Art of Fugue',number:1},
    {id:'example-2',label:'Beethoven · Grosse Fuge',number:2},
    {id:'example-3',label:'Shostakovich · 24 Preludes and Fugues',number:3},
    {id:'example-4',label:'Your own discovery',number:4}
  ];
  return {
    list: async () => ({items:items.map(item => ({...item,available:!claimed.has(item.id)}))}),
    submit: async (itemId, token) => {
      if (receipts.has(token)) return;
      const status = claimed.has(itemId) ? 'taken' : 'claimed';
      if (status === 'claimed') claimed.set(itemId, token);
      receipts.set(token, {status,itemId,url:new URL('?demo=1',location.href).href});
    },
    status: async token => receipts.get(token) || {status:'pending'},
    reset: () => { claimed = new Map(); receipts.clear(); }
  };
}

async function start() {
  const sheetValue = params.get('sheet');
  if (!sheetValue && !demo) { showSetup(); return; }
  $('list-view').hidden = false;
  $('list-title').textContent = params.get('title')?.slice(0,160) || 'Choose one.';
  document.title = `${$('list-title').textContent} · FirstCome`;
  if (demo) {
    $('demo-note').hidden = false;
    $('reset-demo').hidden = false;
    state.api = exampleAPI();
    $('list-intro').textContent = 'A little preview. Try choosing an option.';
    $('reopen').textContent = 'Reload example';
  } else {
    try {
      const sheet = sheetURL(sheetValue);
      const endpoint = apiURL(params.get('api') || DEFAULT_API_URL);
      state.api = createAPI(endpoint, sheet);
      state.key = `firstcome:v1:${endpoint}:${sheet}`;
      try {
        const saved = JSON.parse(sessionStorage.getItem(state.key) || '{}');
        if (saved.attempt?.itemId && /^[a-f0-9]{32}$/.test(saved.attempt.token)) state.attempt = saved.attempt;
        if (saved.last?.itemId && saved.last.url) state.last = {...saved.last,url:destinationURL(saved.last.url)};
      } catch { /* Storage is optional, never authoritative. */ }
    } catch (error) {
      $('list-view').hidden = true;
      showSetup();
      notice(error.message, true);
      return;
    }
  }
  await refresh();
  if (state.attempt) await recover(false, false);
  setInterval(() => { if (!document.hidden && !state.attempt) refresh(true); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.attempt) refresh(true); });
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(true); });
}

function showSetup() {
  $('setup').hidden = false;
  $('sheet-input').value = params.get('sheet') || '';
  $('api-input').value = params.get('api') || DEFAULT_API_URL;
  $('backend-setup').hidden = Boolean(DEFAULT_API_URL) && !params.has('api');
  $('title-input').value = params.get('title') || '';
}
$('link-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const sheet = sheetURL($('sheet-input').value.trim());
    const api = apiURL($('api-input').value.trim());
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('sheet', sheet);
    if (api !== DEFAULT_API_URL) url.searchParams.set('api', api);
    const title = $('title-input').value.trim();
    if (title) url.searchParams.set('title', title);
    $('share-url').value = url.href;
    $('open-list').href = url.href;
    $('share-result').hidden = false;
    notice('Link ready. Everyone using this link shares the same list.');
  } catch (error) { notice(error.message, true); }
});
$('copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('share-url').value); notice('Link copied.'); }
  catch { $('share-url').focus(); $('share-url').select(); notice('Select and copy the link above.'); }
});
$('refresh').addEventListener('click', () => refresh());
$('recover').addEventListener('click', () => recover(true, true));
$('reset-demo').addEventListener('click', () => { state.api.reset(); state.last = null; state.attempt = null; refresh(); });
start();
