export function sheetURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Paste a normal Google Sheets sharing URL.'); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || !match || match[1] === 'e') {
    throw new Error('Use the normal docs.google.com/spreadsheets/d/… sharing URL, not a published CSV link.');
  }
  const gid = url.searchParams.get('gid') ?? new URLSearchParams(url.hash.slice(1)).get('gid') ?? '0';
  if (!/^\d+$/.test(gid) || !Number.isSafeInteger(Number(gid))) throw new Error('The sheet tab ID (gid) is invalid.');
  return `https://docs.google.com/spreadsheets/d/${match[1]}/edit?gid=${Number(gid)}`;
}

export function apiURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Add the deployed Apps Script web app URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
    throw new Error('Use an Apps Script web app URL ending in /exec.');
  }
  return url.origin + url.pathname;
}

export function destinationURL(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('The destination link is invalid.');
  return url.href;
}

export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Isolate JSONP in an opaque-origin sandbox: a supplied Apps Script endpoint
// must never execute in the Pages origin or read other lists' local receipts.
export function readJSONP(endpoint, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const name = `fc_jsonp_${randomToken()}`;
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const url = new URL(endpoint);
    Object.entries({...params, callback: name, _: randomToken()}).forEach(([key, value]) => url.searchParams.set(key, value));
    const cleanup = () => { clearTimeout(timer); frame.remove(); window.removeEventListener('message', onMessage); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The shared list is not responding. Check the connection and try again.')); }, timeout);
    function onMessage(event) {
      if (event.source !== frame.contentWindow || event.data?.request !== name) return;
      const result = event.data.result;
      cleanup();
      result?.ok ? resolve(result) : reject(new Error(result?.message || 'Could not reach the shared list. Check that the web app is deployed for Anyone.'));
    }
    window.addEventListener('message', onMessage);
    const safeURL = JSON.stringify(url.href).replace(/</g, '\\u003c');
    frame.srcdoc = `<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://script.google.com https://script.googleusercontent.com"><script>window.${name}=result=>parent.postMessage({request:'${name}',result},'*');const s=document.createElement('script');s.src=${safeURL};s.onerror=()=>window.${name}({ok:false});document.head.append(s);<\/script>`;
    document.body.append(frame);
  });
}

export function createAPI(endpoint, sheet) {
  return {
    list: () => readJSONP(endpoint, {action:'list', sheet}),
    status: token => readJSONP(endpoint, {action:'status', sheet, token}),
    async submit(itemId, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        // The opaque response is NOT evidence of success. Only status() can
        // authorize a redirect. This simple POST avoids a CORS preflight.
        await fetch(endpoint, {method:'POST', mode:'no-cors', credentials:'omit', redirect:'follow', referrerPolicy:'no-referrer', signal:controller.signal,
          body:new URLSearchParams({action:'claim', sheet, itemId, token})});
      } finally { clearTimeout(timer); }
    }
  };
}

export async function resolveClaim(api, attempt, {submit = true, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), tries = 6} = {}) {
  if (submit) {
    // A response can be lost after a durable write. Always check the receipt.
    try { await api.submit(attempt.itemId, attempt.token); } catch { /* recover below */ }
  }
  let error;
  for (let i = 0; i < tries; i++) {
    try {
      const result = await api.status(attempt.token);
      if (result.status !== 'pending') {
        if (result.itemId !== attempt.itemId) throw new Error('The reservation response does not match your choice.');
        return result;
      }
    } catch (cause) { error = cause; }
    if (i < tries - 1) await pause(1500 + i * 500);
  }
  throw new Error(error?.message || 'Your choice is still being checked. Use “Check my choice” to retry safely.');
}
