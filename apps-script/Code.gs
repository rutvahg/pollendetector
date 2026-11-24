/**
 * Pollen Check – sync backend (Google Apps Script)
 *
 * Saves photos to a Google Drive folder and results to a Google Sheet in YOUR account.
 *
 * One-time setup:
 *   1. Run setup() once from the editor (Run ▸ setup). It creates the folder, the sheet and a
 *      secret key, and prints them in the Execution log.
 *   2. Deploy ▸ New deployment ▸ Web app. Execute as: Me. Who has access: Anyone.
 *   3. Paste the web app URL (ends in /exec) and the secret key into the app's Settings.
 *   After editing this code, Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version.
 *
 * Script Properties used (Project Settings ▸ Script Properties):
 *   FOLDER_ID    Drive folder for photos
 *   SHEET_ID     Spreadsheet for results
 *   SYNC_SECRET  Shared secret the app must send
 */

var SHEET_NAME = 'Pollen log';
var HEADERS = [
  'Capture ID', 'Captured at', 'Synced at', 'Level', 'Grains per cm²', 'Grain count', 'Confidence',
  'Dominant type', 'Tree %', 'Grass %', 'Weed %', 'Other %', 'Latitude', 'Longitude',
  'Photo link', 'Source', 'App version'
];
var PHOTO_COL = HEADERS.indexOf('Photo link') + 1;
var MAX_PHOTO_BASE64_CHARS = 20 * 1024 * 1024; // ~15 MB image
var LEVELS = ['Low', 'Medium', 'High', 'Unclear'];

/** Run once from the editor. Safe to run again: it only creates what's missing. */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var folderId = props.getProperty('FOLDER_ID');
  if (!folderId) {
    folderId = DriveApp.createFolder('Pollen samples').getId();
    props.setProperty('FOLDER_ID', folderId);
  }
  var sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) {
    sheetId = SpreadsheetApp.create('Pollen log').getId();
    props.setProperty('SHEET_ID', sheetId);
  }
  var secret = props.getProperty('SYNC_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SYNC_SECRET', secret);
  }
  getSheet_();

  Logger.log('Drive folder: ' + DriveApp.getFolderById(folderId).getUrl());
  Logger.log('Sheet:        ' + SpreadsheetApp.openById(sheetId).getUrl());
  Logger.log('Secret key (paste into the app): ' + secret);
  Logger.log('Next: Deploy ▸ New deployment ▸ Web app (Execute as: Me, Who has access: Anyone).');
}

/** Health check: open the /exec URL in a browser to see {"ok":true,...}. */
function doGet() {
  return json_({ ok: true, service: 'pollen-check-sync', version: 1 });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!checkSecret_(body.secret)) return json_({ ok: false, error: 'unauthorized' });

    if (body.action === 'ping') {
      var props = PropertiesService.getScriptProperties();
      return json_({
        ok: true,
        folderUrl: DriveApp.getFolderById(requireProp_(props, 'FOLDER_ID')).getUrl(),
        sheetUrl: SpreadsheetApp.openById(requireProp_(props, 'SHEET_ID')).getUrl()
      });
    }
    if (body.action === 'sync') return json_(handleSync_(body));
    return json_({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  } catch (err) {
    return json_({ ok: false, error: err.code || 'server_error', message: String(err && err.message || err) });
  }
}

function handleSync_(b) {
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.id)) throw fail_('bad_request', 'Missing or invalid id.');
  var captured = new Date(b.capturedAt);
  if (isNaN(captured.getTime())) throw fail_('bad_request', 'Missing or invalid capturedAt.');
  if (LEVELS.indexOf(b.level) === -1) throw fail_('bad_request', 'Invalid level.');
  if (b.photo != null && (typeof b.photo !== 'string' || b.photo.length > MAX_PHOTO_BASE64_CHARS)) {
    throw fail_('bad_request', 'Photo is missing or too large.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw fail_('busy', 'The script is busy – will retry.');
  try {
    var sheet = getSheet_();

    // No duplicates: the same capture ID returns the existing row.
    var existing = findRow_(sheet, b.id);
    if (existing) return { ok: true, id: b.id, row: existing.row, photoUrl: existing.photoUrl, duplicate: true };

    var photoUrl = '';
    if (b.photo) photoUrl = savePhoto_(b, captured);

    var bd = b.breakdown || {};
    sheet.appendRow([
      b.id,
      captured,
      new Date(),
      b.level,
      num_(b.grainsPerCm2),
      num_(b.grainCount),
      text_(b.confidence),
      text_(b.dominantType),
      num_(bd.tree), num_(bd.grass), num_(bd.weed), num_(bd.other),
      num_(b.lat), num_(b.lng),
      photoUrl,
      text_(b.source),
      text_(b.appVersion)
    ]);
    SpreadsheetApp.flush();
    return { ok: true, id: b.id, row: sheet.getLastRow(), photoUrl: photoUrl };
  } finally {
    lock.releaseLock();
  }
}

function savePhoto_(b, captured) {
  var props = PropertiesService.getScriptProperties();
  var folder = DriveApp.getFolderById(requireProp_(props, 'FOLDER_ID'));
  var tz = Session.getScriptTimeZone();
  var name = 'pollen_' + Utilities.formatDate(captured, tz, 'yyyy-MM-dd_HHmmss') + '_' + b.id + '.jpg';

  // If an earlier attempt saved the photo but not the row, reuse that file.
  var same = folder.getFilesByName(name);
  if (same.hasNext()) return same.next().getUrl();

  var base64 = b.photo.replace(/^data:image\/\w+;base64,/, '');
  var bytes = Utilities.base64Decode(base64);
  return folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name)).getUrl();
}

function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.openById(requireProp_(props, 'SHEET_ID'));
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    var sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheet = sheets[0].setName(SHEET_NAME);
    } else {
      sheet = ss.insertSheet(SHEET_NAME);
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.getRange('B:C').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sheet;
}

function findRow_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var cell = sheet.getRange(2, 1, last - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!cell) return null;
  var row = cell.getRow();
  return { row: row, photoUrl: String(sheet.getRange(row, PHOTO_COL).getValue() || '') };
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw fail_('bad_request', 'Empty request.');
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw fail_('bad_request', 'Request body is not valid JSON.');
  }
}

function checkSecret_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function requireProp_(props, key) {
  var v = props.getProperty(key);
  if (!v) throw fail_('not_configured', key + ' is not set. Run setup() in the Apps Script editor.');
  return v;
}

/** Numbers stay numbers; anything else becomes an empty cell. */
function num_(v) {
  return typeof v === 'number' && isFinite(v) ? v : '';
}

/** Short text, with spreadsheet-formula characters neutralised. */
function text_(v) {
  if (v == null) return '';
  var s = String(v).slice(0, 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fail_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
