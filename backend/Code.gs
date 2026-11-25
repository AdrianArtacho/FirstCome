/**
 * FirstCome — deploy once as a web app, executing as you, accessible to Anyone.
 * Run setup() once before deploying. The public source stays a two-column sheet;
 * claims and receipt secrets are kept in a separate, private spreadsheet.
 */
var FIRSTCOME = {
  stateProperty: 'FIRSTCOME_STATE_SPREADSHEET_ID',
  sheetName: 'Claims',
  maxItems: 250,
  maxSourceBytes: 500000,
  maxReceipts: 20000,
  lockWaitMs: 20000
};

function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(FIRSTCOME.lockWaitMs);
  try {
    var properties = PropertiesService.getScriptProperties();
    var existing = properties.getProperty(FIRSTCOME.stateProperty);
    if (existing) {
      console.log('FirstCome claims: https://docs.google.com/spreadsheets/d/' + existing + '/edit');
      return existing;
    }
    var book = SpreadsheetApp.create('FirstCome — private claims');
    var sheet = book.getSheets()[0];
    sheet.setName(FIRSTCOME.sheetName);
    sheet.appendRow(['tokenHash', 'listId', 'itemId', 'status', 'url', 'message', 'createdAt']);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    properties.setProperty(FIRSTCOME.stateProperty, book.getId());
    console.log('FirstCome claims: ' + book.getUrl());
    return book.getId();
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var callback = params.callback || '';
  if (callback && !/^fc_jsonp_[a-f0-9]{32}$/.test(callback)) {
    return output_({ ok: false, code: 'bad_callback', message: 'Invalid callback.' });
  }
  var result;
  try {
    var source = source_(params.sheet);
    if (params.action === 'list') {
      var items = publicItems_(source);
      var records = records_(state_());
      var taken = {};
      records.forEach(function (row) {
        if (row[1] === source.listId && row[3] === 'claimed') taken[row[2]] = true;
      });
      result = {
        ok: true,
        listId: source.listId,
        items: items.map(function (item) {
          return { id: item.id, label: item.label, number: item.number, available: !taken[item.id] };
        }),
        updatedAt: new Date().toISOString()
      };
    } else if (params.action === 'status') {
      var tokenHash = tokenHash_(params.token);
      var receipt = records_(state_()).find(function (row) {
        return row[0] === tokenHash && row[1] === source.listId;
      });
      result = receipt ? receipt_(receipt) : { ok: true, status: 'pending' };
    } else {
      throw error_('bad_action', 'Use list or status. Claims require POST.');
    }
  } catch (error) {
    result = failure_(error);
  }
  return output_(result, callback);
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  try {
    if (params.action !== 'claim') throw error_('bad_action', 'Unknown action.');
    return output_(claim_(params));
  } catch (error) {
    return output_(failure_(error));
  }
}

function claim_(params) {
  var source = source_(params.sheet);
  var tokenHash = tokenHash_(params.token);
  if (!/^[a-f0-9]{64}$/.test(params.itemId || '')) throw error_('bad_item', 'Invalid option.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(FIRSTCOME.lockWaitMs)) {
    // No outcome was committed. The caller may retry the same token.
    throw error_('busy', 'The list is busy. Please try again.');
  }
  try {
    var sheet = state_();
    var records = records_(sheet);
    var existing = records.find(function (row) { return row[0] === tokenHash; });
    if (existing) {
      if (existing[1] !== source.listId || existing[2] !== params.itemId) {
        throw error_('token_reused', 'Use a new receipt token for a different option.');
      }
      return receipt_(existing);
    }
    if (records.length >= FIRSTCOME.maxReceipts) {
      throw error_('capacity', 'The organiser needs to archive old claims before continuing.');
    }

    var status, url = '', message = '';
    var taken = records.some(function (row) {
      return row[1] === source.listId && row[2] === params.itemId && row[3] === 'claimed';
    });
    if (taken) {
      status = 'taken';
      message = 'Someone else has already chosen this option.';
    } else {
      try {
        // Re-read the anonymous public source while holding the lock. Never trust
        // the browser to supply a destination or the current availability.
        var item = publicItems_(source).find(function (entry) { return entry.id === params.itemId; });
        if (!item) {
          status = 'changed';
          message = 'This option has changed. Refresh the list and choose again.';
        } else {
          status = 'claimed';
          url = item.url;
        }
      } catch (error) {
        status = 'error';
        message = failure_(error).message;
      }
    }
    var row = [tokenHash, source.listId, params.itemId, status, url, message, new Date().toISOString()];
    sheet.appendRow(row);
    // Flush before releasing the lock: the next claimant must see this write.
    SpreadsheetApp.flush();
    return receipt_(row);
  } finally {
    lock.releaseLock();
  }
}

function state_() {
  var id = PropertiesService.getScriptProperties().getProperty(FIRSTCOME.stateProperty);
  if (!id) throw error_('not_configured', 'The organiser must run setup() in Apps Script first.');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(FIRSTCOME.sheetName);
  if (!sheet) throw error_('not_configured', 'The private Claims sheet is missing.');
  return sheet;
}

function records_(sheet) {
  var count = sheet.getLastRow();
  return count > 1 ? sheet.getRange(2, 1, count - 1, 7).getValues() : [];
}

function receipt_(row) {
  var result = { ok: true, status: row[3], itemId: row[2] };
  if (row[3] === 'claimed') result.url = row[4];
  if (row[5]) result.message = row[5];
  return result;
}

function source_(value) {
  if (typeof value !== 'string' || value.length > 2000) throw error_('bad_sheet', 'Provide a Google Sheets share link.');
  var match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/(?:edit|view|preview|export))?\/?(?:\?([^#]*))?(?:#(.*))?$/.exec(value.trim());
  if (!match) throw error_('bad_sheet', 'Use a Google Sheets share link containing /spreadsheets/d/. Published /d/e/ links are not supported.');
  var queryGid = parameter_(match[2] || '', 'gid');
  var hashGid = parameter_(match[3] || '', 'gid');
  if (queryGid !== null && hashGid !== null && queryGid !== hashGid) {
    throw error_('bad_sheet', 'The Google Sheets link contains conflicting tab IDs.');
  }
  var gid = queryGid !== null ? queryGid : (hashGid !== null ? hashGid : '0');
  if (!/^\d{1,10}$/.test(gid)) throw error_('bad_sheet', 'Invalid Google Sheets tab ID.');
  gid = String(Number(gid));
  var id = match[1];
  return {
    spreadsheetId: id,
    gid: gid,
    listId: digest_(id + ':' + gid),
    csvUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=csv&gid=' + gid
  };
}

function parameter_(text, name) {
  var values = text.split('&').filter(function (pair) { return pair.split('=')[0] === name; });
  if (values.length > 1) throw error_('bad_sheet', 'Duplicate tab ID in the Google Sheets link.');
  if (!values.length) return null;
  try { return decodeURIComponent(values[0].slice(name.length + 1)); }
  catch (_) { throw error_('bad_sheet', 'Invalid Google Sheets link.'); }
}

function publicItems_(source) {
  // No OAuth header: only sheets readable by an anonymous visitor can be used.
  // The exact host and export path are constructed here, never supplied directly.
  var response = UrlFetchApp.fetch(source.csvUrl, { muteHttpExceptions: true, followRedirects: true });
  if (response.getResponseCode() !== 200) {
    throw error_('sheet_unavailable', 'The sheet could not be read. Set sharing to Anyone with the link, Viewer, and check the tab ID.');
  }
  var text = response.getContentText('UTF-8').replace(/^\uFEFF/, '');
  if (text.length > FIRSTCOME.maxSourceBytes) throw error_('sheet_too_large', 'Use a sheet smaller than 500 KB.');
  if (/^\s*<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(text)) throw error_('sheet_unavailable', 'Google returned a sign-in page. The sheet must be publicly readable.');
  var rows;
  try { rows = Utilities.parseCsv(text); }
  catch (_) { throw error_('bad_csv', 'The spreadsheet could not be read as CSV.'); }
  var items = [], seen = {};
  rows.forEach(function (row, index) {
    var label = String(row[0] || '').trim();
    var url = String(row[1] || '').trim();
    if (!label && !url && row.slice(2).every(function (cell) { return !String(cell).trim(); })) return;
    if (index === 0 && /^(label|text|title|name|option|item|beschreibung|titel|bezeichnung)$/i.test(label) && /^(url|link|destination|ziel|adresse)$/i.test(url)) return;
    if (row.slice(2).some(function (cell) { return String(cell).trim(); })) throw error_('bad_columns', 'Use only two columns: label and URL.');
    if (!label || label.length > 500) throw error_('bad_label', 'Every option needs a label of 1–500 characters. Check row ' + (index + 1) + '.');
    if (!safeUrl_(url)) throw error_('bad_url', 'Every option needs a complete http:// or https:// URL. Check row ' + (index + 1) + '.');
    var id = digest_(JSON.stringify([label, url]));
    if (seen[id]) throw error_('duplicate_item', 'Two options have the same label and URL. Give them distinct labels.');
    seen[id] = true;
    items.push({ id: id, label: label, url: url, number: items.length + 1 });
  });
  if (items.length > FIRSTCOME.maxItems) throw error_('too_many_items', 'Use at most ' + FIRSTCOME.maxItems + ' options per sheet.');
  return items;
}

function safeUrl_(value) {
  return typeof value === 'string' && value.length <= 4000 &&
    /^https?:\/\/(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/.test(value) &&
    !/[\u0000-\u0020\u007f]/.test(value);
}

function tokenHash_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,128}$/.test(token)) {
    throw error_('bad_token', 'Invalid receipt token.');
  }
  return digest_(token);
}

function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}

function error_(code, message) {
  var error = new Error(message);
  error.firstComeCode = code;
  return error;
}

function failure_(error) {
  if (error && error.firstComeCode) return { ok: false, code: error.firstComeCode, message: error.message };
  console.error(error && error.stack ? error.stack : error);
  return { ok: false, code: 'server_error', message: 'The service is temporarily unavailable. Please try again.' };
}

function output_(result, callback) {
  var json = JSON.stringify(result).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return ContentService.createTextOutput(callback ? callback + '(' + json + ');' : json)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
