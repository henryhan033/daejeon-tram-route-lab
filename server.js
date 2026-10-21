import {loadTramGraph, rideParameters} from './lib/tram-graph.js';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const BUS_CACHE_PATH = path.join(DATA_DIR, 'tago-daejeon-bus-cache-v3.json');
const STOP_COORD_CACHE_PATH = path.join(DATA_DIR, 'tago-daejeon-stop-coordinates-v1.json');
const TRAM_CACHE_PATH = path.join(DATA_DIR, 'tram-stations-cache.json');

function loadEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}
const fileEnv = loadEnv(path.join(__dirname, '.env'));
function isConfiguredKey(key) { return Boolean(key && !String(key).includes('여기에_') && !String(key).includes('YOUR_')); }
function pickConfiguredKey(...candidates) {
  return candidates.map(value => String(value || '').trim()).find(isConfiguredKey) || '';
}
const COMMON_BUS_API_KEY = pickConfiguredKey(process.env.TAGO_BUS_API_KEY, process.env.DATA_GO_KR_SERVICE_KEY, process.env.SERVICE_KEY, fileEnv.TAGO_BUS_API_KEY, fileEnv.DATA_GO_KR_SERVICE_KEY, fileEnv.SERVICE_KEY);
// Keep separate credentials available in case the portal configures different credentials per API product.
// If the two products share one general service key, the common key is used as fallback.
const BUS_ROUTE_API_KEY = pickConfiguredKey(process.env.TAGO_BUS_ROUTE_API_KEY, fileEnv.TAGO_BUS_ROUTE_API_KEY, COMMON_BUS_API_KEY);
const BUS_ROUTE_STOPS_API_KEY = pickConfiguredKey(process.env.TAGO_BUS_ROUTE_STOPS_API_KEY, fileEnv.TAGO_BUS_ROUTE_STOPS_API_KEY, COMMON_BUS_API_KEY);
// 2026-04-20 official guide for dataset 15142030 uses /1613000/BusRoute/getBusRoute,
// opr_ymd, ctpv_cd, and dataType. Daejeon province code is 30 (not legacy TAGO cityCode 25).
const CITY_CODE = String(process.env.TAGO_CTPV_CD || fileEnv.TAGO_CTPV_CD || '30').trim();
const OPERATION_DATE = String(process.env.TAGO_OPERATION_DATE || fileEnv.TAGO_OPERATION_DATE || '20260101').trim();
const PORT = Number(process.env.PORT || fileEnv.PORT || 3024);
// Address/place lookup uses public OpenStreetMap/Transitous geocoders; no API key required.
// Transitous / MOTIS routing and geocoding: no API key required.
const TRANSITOUS_PLAN_URL = String(process.env.TRANSITOUS_PLAN_URL || fileEnv.TRANSITOUS_PLAN_URL || 'https://api.transitous.org/api/v6/plan').trim();
const TRANSITOUS_GEOCODE_URL = String(process.env.TRANSITOUS_GEOCODE_URL || fileEnv.TRANSITOUS_GEOCODE_URL || 'https://api.transitous.org/api/v1/geocode').trim();
const TRANSITOUS_CACHE_TTL_MS = 10 * 60 * 1000;
const TRANSITOUS_GEOCODE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const transitousRouteCache = new Map();
const transitousGeocodeCache = new Map();
// Public Nominatim must be queried politely: serialize requests with at least 1 s between calls.
let lastNominatimGeocodeAt = 0;
let nominatimGeocodeQueue = Promise.resolve();
const ROUTE_LIST_ENDPOINT = (process.env.TAGO_BUS_ROUTE_ENDPOINT || fileEnv.TAGO_BUS_ROUTE_ENDPOINT || 'https://apis.data.go.kr/1613000/BusRoute/getBusRoute').trim();
// Exact endpoint from the uploaded official guide for dataset 15142031 (v1.2, 2026-04-20).
const ROUTE_STOP_ENDPOINT = (process.env.TAGO_BUS_ROUTE_STOPS_ENDPOINT || fileEnv.TAGO_BUS_ROUTE_STOPS_ENDPOINT || 'https://apis.data.go.kr/1613000/BusRoutespecificStopInformation/getBusRoutespecificStopInformation').trim();
// New route-stop data lists order/name/IDs, but its guide does not specify GPS coordinates.
// Match the rows against TAGO's official stop coordinate list, reusing the same key (with its own application).
const BUS_STOP_COORD_API_KEY = pickConfiguredKey(process.env.TAGO_BUS_STOP_COORD_API_KEY, fileEnv.TAGO_BUS_STOP_COORD_API_KEY, BUS_ROUTE_API_KEY, COMMON_BUS_API_KEY);
const BUS_STOP_COORD_ENDPOINT = (process.env.TAGO_BUS_STOP_COORD_ENDPOINT || fileEnv.TAGO_BUS_STOP_COORD_ENDPOINT || 'https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getSttnNoList').trim();
const BUS_STOP_COORD_CITY_CODE = String(process.env.TAGO_BUS_STOP_CITY_CODE || fileEnv.TAGO_BUS_STOP_CITY_CODE || '25').trim();
// Daejeon city bounding box for this prototype (approximate rectangle, not cadastral boundary).
const DAEJEON_GEO_BOUNDS = { minLat: 36.20, maxLat: 36.50, minLon: 127.23, maxLon: 127.55 };
function isInsideDaejeonBounds(lat, lon) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) &&
    Number(lat) >= DAEJEON_GEO_BOUNDS.minLat && Number(lat) <= DAEJEON_GEO_BOUNDS.maxLat &&
    Number(lon) >= DAEJEON_GEO_BOUNDS.minLon && Number(lon) <= DAEJEON_GEO_BOUNDS.maxLon;
}

const DAEJEON_SGG_CODES = [
  { code: '30110', name: '동구' },
  { code: '30140', name: '중구' },
  { code: '30170', name: '서구' },
  { code: '30200', name: '유성구' },
  { code: '30230', name: '대덕구' }
];
let discoveredStopEndpoint = ROUTE_STOP_ENDPOINT;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

const STATIONS = [
  {id:201,name:'서대전역',search:'서대전역'},
  {id:202,name:'서대전네거리(서대전공원)',search:'서대전네거리'},
  {id:203,name:'대사(충남대병원)',search:'충남대학교병원 대전'},
  {id:204,name:'보문산공원(대전한화생명볼파크)',search:'대전한화생명볼파크'},
  {id:205,name:'인동(동부경찰서)',search:'대전 동부경찰서'},
  {id:206,name:'대전역(중앙시장)',search:'대전역 중앙시장'},
  {id:207,name:'대전역(혁신도시)',search:'대전역 동광장'},
  {id:208,name:'대동(하늘공원)',search:'대동역 대전'},
  {id:209,name:'자양(우송대·대전대)',search:'우송대학교 대전'},
  {id:210,name:'가양(동대전도서관·대전보건대·한국폴리텍대)',search:'대전보건대학교'},
  {id:211,name:'대전복합터미널',search:'대전복합터미널'},
  {id:212,name:'용전(대전문학관)',search:'대전문학관'},
  {id:213,name:'중리(중리시장)',search:'중리시장 대전'},
  {id:214,name:'오정(한남대)',search:'한남대학교 대전'},
  {id:215,name:'오정농수산물시장',search:'오정농수산물도매시장'},
  {id:216,name:'둔산',search:'재뜰네거리 대전'},
  {id:217,name:'샘머리공원(법원·검찰청·경찰청)',search:'샘머리공원 대전'},
  {id:218,name:'정부청사(서구청·둔산경찰서·을지대병원)',search:'정부대전청사'},
  {id:219,name:'둔산선사유적지(방위사업청)',search:'둔산선사유적지'},
  {id:220,name:'만년(한밭수목원·예술의전당)',search:'한밭수목원'},
  {id:221,name:'국립중앙과학관(엑스포과학공원)',search:'국립중앙과학관'},
  {id:222,name:'구성(카이스트)',search:'한국과학기술원 KAIST 대전'},
  {id:223,name:'유성구청(유림공원)',search:'유림공원 대전'},
  {id:224,name:'궁동(충남대)',search:'충남대학교 정문'},
  {id:225,name:'유성온천(유성온천공원)',search:'유성온천역'},
  {id:226,name:'상대',search:'대전상대초등학교'},
  {id:227,name:'원골',search:'원골네거리 대전'},
  {id:228,name:'대전시립박물관',search:'대전시립박물관'},
  {id:229,name:'도안(목원대)',search:'목원대학교'},
  {id:230,name:'용계',search:'용계동 대전'},
  {id:231,name:'대정',search:'대전 대정동'},
  {id:232,name:'원앙네거리(어린이재활병원)',search:'원앙네거리 대전'},
  {id:233,name:'관저네거리',search:'관저네거리 대전'},
  {id:234,name:'관저(건양대병원)',search:'건양대학교병원 대전'},
  {id:235,name:'가수원네거리',search:'가수원네거리'},
  {id:236,name:'정림삼거리(정림공원)',search:'정림삼거리 대전'},
  {id:237,name:'도마·복수(서부경찰서·대전과기대·배재대)',search:'배재대학교 대전'},
  {id:238,name:'도마네거리(도마큰시장)',search:'도마큰시장 대전'},
  {id:239,name:'버드내네거리',search:'버드내네거리 대전'},
  {id:240,name:'유천(유천시장)',search:'유천시장 대전'},
  {id:241,name:'동춘당(법동시장·근로복지공단대전병원)',search:'동춘당공원'},
  {id:242,name:'법동(대전지방국세청·대덕경찰서)',search:'대덕경찰서'},
  {id:243,name:'읍내(계족산)',search:'읍내동 대전'},
  {id:244,name:'연축(대덕구청·수자원공사)',search:'대덕구청'},
  {id:245,name:'진잠네거리(구봉산)',search:'진잠네거리 대전'}
];

const busState = { status: 'idle', progress: 0, total: 0, step: '', error: null, routeCount: 0, stopCount: 0, fromCache: false };
const tramState = { status: 'idle', progress: 0, total: STATIONS.length, step: '', error: null, available: 0, fromCache: false };
let busDataset = null;
let graphCache = null;
let busLoadPromise = null;
let tramLoadPromise = null;
let tramCache = {};
let lastTransitousGeocodeAt = 0;
let transitousGeocodeQueue = Promise.resolve();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function decodeXml(value) {
  return String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).trim();
}
// A small XML parser for the simple Daejeon public-data API response shape; no third-party package required.
function parseXml(xml) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\/?\s*>|[^<]+/g;
  let match;
  while ((match = tokenRe.exec(String(xml)))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) continue;
    if (token.startsWith('<![CDATA[')) { stack[stack.length - 1].text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      const name = token.slice(2).split(/[\s>]/)[0];
      for (let i = stack.length - 1; i > 0; i--) { if (stack[i].name === name) { stack.length = i; break; } }
      continue;
    }
    if (token.startsWith('<')) {
      const name = token.slice(1).match(/^[A-Za-z_][\w:.-]*/)?.[0];
      if (!name) continue;
      const node = { name, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }
    stack[stack.length - 1].text += decodeXml(token);
  }
  return root;
}
function walkNodes(node, out = []) { out.push(node); for (const child of node.children || []) walkNodes(child, out); return out; }
function firstText(root, tag) {
  const node = walkNodes(root, []).find(n => n.name?.toLowerCase() === tag.toLowerCase() && !(n.children || []).length);
  return node ? String(node.text || '').trim() : '';
}
function leafEntries(node, out = []) {
  if (!node.children?.length) { if (node.name && node.name !== '#document' && String(node.text || '').trim()) out.push([node.name.replace(/^.*:/, '').toUpperCase(), String(node.text).trim()]); return out; }
  for (const child of node.children) leafEntries(child, out);
  return out;
}
function recordRows(root, marker) {
  const nodes = walkNodes(root, []);
  const candidates = [];
  const fieldCache = new Map();
  const fieldsFor = n => { if (!fieldCache.has(n)) fieldCache.set(n, leafEntries(n, [])); return fieldCache.get(n); };
  const containsMarker = n => fieldsFor(n).some(([k]) => k === marker);
  function choose(node) {
    if (!containsMarker(node)) return;
    const childRecords = (node.children || []).filter(child => containsMarker(child) && fieldsFor(child).length >= 3);
    if (childRecords.length) { for (const child of childRecords) choose(child); return; }
    const entries = fieldsFor(node);
    if (entries.length < 3) { for (const child of node.children || []) choose(child); return; }
    const row = {};
    for (const [key, value] of entries) row[key] = value;
    candidates.push(row);
  }
  const body = nodes.find(n => n.name.toLowerCase() === 'msgbody') || root;
  choose(body);
  // Some response versions omit msgBody container and wrap each record in a list node.
  if (!candidates.length) {
    for (const node of nodes) {
      const entries = fieldsFor(node);
      if (entries.length >= 3 && entries.some(([key]) => key === marker)) {
        const row = {}; for (const [key, value] of entries) row[key] = value;
        if (!candidates.some(old => old[marker] === row[marker] && old.ROUTE_CD === row.ROUTE_CD && old.BUSSTOP_SEQ === row.BUSSTOP_SEQ)) candidates.push(row);
      }
    }
  }
  return candidates;
}
function firstField(row, names) { for (const name of names) { const v = row[String(name).toUpperCase()]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); } return ''; }
function numField(row, names, fallback = NaN) { const v = Number(firstField(row, names).replace(/,/g, '')); return Number.isFinite(v) ? v : fallback; }

function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}
function objectRows(payload) {
  const response = payload?.response || payload?.Response || payload;
  const body = response?.body || response?.Body || payload?.body || {};
  const items = body?.items ?? body?.Items ?? {};
  const item = items?.item ?? items?.Item ?? (Array.isArray(items) ? items : null);
  return { response, body, rows: asArray(item).filter(x => x && typeof x === 'object'), totalCount: Number(body?.totalCount ?? body?.totalcount ?? 0) };
}
function dataGovErrorFromPayload(payload) {
  const standardResponse = payload?.response || payload?.Response || payload;
  const standardHeader = standardResponse?.header || standardResponse?.Header || {};
  const portalHeader = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader || payload?.openAPI_ServiceResponse?.cmmMsgHeader || {};
  const code = String(portalHeader?.returnReasonCode ?? standardHeader?.resultCode ?? standardHeader?.resultcode ?? standardHeader?.code ?? '');
  const errText = String(portalHeader?.errMsg ?? standardHeader?.resultMsg ?? standardHeader?.resultmsg ?? standardHeader?.message ?? '');
  const authText = String(portalHeader?.returnAuthMsg ?? '');
  const message = authText || errText;
  const knownSuccess = ['00', '0', '200', 'NORMAL SERVICE'].includes(code.toUpperCase());
  const isServiceError = Boolean(code && !knownSuccess) || /SERVICE_KEY_IS_NOT_REGISTERED_ERROR|SERVICE_ACCESS_DENIED_ERROR|NO_OPENAPI_SERVICE_ERROR|INVALID_REQUEST_PARAMETER_ERROR|SERVICE_KEY_IS_NULL/i.test(errText);
  if (isServiceError) {
    const e = new Error(`국토교통부 공공데이터 API 오류${code ? ` ${code}` : ''}: ${message || errText || '응답 오류'}${/SERVICE_KEY_IS_NOT_REGISTERED_ERROR|등록되지 않은 서비스키/i.test(`${errText} ${message}`) ? ' (인증키 또는 해당 API 활용신청 상태를 확인하세요.)' : ''}`);
    e.status = 502;
    e.detail = { code, message: message || errText, portalCode: String(portalHeader?.returnReasonCode || '') };
    return e;
  }
  if (payload?.error || (payload?.message && !standardResponse?.body)) {
    const messageText = String(payload?.error?.message || payload?.message || payload?.error || 'API 요청 실패');
    const e = new Error(`국토교통부 공공데이터 API 오류: ${messageText}`); e.status = 502; e.detail = { message: messageText }; return e;
  }
  return null;
}
function dataGovRows(payload) {
  // The public-data gateway generally wraps records under response.body.items.item,
  // but keep tolerant to list/body casing variants in the supplied guide's API.
  const parsed = objectRows(payload);
  if (parsed.rows.length || parsed.totalCount) return parsed;
  const arrays = [];
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      if (obj.length && obj.every(v => v && typeof v === 'object' && !Array.isArray(v))) arrays.push(obj);
      for (const v of obj) visit(v);
      return;
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(payload);
  const rows = arrays.sort((a,b) => b.length-a.length)[0] || [];
  let totalCount = 0;
  const visitCount = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (String(key).toLowerCase() === 'totalcount' && Number.isFinite(Number(value))) totalCount = Math.max(totalCount, Number(value));
      else if (value && typeof value === 'object') visitCount(value);
    }
  };
  visitCount(payload);
  return { response: payload?.response || payload, body: {}, rows, totalCount: totalCount || rows.length };
}
function dataGovXmlToPayload(raw) {
  const xml = parseXml(raw);
  const converted = xmlNodeToObject(xml.children?.[0] || xml);
  const err = dataGovErrorFromPayload(converted);
  if (err) throw err;
  const result = dataGovRows(converted);
  if (!result.rows.length && !result.totalCount) {
    const oldRows = recordRows(xml, 'RTE_ID').length ? recordRows(xml, 'RTE_ID') : recordRows(xml, 'STTN_ID');
    if (oldRows.length) return { response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' } }, body: {}, rows: oldRows, totalCount: oldRows.length };
    const message = firstText(xml, 'resultMsg') || firstText(xml, 'errMsg') || firstText(xml, 'message');
    if (message) { const e = new Error(`국토교통부 공공데이터 API 응답: ${message}`); e.status=502; throw e; }
  }
  return result;
}
function buildDataGovUrl(endpoint, apiKey, params = {}) {
  const url = new URL(endpoint);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('pageNo', String(params.pageNo ?? 1));
  url.searchParams.set('numOfRows', String(params.numOfRows ?? 1000));
  // Parameter names and casing follow the uploaded official 2026-04-20 guides.
  url.searchParams.set('opr_ymd', String(params.opr_ymd ?? OPERATION_DATE));
  url.searchParams.set('ctpv_cd', String(params.ctpv_cd ?? CITY_CODE));
  url.searchParams.set('dataType', 'JSON');
  const routeId = params.rte_id ?? params.RTE_ID ?? params.routeId;
  if (routeId !== undefined && routeId !== null && String(routeId).trim()) url.searchParams.set('rte_id', String(routeId));
  const sggCode = params.sgg_cd ?? params.SGG_CD ?? params.sggCode;
  if (sggCode !== undefined && sggCode !== null && String(sggCode).trim()) url.searchParams.set('sgg_cd', String(sggCode));
  return url;
}
async function dataGovRequest(endpoint, apiKey, params = {}) {
  if (!isConfiguredKey(apiKey)) {
    const error = new Error('공공데이터포털 인증키가 설정되지 않았습니다. .env의 TAGO_BUS_ROUTE_API_KEY를 확인하세요.'); error.status=503; throw error;
  }
  const url = buildDataGovUrl(endpoint, apiKey, params);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json, application/xml, text/xml' } }); }
  catch (e) { const error = new Error(`공공데이터포털 API 연결 실패 (${new URL(endpoint).pathname}): ${e.message}`); error.status=502; throw error; }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!payload) {
    try { return dataGovXmlToPayload(raw); }
    catch (e) { if (!e.status) e.status=response.status || 502; throw e; }
  }
  const apiError = dataGovErrorFromPayload(payload);
  if (apiError) throw apiError;
  if (!response.ok) { const error = new Error(`공공데이터포털 API HTTP ${response.status}: ${JSON.stringify(payload).slice(0,220)}`); error.status=response.status; throw error; }
  return dataGovRows(payload);
}
async function dataGovFetchAll(endpoint, apiKey, params = {}, onPage) {
  const perPage = Math.min(1000, Math.max(1, Number(params.numOfRows || 1000)));
  const first = await dataGovRequest(endpoint, apiKey, { ...params, pageNo: 1, numOfRows: perPage });
  onPage?.(first);
  const rows = [...first.rows];
  const total = first.totalCount || rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  for (let pageNo=2; pageNo<=pages; pageNo++) {
    await delay(120);
    const page = await dataGovRequest(endpoint, apiKey, { ...params, pageNo, numOfRows: perPage });
    rows.push(...page.rows); onPage?.(page);
  }
  return rows;
}
function isStopRecord(row) {
  const keys = new Set(Object.keys(row || {}).map(k => k.toLowerCase()));
  const hasStop = ['sttn_id','sttn_nm','sttn_no','sttn_name','nodeid','nodenm','busstopid','busstopnm','bus_node_id','busstop_seq','sttn_seq','sttn_ord','sttn_sn','nodeord'].some(k=>keys.has(k));
  const hasRoute = ['rte_id','routeid','route_cd','busrouteid'].some(k=>keys.has(k));
  return hasStop && hasRoute;
}
async function fetchNewRouteStops(routes, onProgress) {
  const apiKey = BUS_ROUTE_STOPS_API_KEY || BUS_ROUTE_API_KEY || COMMON_BUS_API_KEY;
  if (!isConfiguredKey(apiKey)) {
    const error = new Error('버스노선별 경유정류장 API 인증키가 없습니다. .env의 TAGO_BUS_ROUTE_STOPS_API_KEY를 확인하세요.'); error.status = 503; throw error;
  }
  discoveredStopEndpoint = ROUTE_STOP_ENDPOINT;
  const allStops = [];
  // The official guide's sample marks RTE_ID optional and includes required SGG_CD.
  // Query each of Daejeon's five districts and merge the rows instead of probing guessed URLs.
  let done = 0;
  for (const district of DAEJEON_SGG_CODES) {
    const first = await dataGovRequest(ROUTE_STOP_ENDPOINT, apiKey, { sgg_cd: district.code, pageNo: 1, numOfRows: 1000 });
    allStops.push(...first.rows);
    const total = first.totalCount || first.rows.length;
    const pages = Math.max(1, Math.ceil(total / 1000));
    for (let pageNo = 2; pageNo <= pages; pageNo++) {
      await delay(120);
      const page = await dataGovRequest(ROUTE_STOP_ENDPOINT, apiKey, { sgg_cd: district.code, pageNo, numOfRows: 1000 });
      allStops.push(...page.rows);
    }
    done++;
    onProgress?.(done, DAEJEON_SGG_CODES.length);
  }
  const seen = new Set();
  const deduped = allStops.filter(row => {
    if (!isStopRecord(row)) return false;
    const key = `${firstField(row,['RTE_ID','ROUTE_ID','ROUTE_CD','routeId'])}|${firstField(row,['STTN_SEQ','STTN_ORD','NODEORD','BUSSTOP_SEQ','SEQ'])}|${firstField(row,['STTN_ID','STTN_NM','NODEID','NODENM','BUS_NODE_ID'])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!deduped.length) {
    throw new Error(`경유정류장 API 응답은 비어 있습니다. 호출경로=${ROUTE_STOP_ENDPOINT}, CTPV_CD=${CITY_CODE}, SGG_CD=${DAEJEON_SGG_CODES.map(x=>x.code).join(',')}, OPR_YMD=${OPERATION_DATE}. 활용신청·운행일자·서비스 응답을 확인하세요.`);
  }
  return deduped;
}
async function fetchNewRouteList(onPage) {
  const apiKey = BUS_ROUTE_API_KEY || COMMON_BUS_API_KEY;
  return dataGovFetchAll(ROUTE_LIST_ENDPOINT, apiKey, { numOfRows:1000 }, onPage);
}
function buildLegacyStopCoordUrl(apiKey, params = {}) {
  const url = new URL(BUS_STOP_COORD_ENDPOINT);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('pageNo', String(params.pageNo ?? 1));
  url.searchParams.set('numOfRows', String(params.numOfRows ?? 1000));
  url.searchParams.set('_type', 'json');
  url.searchParams.set('cityCode', BUS_STOP_COORD_CITY_CODE);
  return url;
}
async function legacyStopCoordRequest(apiKey, params = {}) {
  const url = buildLegacyStopCoordUrl(apiKey, params);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json, application/xml, text/xml' } }); }
  catch (e) { const error = new Error(`TAGO 정류소 좌표 API 연결 실패 (${new URL(BUS_STOP_COORD_ENDPOINT).pathname}): ${e.message}`); error.status = 502; throw error; }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!payload) {
    const xml = parseXml(raw);
    const converted = xmlNodeToObject(xml.children?.[0] || xml);
    const apiError = dataGovErrorFromPayload(converted);
    if (apiError) throw apiError;
    const parsed = dataGovRows(converted);
    if (parsed.rows.length || parsed.totalCount) return parsed;
    const message = firstText(xml, 'resultMsg') || firstText(xml, 'errMsg') || firstText(xml, 'message');
    const error = new Error(`TAGO 정류소 좌표 API 응답을 해석하지 못했습니다${message ? `: ${message}` : ''}.`); error.status = response.status || 502; throw error;
  }
  const apiError = dataGovErrorFromPayload(payload);
  if (apiError) throw apiError;
  if (!response.ok) { const error = new Error(`TAGO 정류소 좌표 API HTTP ${response.status}`); error.status = response.status; throw error; }
  return dataGovRows(payload);
}
async function fetchBusStopCoordinates(force = false) {
  if (!force && existsSync(STOP_COORD_CACHE_PATH)) {
    try {
      const cache = JSON.parse(await readFile(STOP_COORD_CACHE_PATH, 'utf8'));
      if (cache.cityCode === BUS_STOP_COORD_CITY_CODE && Array.isArray(cache.stops) && cache.stops.length && Date.now() - Number(cache.fetchedAt || 0) < 7 * 24 * 60 * 60 * 1000) return cache.stops;
    } catch { /* rebuild a stale or damaged cache */ }
  }
  const apiKey = BUS_STOP_COORD_API_KEY || BUS_ROUTE_STOPS_API_KEY || BUS_ROUTE_API_KEY || COMMON_BUS_API_KEY;
  if (!isConfiguredKey(apiKey)) throw new Error('TAGO 정류소 좌표 API 인증키가 없습니다. 기존 TAGO 인증키를 설정하세요.');
  const first = await legacyStopCoordRequest(apiKey, { pageNo: 1, numOfRows: 1000 });
  const rows = [...first.rows];
  const total = first.totalCount || rows.length;
  const pages = Math.max(1, Math.ceil(total / 1000));
  for (let pageNo = 2; pageNo <= pages; pageNo++) {
    await delay(120);
    const page = await legacyStopCoordRequest(apiKey, { pageNo, numOfRows: 1000 });
    rows.push(...page.rows);
  }
  const stops = rows.map(row => {
    const lat = nval(valFromApi(row, ['gpslati','GPS_LATI','gpsLat','lat','latitude']));
    const lon = nval(valFromApi(row, ['gpslong','GPS_LONG','gpsLong','lon','longitude','lng']));
    const id = valFromApi(row, ['nodeid','NODE_ID','STTN_ID','nodeId']);
    const name = valFromApi(row, ['nodenm','NODE_NM','STTN_NM','nodeNm']);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 36.1 || lat > 36.6 || lon < 127.1 || lon > 127.7 || !name) return null;
    return { id, name, lat, lon, cityCode: valFromApi(row, ['citycode','CITY_CODE'], BUS_STOP_COORD_CITY_CODE) };
  }).filter(Boolean);
  if (!stops.length) throw new Error(`TAGO 정류소 좌표 API에서 대전 정류소 좌표를 받지 못했습니다. ${BUS_STOP_COORD_ENDPOINT} 응답과 cityCode=${BUS_STOP_COORD_CITY_CODE}를 확인하세요.`);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STOP_COORD_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), cityCode: BUS_STOP_COORD_CITY_CODE, stops }), 'utf8');
  return stops;
}
function normalizeStopName(name) {
  return String(name || '').normalize('NFKC').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s·ㆍ,，.。/_-]/g, '').trim();
}
function enrichRouteStopsWithCoordinates(normalizedRows, coordRows) {
  const byId = new Map();
  const byName = new Map();
  for (const stop of coordRows) {
    if (stop.id) byId.set(String(stop.id).trim().toLowerCase(), stop);
    const key = normalizeStopName(stop.name);
    if (key) { if (!byName.has(key)) byName.set(key, []); byName.get(key).push(stop); }
  }
  const routeGroups = new Map();
  for (const row of normalizedRows) {
    const routeId = String(row.ROUTE_CD || '');
    if (!routeGroups.has(routeId)) routeGroups.set(routeId, []);
    routeGroups.get(routeId).push(row);
  }
  const result = [];
  for (const rows of routeGroups.values()) {
    rows.sort((a,b) => nval(a.BUSSTOP_SEQ,0) - nval(b.BUSSTOP_SEQ,0));
    let previous = null;
    for (const row of rows) {
      let match = null;
      const directLat = nval(row.GPS_LATI), directLon = nval(row.GPS_LONG);
      if (Number.isFinite(directLat) && Number.isFinite(directLon) && directLat >= 36.1 && directLat <= 36.6 && directLon >= 127.1 && directLon <= 127.7) {
        match = { lat: directLat, lon: directLon, id: row.BUS_NODE_ID, name: row.BUSSTOP_NM };
      }
      const idKey = String(row.BUS_NODE_ID || '').trim().toLowerCase();
      if (!match && idKey && byId.has(idKey)) match = byId.get(idKey);
      if (!match) {
        const key = normalizeStopName(row.BUSSTOP_NM);
        let candidates = byName.get(key) || [];
        if (!candidates.length) {
          const base = String(row.BUSSTOP_NM || '').replace(/\([^)]*\)/g, '');
          candidates = byName.get(normalizeStopName(base)) || [];
        }
        if (candidates.length === 1) match = candidates[0];
        else if (candidates.length > 1 && previous) match = candidates.slice().sort((a,b) => haversine(previous,a)-haversine(previous,b))[0];
        else if (candidates.length > 1) match = candidates[0];
      }
      if (match) {
        row.GPS_LATI = String(match.lat);
        row.GPS_LONG = String(match.lon);
        row.COORD_MATCH_SOURCE = match.id && match.id === row.BUS_NODE_ID ? 'stop_id' : 'stop_name';
        previous = { lat: match.lat, lon: match.lon };
      }
      const lat = nval(row.GPS_LATI), lon = nval(row.GPS_LONG);
      if (row.BUSSTOP_SEQ !== '' && row.BUS_NODE_ID && row.BUSSTOP_NM && Number.isFinite(lat) && Number.isFinite(lon) && lat >= 36.1 && lat <= 36.6 && lon >= 127.1 && lon <= 127.7) result.push(row);
    }
  }
  return result;
}

function valFromApi(row, names, fallback = '') {
  if (!row || typeof row !== 'object') return fallback;
  const map = new Map(Object.entries(row).map(([k,v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const value = map.get(String(name).toLowerCase());
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return fallback;
}
function normalizeTagoRoute(row) {
  const id = valFromApi(row, ['RTE_ID','routeId','routeid','ROUTE_CD','busRouteId']);
  if (!id) return null;
  return {
    ...row,
    ROUTE_CD: id,
    ROUTE_ID: id,
    ROUTE_NO: valFromApi(row, ['RTE_NO','ROUTE_NO','routeNo','routeNumber','RTE_NM','routeNm'], id),
    ROUTE_NM: valFromApi(row, ['RTE_NM','ROUTE_NM','routeName','routeNm'], ''),
    ROUTE_TP: valFromApi(row, ['RTE_TP_CD','RTE_TP_NM','routeTp','routeType','ROUTE_TP'], ''),
    DPTRE_STTN_ID: valFromApi(row, ['DPTRE_STTN_ID','DPTRE_STTN_ID','startStopId'], ''),
    DPTRE_STTN_NM: valFromApi(row, ['DPTRE_STTN_NM','startStopName'], ''),
    ARVL_STTN_ID: valFromApi(row, ['ARVL_STTN_ID','endStopId'], ''),
    ARVL_STTN_NM: valFromApi(row, ['ARVL_STTN_NM','endStopName'], ''),
    ALLO_INTERVAL: valFromApi(row, ['ALLO_INTERVAL','ALLO_INTERVAL_SAT','intervaltime','intervalTime','alloInterval','interval','busInterval'], '12'),
    BUSSTOP_CNT: valFromApi(row, ['BUSSTOP_CNT','busstopcnt','busStopCnt','stationCount'], '')
  };
}
function normalizeTagoRouteStop(row, route) {
  const routeId = valFromApi(row, ['RTE_ID','routeId','ROUTE_CD','busRouteId'], route?.ROUTE_CD || '');
  const lat = valFromApi(row, ['GPS_LATI','GPS_LAT','STTN_LAT','STTN_LATI','STTN_GPS_LATI','GPS_Y','STTN_Y','YCRD','LATI','gpslati','gpsLati','gpsLat','lat','latitude','ycoord','posy']);
  const lon = valFromApi(row, ['GPS_LONG','GPS_LON','STTN_LON','STTN_LONG','STTN_GPS_LONG','GPS_X','STTN_X','XCRD','LONG','LONGITUDE','gpslong','gpsLong','gpsLon','lon','longitude','lng','xcoord','posx']);
  const seq = valFromApi(row, ['STTN_SEQ','STTN_ORD','STTN_SN','STTN_SNO','STTN_NO','NODEORD','NODE_ORD','NODE_SEQ','BUSSTOP_SEQ','BUSSTOP_ORD','STOP_SEQ','stopSeq','seq','SEQ']);
  const stopId = valFromApi(row, ['STTN_ID','STTN_CD','NODE_ID','NODEID','BUS_NODE_ID','BUSSTOP_ID','BUS_STOP_ID','busNodeId','busStopId']);
  const stopName = valFromApi(row, ['STTN_NM','STTN_NAME','NODE_NM','NODENM','BUSSTOP_NM','BUS_STOP_NM','stopName','stationName']);
  return {
    ...row,
    ROUTE_CD: routeId,
    ROUTE_ID: routeId,
    ROUTE_NO: valFromApi(row, ['RTE_NO','ROUTE_NO','routeNo'], route?.ROUTE_NO || routeId),
    BUSSTOP_SEQ: seq,
    BUS_NODE_ID: stopId,
    BUSSTOP_NM: stopName,
    GPS_LATI: lat,
    GPS_LONG: lon
  };
}
async function loadBusDataset(force = false) {
  if (busLoadPromise) return busLoadPromise;
  if (!force && busDataset && busState.status === 'ready') return busDataset;
  busLoadPromise = (async () => {
    busState.status = 'loading'; busState.error = null; busState.progress = 0; busState.total = 0; busState.step = '국토교통부 공공데이터 버스노선 API 연결'; busState.fromCache = false;
    try {
      if (!force && existsSync(BUS_CACHE_PATH)) {
        try {
          const cached = JSON.parse(await readFile(BUS_CACHE_PATH, 'utf8'));
          if (cached.cityCode === CITY_CODE && cached.operationDate === OPERATION_DATE && cached.routes?.length && cached.routeStops?.length && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) {
            busDataset = cached; graphCache = null;
            Object.assign(busState, { status:'ready', progress:1, total:1, step:'공공데이터포털 캐시 데이터 준비 완료', routeCount:cached.routes.length, stopCount:cached.routeStops.length, fromCache:true, error:null });
            return busDataset;
          }
        } catch { /* rebuild stale or broken cache */ }
      }
      if (force) { busDataset = null; graphCache = null; }
      busState.step = `대전(CTPV_CD=${CITY_CODE}, OPR_YMD=${OPERATION_DATE}) 버스노선 목록 조회`;
      busState.total = 1;
      const routeRows = await fetchNewRouteList(() => { busState.progress++; });
      const routeMap = new Map();
      for (const raw of routeRows) {
        const route = normalizeTagoRoute(raw);
        if (route) routeMap.set(route.ROUTE_CD, route);
      }
      const routes = [...routeMap.values()];
      if (!routes.length) throw new Error(`국토교통부 버스노선 API에서 대전 노선 목록을 받지 못했습니다. API=${ROUTE_LIST_ENDPOINT}, CTPV_CD=${CITY_CODE}, OPR_YMD=${OPERATION_DATE}, 응답 행=${routeRows.length}. 해당 API 활용신청·인증키·조회일자를 확인하세요.`);
      busState.total = 1 + DAEJEON_SGG_CODES.length;
      busState.step = `대전 버스노선 ${routes.length}개 · 5개 구별 경유정류장 조회`;
      const rawStops = await fetchNewRouteStops(routes, (done,total) => { busState.progress = Math.min(busState.total, 1+done); busState.step = `경유정류장 조회 ${done}/${total}개 구`; });
      const routeById = new Map(routes.map(r => [r.ROUTE_CD, r]));
      const normalizedStopRows = rawStops.map(row => normalizeTagoRouteStop(row, routeById.get(valFromApi(row,['RTE_ID','ROUTE_ID','ROUTE_CD','routeId']))));
      const directCoordinateRows = normalizedStopRows.filter(row => Number.isFinite(nval(row.GPS_LATI)) && Number.isFinite(nval(row.GPS_LONG)));
      let coordinateRows = [];
      if (directCoordinateRows.length < normalizedStopRows.length * 0.8) {
        busState.step = 'TAGO 정류소 위치 API로 좌표 보강';
        try { coordinateRows = await fetchBusStopCoordinates(force); }
        catch (e) {
          const error = new Error(`경유정류장 API 호출 경로는 공식 가이드에 맞게 설정됐지만, 이 API 명세에는 GPS 좌표가 없어 정류소 좌표 보강이 필요합니다. ${e.message} 공공데이터포털에서 '국토교통부_(TAGO)_버스정류소정보'(15098534)의 활용신청을 완료한 뒤 같은 일반 인증키로 재실행하세요.`);
          error.status = e.status || 502; error.detail = { dependency: 'TAGO_BUS_STOP_COORD_API', endpoint: BUS_STOP_COORD_ENDPOINT }; throw error;
        }
      }
      const routeStops = enrichRouteStopsWithCoordinates(normalizedStopRows, coordinateRows);
      if (!rawStops.length) throw new Error('경유정류장 API가 빈 결과를 반환했습니다. 조회일자와 대전 코드, 해당 API의 활용신청 상태를 확인하세요.');
      if (!routeStops.length) {
        const example = rawStops[0] ? Object.keys(rawStops[0]).join(', ') : '(응답 없음)';
        throw new Error(`경유정류장 API 데이터는 받았지만 기존 TAGO 정류소 좌표 데이터와 매칭된 정류장이 없습니다. 첫 응답 필드: ${example}. STTN_ID/STTN_NM과 TAGO nodeid/nodenm의 형식을 확인하세요.`);
      }
      busDataset = { fetchedAt: Date.now(), cityCode: CITY_CODE, operationDate: OPERATION_DATE, routeEndpoint: ROUTE_LIST_ENDPOINT, routeStopsEndpoint: discoveredStopEndpoint, routes, routeStops, coordinateSource: directCoordinateRows.length >= normalizedStopRows.length * 0.8 ? 'route-stop API' : BUS_STOP_COORD_ENDPOINT, coordinateRows: coordinateRows.length };
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(BUS_CACHE_PATH, JSON.stringify(busDataset), 'utf8');
      graphCache = null;
      Object.assign(busState, { status:'ready', progress:busState.total, step:'국토교통부 공공데이터 버스 데이터 준비 완료', routeCount:routes.length, stopCount:routeStops.length, fromCache:false, error:null });
      return busDataset;
    } catch (e) {
      busState.status = 'error'; busState.error = e.message; busState.step = '데이터를 불러오지 못했습니다';
      throw e;
    } finally { busLoadPromise = null; }
  })();
  return busLoadPromise;
}
function startBusLoad(force = false) {
  if (busLoadPromise) return;
  if (!force && busDataset && busState.status === 'ready') return;
  loadBusDataset(force).catch(() => {});
}

function geocodeCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['results', 'places', 'locations', 'items', 'suggestions', 'features', 'geocoding', 'data']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = geocodeCandidates(value);
      if (nested.length) return nested;
    }
  }
  if (payload.result && typeof payload.result === 'object') return geocodeCandidates(payload.result);
  return [];
}
function normalizeGeocodeCandidate(item, query, index = 0, requestedType = 'ADDRESS,PLACE') {
  if (!item || typeof item !== 'object') return null;
  const p = item.properties && typeof item.properties === 'object' ? { ...item, ...item.properties } : item;
  const place = p.place && typeof p.place === 'object' ? p.place : p;
  const geometry = p.geometry || place.geometry || {};
  const coords = geometry?.coordinates || p.coordinates || place.coordinates;
  let lat = nval(place.lat ?? place.latitude ?? place.location?.lat ?? place.coordinate?.lat ?? p.lat ?? p.latitude);
  let lon = nval(place.lon ?? place.lng ?? place.longitude ?? place.location?.lon ?? place.location?.lng ?? place.coordinate?.lon ?? place.coordinate?.lng ?? p.lon ?? p.lng ?? p.longitude);
  // GeoJSON coordinates are [longitude, latitude].
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && Array.isArray(coords) && coords.length >= 2) {
    lon = nval(coords[0]); lat = nval(coords[1]);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) return null;

  const type = String(p.type ?? requestedType.split(',')[0] ?? 'PLACE').toUpperCase();
  const areas = Array.isArray(p.areas) ? p.areas.filter(a => a && typeof a === 'object' && a.name && a.matched !== false).map(a => String(a.name).trim()).filter(name => Boolean(name) && !/^(대한민국|한국|korea|south korea)$/i.test(name)) : [];
  const street = String(p.street ?? p.road ?? p.streetName ?? p.street_name ?? '').trim();
  const houseNumber = String(p.houseNumber ?? p.house_number ?? p.housenumber ?? '').trim();
  const locality = String(p.locality ?? p.suburb ?? p.city ?? '').trim();
  const uniqueAreas = [...new Set([...areas, locality].filter(Boolean))];
  const addressParts = [...uniqueAreas.slice(-3), [street, houseNumber].filter(Boolean).join(' ')].filter(Boolean);
  const synthesizedAddress = addressParts.join(' ');
  // Never use the search query itself as a result label: that would make an
  // unrelated coordinate appear to match the user's input.
  const fallbackName = synthesizedAddress;
  const name = String(place.name ?? p.name ?? p.mainText ?? p.main_text ?? p.label ?? p.displayName ?? p.display_name ?? p.text ?? p.description ?? fallbackName ?? '').trim();
  const address = type === 'ADDRESS' && synthesizedAddress ? synthesizedAddress : String(p.address ?? p.label ?? p.displayName ?? p.display_name ?? p.text ?? p.description ?? synthesizedAddress ?? name ?? '').trim();
  if (!name && !address) return null;
  const id = String(p.id ?? p.gid ?? p.stopId ?? p.stop_id ?? p.gtfsId ?? `${type}-${index}-${lat.toFixed(6)}-${lon.toFixed(6)}`);
  return {
    id,
    roadAddress: address,
    address,
    jibunAddress: String(p.jibunAddress ?? p.jibun_address ?? '').trim(),
    zipCode: String(p.zip ?? p.postcode ?? p.zipCode ?? p.zip_code ?? '').trim(),
    buildingName: type === 'ADDRESS' ? '' : name,
    name,
    regionLabel: uniqueAreas.join(' '),
    district: String(place.district ?? p.district ?? '').trim(),
    neighborhood: String(place.neighbourhood ?? place.neighborhood ?? p.neighbourhood ?? p.neighborhood ?? '').trim(),
    category: String(place.category ?? p.category ?? '').trim(),
    lat,
    lon,
    type,
    score: Number.isFinite(Number(p.score)) ? Number(p.score) : null,
    source: 'Transitous / MOTIS geocoding'
  };
}
async function transitousGeocodeSearch(query, limit = 8, requestedType = 'ADDRESS,PLACE') {
  const clean = String(query || '').trim();
  if (clean.length < 2) return { source: 'Transitous / MOTIS geocoding', totalCount: 0, results: [] };
  const maxResults = Math.max(1, Math.min(10, Number(limit) || 8));
  const requestedTypes = String(requestedType || '').split(',').map(t => t.trim().toUpperCase()).filter(t => ['ADDRESS', 'PLACE', 'STOP'].includes(t));
  const types = requestedTypes.length ? [...new Set(requestedTypes)] : ['ADDRESS', 'PLACE', 'STOP'];
  const cacheKey = `${clean.toLocaleLowerCase('ko-KR')}|${types.join(',') || 'ALL'}|${maxResults}`;
  const cached = transitousGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRANSITOUS_GEOCODE_CACHE_TTL_MS) return cached.value;

  const task = async () => {
    // Keep public geocoder usage polite: requests are serialized and spaced apart.
    const prefixed = /대전|daejeon/i.test(clean) ? clean : `대전광역시 ${clean}`;
    const strippedUnit = clean.replace(/\s+\d{1,4}\s*(?:동|호|층)\b/g, '').replace(/\s+/g, ' ').trim();
    const variants = [...new Set([prefixed, clean, strippedUnit && (/대전|daejeon/i.test(strippedUnit) ? strippedUnit : `대전광역시 ${strippedUnit}`)].filter(Boolean))];
    let lastError = null;

    // MOTIS' OpenAPI defines `type` as one enum value (ADDRESS, PLACE or STOP),
    // not a comma-separated list. Try each requested type separately.
    for (const typeName of types) {
      for (const searchText of variants) {
        const waitMs = 700 - (Date.now() - lastTransitousGeocodeAt);
        if (waitMs > 0) await delay(waitMs);
        lastTransitousGeocodeAt = Date.now();

        const apiUrl = new URL(TRANSITOUS_GEOCODE_URL);
        apiUrl.searchParams.set('text', searchText);
        apiUrl.searchParams.set('language', 'ko');
        apiUrl.searchParams.set('type', typeName);
        apiUrl.searchParams.set('place', '36.3504,127.3845');
        let response;
        try {
          response = await fetch(apiUrl, { headers: { Accept: 'application/json', 'User-Agent': 'DaejeonTramRouteLab/1.13.7 (free Transitous/MOTIS geocoder)' }, signal: AbortSignal.timeout(20000) });
        } catch (e) {
          lastError = new Error(`Transitous 주소/장소 검색 연결 실패: ${e.message}`);
          lastError.status = 502; lastError.code = 'TRANSITOUS_GEOCODE_NETWORK_ERROR';
          continue;
        }
        const raw = await response.text();
        let payload;
        try { payload = JSON.parse(raw); } catch { payload = { rawText: raw.slice(0, 500) }; }
        if (!response.ok) {
          lastError = new Error(`Transitous 지오코딩 HTTP ${response.status}: ${String(payload?.message || payload?.detail || payload?.rawText || raw).slice(0, 240)}`);
          lastError.status = response.status;
          lastError.code = response.status === 429 ? 'TRANSITOUS_GEOCODE_RATE_LIMITED' : 'TRANSITOUS_GEOCODE_HTTP_ERROR';
          if (response.status === 429 || response.status >= 500) break;
          continue;
        }
        const rawItems = geocodeCandidates(payload);
        const results = rawItems.map((item, i) => normalizeGeocodeCandidate(item, searchText, i, typeName)).filter(Boolean).slice(0, maxResults);
        if (results.length) {
          const addressLike = /\d|로|길|대로|번길|동\b/.test(clean);
          results.sort((a, b) => {
            const typeBonus = item => addressLike && item.type === 'ADDRESS' ? -100 : 0;
            return typeBonus(a) + (Number.isFinite(a.score) ? -a.score : 0) - (typeBonus(b) + (Number.isFinite(b.score) ? -b.score : 0));
          });
          const value = { source: 'Transitous / MOTIS geocoding', totalCount: results.length, results, queryUsed: searchText, type: typeName };
          transitousGeocodeCache.set(cacheKey, { at: Date.now(), value });
          if (transitousGeocodeCache.size > 500) {
            for (const [k, v] of transitousGeocodeCache) if (Date.now() - v.at > TRANSITOUS_GEOCODE_CACHE_TTL_MS) transitousGeocodeCache.delete(k);
          }
          return value;
        }
      }
      if (lastError?.code === 'TRANSITOUS_GEOCODE_RATE_LIMITED') break;
    }
    if (lastError) throw lastError;
    const value = { source: 'Transitous / MOTIS geocoding', totalCount: 0, results: [], queryUsed: clean, type: types.join(',') || 'ALL' };
    transitousGeocodeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };
  const promise = transitousGeocodeQueue.then(task, task);
  transitousGeocodeQueue = promise.catch(() => {});
  return promise;
}
async function transitousPlaceGeocode(query, { allowStops = true, preferPlaces = false } = {}) {
  // User-entered addresses should prefer ADDRESS; tram stop/landmark labels should prefer PLACE.
  const priority = preferPlaces ? 'PLACE,STOP,ADDRESS' : 'ADDRESS,PLACE';
  const placeResults = await transitousGeocodeSearch(query, 8, priority);
  if (placeResults.results.length) {
    const best = placeResults.results[0];
    return { lat: best.lat, lon: best.lon, name: best.name || best.roadAddress || query, address: best.roadAddress || best.address || query, source: best.source, matchType: best.type || (preferPlaces ? 'PLACE/STOP' : 'ADDRESS/PLACE') };
  }
  if (allowStops && !priority.split(',').includes('STOP')) {
    const stopResults = await transitousGeocodeSearch(query, 5, 'STOP');
    if (stopResults.results.length) {
      const best = stopResults.results[0];
      return { lat: best.lat, lon: best.lon, name: best.name || best.roadAddress || query, address: best.roadAddress || best.address || query, source: best.source, matchType: 'STOP' };
    }
  }
  const error = new Error(`Transitous에서 위치를 찾지 못했습니다: ${query}. 대전광역시를 포함한 더 구체적인 주소나 장소명을 입력해 주세요.`);
  error.status = 404; error.code = 'TRANSITOUS_GEOCODE_NO_RESULT';
  throw error;
}
function xmlNodeToObject(node) {
  if (!node?.children?.length) return String(node?.text || '').trim();
  const out = {};
  for (const child of node.children) {
    const key = String(child.name || '').replace(/^.*:/, '');
    const value = xmlNodeToObject(child);
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}
function cleanKoreanAddressQuery(query) {
  return String(query || '').trim()
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(대한민국|한국)\s+/, '')
    .trim();
}
function geoDistanceKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function normalizeOsmResult(item, index, source, query = '') {
  if (!item || typeof item !== 'object') return null;
  const props = item.properties || item;
  const coords = item.geometry?.coordinates;
  const lat = nval(item.lat ?? props.lat ?? (Array.isArray(coords) ? coords[1] : NaN));
  const lon = nval(item.lon ?? props.lon ?? props.lng ?? (Array.isArray(coords) ? coords[0] : NaN));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) return null;

  const a = item.address || {};
  const p = props;
  const roadName = String(a.road || p.street || p.road || p.streetName || '').trim();
  const houseNo = String(a.house_number || p.housenumber || p.house_number || '').trim();
  const road = [roadName, houseNo].filter(Boolean).join(' ').trim();
  const areaParts = [
    a.state || p.state || p.province,
    a.city || a.town || p.city || p.town,
    a.city_district || a.suburb || p.district || p.county,
    a.neighbourhood || a.residential || p.locality
  ].map(v => String(v || '').trim()).filter(Boolean);
  const uniqueAreaParts = [...new Set(areaParts)];
  const display = String(item.display_name || p.label || [...uniqueAreaParts, road].filter(Boolean).join(' ') || p.name || '').trim();
  const name = String(p.name || p.label || item.name || road || display).trim();
  const addressLike = looksLikeAddressQuery(query);
  const osmKey = String(p.osm_key || '').toLowerCase();
  const osmValue = String(p.osm_value || '').toLowerCase();
  const layerType = String(p.type || '').toLowerCase();
  // Photon distinguishes address layers (house/street/locality) from named OSM
  // objects. A city-qualified POI query must not turn a named building into an
  // ADDRESS just because the search text contains '대전광역시'.
  const addressLayers = new Set(['house','street','locality','district','city','county','state','country','postcode']);
  const placeKeys = new Set(['building','amenity','shop','office','tourism','leisure','historic','healthcare','public_transport','railway','craft','sport','club','industrial','military','man_made','aeroway','emergency']);
  const namedPlace = Boolean(p.name) && !addressLayers.has(layerType);
  const isPlaceFeature = placeKeys.has(osmKey) || (namedPlace && !['place','boundary','highway','addr'].includes(osmKey));
  const type = isPlaceFeature ? 'PLACE' : (addressLike ? 'ADDRESS' : (namedPlace ? 'PLACE' : 'ADDRESS'));
  // Prefer a provider's full label, otherwise assemble the location before the road name.
  const knownRoadAddress = road ? [...uniqueAreaParts, road].filter(Boolean).join(' ') : '';
  const roadAddress = knownRoadAddress || display || [ ...uniqueAreaParts, road ].filter(Boolean).join(' ') || name;
  // Do not label a road address as a parcel (jibun) address. Only retain a real parcel
  // address when the provider supplies an explicit field for it.
  const jibunAddress = String(
    item.jibunAddress ?? item.jibun_address ?? p.jibunAddress ?? p.jibun_address ??
    p.parcelAddress ?? p.parcel_address ?? a.jibunAddress ?? a.jibun_address ?? ''
  ).trim();
  const district = String(a.city_district || a.district || a.county || p.district || p.county || '').trim();
  const neighborhood = String(a.neighbourhood || a.suburb || a.quarter || p.neighbourhood || p.suburb || p.locality || '').trim();
  const city = String(a.city || a.town || a.village || p.city || p.town || p.village || '').trim();
  const regionLabel = [...new Set([city,district,neighborhood].filter(Boolean))].join(' ');
  const category = [p.osm_key || p.category || '',p.osm_value || p.type || ''].filter(Boolean).join(' / ');
  return {
    id: String(item.place_id || p.osm_id || p.gid || `${source}-${index}-${lat.toFixed(6)}-${lon.toFixed(6)}`),
    roadAddress: roadAddress || name,
    address: roadAddress || name,
    jibunAddress,
    zipCode: String(a.postcode || p.postcode || ''),
    buildingName: name,
    name: name || display,
    district, neighborhood, regionLabel, category,
    lat, lon, type, score: null, source,
    searchedAs: addressLike ? 'address' : 'place'
  };
}
async function osmGeocodeSearch(query, limit = 8) {
  const clean = cleanKoreanAddressQuery(query);
  if (clean.length < 2) return {source:'Photon / OpenStreetMap', totalCount:0, results:[]};
  const cacheKey = `osm|${clean.toLocaleLowerCase('ko-KR')}|${limit}`;
  const cached = transitousGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRANSITOUS_GEOCODE_CACHE_TTL_MS) return cached.value;

  // Search both the user-entered spelling and the Daejeon-qualified spelling.
  // This supports users entering either a road-name address (도로명) or a legacy
  // parcel/dong-lot address (지번) without requiring a provider key. The provider
  // may not expose both address labels for a given result, so we never invent one.
  const bare = clean.replace(/^대전광역시\s*/i, '').replace(/^daejeon\s*/i, '').trim();
  const qualified = /대전|daejeon/i.test(clean) ? clean : `대전광역시 ${clean}`;
  const queries = [...new Set([clean, bare, qualified].filter(q => q && q.length >= 2))];
  const fetchOne = async (q) => {
    const u = new URL('https://photon.komoot.io/api/');
    u.searchParams.set('q', q);
    u.searchParams.set('lang', 'ko');
    u.searchParams.set('limit', String(Math.max(1, Math.min(10, limit))));
    u.searchParams.set('lat', '36.3504');
    u.searchParams.set('lon', '127.3845');
    const response = await fetch(u, {
      headers: {Accept:'application/json', 'User-Agent':'DaejeonTramRouteLab/1.13.7 (origin-destination building picker)'},
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`Photon / OpenStreetMap HTTP ${response.status}`);
    const payload = await response.json();
    const raw = Array.isArray(payload) ? payload : (Array.isArray(payload.features) ? payload.features : []);
    return raw.map((item,i)=>normalizeOsmResult(item,i,'Photon / OpenStreetMap',q)).filter(Boolean);
  };
  const settled = await Promise.allSettled(queries.map(fetchOne));
  const all = [];
  let lastError = null;
  for (const item of settled) {
    if (item.status === 'fulfilled') all.push(...item.value);
    else lastError = item.reason;
  }
  const unique = new Map();
  for (const item of all) {
    const label = String(item.name || item.buildingName || item.roadAddress || item.address || '').toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g, '');
    const key = `${Number(item.lat).toFixed(5)},${Number(item.lon).toFixed(5)},${label}`;
    if (!unique.has(key)) unique.set(key, item);
    else {
      const existing = unique.get(key);
      if (!existing.jibunAddress && item.jibunAddress) existing.jibunAddress = item.jibunAddress;
      if ((!existing.roadAddress || existing.roadAddress === existing.name) && item.roadAddress) existing.roadAddress = item.roadAddress;
    }
  }
  const results = [...unique.values()].sort((a,b)=>{
    const da=geoDistanceKm(a.lat,a.lon,36.3504,127.3845);
    const db=geoDistanceKm(b.lat,b.lon,36.3504,127.3845);
    const localA=da<=35?0:1, localB=db<=35?0:1;
    return localA-localB || da-db;
  }).slice(0, Math.max(limit * 2, limit));
  if (!results.length && lastError && settled.every(x=>x.status==='rejected')) throw lastError;
  const value={source:'Photon / OpenStreetMap (원문 + 대전 지역명 병행검색)',totalCount:results.length,results,queryUsed:queries.join(' | '),searchModes:['road-address-or-parcel-address','raw-query','city-qualified-query']};
  transitousGeocodeCache.set(cacheKey,{at:Date.now(),value});
  return value;
}
function normalizeNominatimResult(item, index, query = '') {
  if (!item || typeof item !== 'object') return null;
  const lat = nval(item.lat);
  const lon = nval(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) return null;

  const a = item.address && typeof item.address === 'object' ? item.address : {};
  const city = String(a.city || a.town || a.village || a.municipality || (String(a.state || '').includes('대전') ? a.state : '') || '').trim();
  const district = String(a.city_district || a.borough || a.district || a.county || '').trim();
  const neighborhood = String(a.neighbourhood || a.neighborhood || a.suburb || a.quarter || a.hamlet || '').trim();
  const roadName = String(a.road || a.pedestrian || a.residential || a.footway || '').trim();
  const houseNumber = String(a.house_number || '').trim();
  const roadLine = [roadName, houseNumber].filter(Boolean).join(' ').trim();
  const areaParts = [...new Set([city, district, neighborhood].filter(Boolean))];
  const builtAddress = [...new Set([city, district, roadLine].filter(Boolean))].join(' ');
  const display = String(item.display_name || '').trim();
  const named = String(item.name || item.namedetails?.name || item.extratags?.name || '').trim();
  const addressType = String(item.addresstype || '').toLowerCase();
  const category = String(item.category || item.class || '').toLowerCase();
  const addressKinds = new Set(['country','state','region','county','city','town','village','municipality','city_district','suburb','neighbourhood','postcode','road','house','residential']);
  const isNamedPlace = Boolean(named) && (!addressKinds.has(addressType) || /^(amenity|shop|office|tourism|leisure|historic|healthcare|railway|public_transport|building|man_made|craft|sport|club|industrial|military|aeroway|emergency)$/.test(category));
  const type = isNamedPlace ? 'PLACE' : (looksLikeAddressQuery(query) || addressType === 'house' || roadLine ? 'ADDRESS' : 'PLACE');
  const firstDisplayPart = display.split(',')[0]?.trim() || '';
  const name = named || (type === 'ADDRESS' ? roadLine || firstDisplayPart || builtAddress : firstDisplayPart || roadLine || builtAddress);
  const address = builtAddress || display || name;
  if (!name && !address) return null;
  return {
    id: String(item.osm_type && item.osm_id ? `${item.osm_type}${item.osm_id}` : item.place_id || `nominatim-${index}-${lat.toFixed(6)}-${lon.toFixed(6)}`),
    name,
    buildingName: isNamedPlace ? (named || name) : '',
    roadAddress: address,
    address,
    // Nominatim does not reliably return Korean parcel (지번) addresses; do not fabricate them.
    jibunAddress: String(a.jibunAddress || a.jibun_address || '').trim(),
    zipCode: String(a.postcode || '').trim(),
    regionLabel: areaParts.join(' '),
    district,
    neighborhood,
    category: [category, String(item.type || '').toLowerCase()].filter(Boolean).join(' / '),
    lat,
    lon,
    type,
    score: Number.isFinite(Number(item.importance)) ? Number(item.importance) : null,
    source: 'Nominatim / OpenStreetMap'
  };
}

async function nominatimGeocodeSearch(query, limit = 8) {
  const clean = cleanKoreanAddressQuery(query);
  if (clean.length < 2) return { source: 'Nominatim / OpenStreetMap', totalCount: 0, results: [] };
  const maxResults = Math.max(1, Math.min(10, Number(limit) || 8));
  const cacheKey = `nominatim|${clean.toLocaleLowerCase('ko-KR')}|${maxResults}`;
  const cached = transitousGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRANSITOUS_GEOCODE_CACHE_TTL_MS) return cached.value;

  const bare = clean.replace(/^대전광역시\s*/i, '').replace(/^daejeon\s*/i, '').trim();
  const qualified = /대전|daejeon/i.test(clean) ? clean : `대전광역시 ${clean}`;
  const queries = [...new Set([clean, qualified, bare].filter(q => q && q.length >= 2))].slice(0, 2);
  const task = async () => {
    const results = [];
    const errors = [];
    for (const searchText of queries) {
      // Nominatim public service usage policy: keep requests serialized at >= 1 second apart.
      const waitMs = 1100 - (Date.now() - lastNominatimGeocodeAt);
      if (waitMs > 0) await delay(waitMs);
      lastNominatimGeocodeAt = Date.now();
      const apiUrl = new URL('https://nominatim.openstreetmap.org/search');
      apiUrl.searchParams.set('q', searchText);
      apiUrl.searchParams.set('format', 'jsonv2');
      apiUrl.searchParams.set('addressdetails', '1');
      apiUrl.searchParams.set('namedetails', '1');
      apiUrl.searchParams.set('extratags', '1');
      apiUrl.searchParams.set('limit', String(maxResults));
      apiUrl.searchParams.set('countrycodes', 'kr');
      apiUrl.searchParams.set('accept-language', 'ko');
      apiUrl.searchParams.set('viewbox', '127.23,36.50,127.55,36.20');
      apiUrl.searchParams.set('bounded', '1');
      try {
        const response = await fetch(apiUrl, {
          headers: { Accept: 'application/json', 'User-Agent': 'DaejeonTramRouteLab/1.13.7 (address and place search prototype)', 'Accept-Language': 'ko' },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
          errors.push(new Error(`Nominatim HTTP ${response.status}`));
          // Do not retry aggressively on rate limiting or server errors.
          if (response.status === 429 || response.status >= 500) break;
          continue;
        }
        const payload = await response.json();
        if (Array.isArray(payload)) results.push(...payload.map((item, i) => normalizeNominatimResult(item, i, searchText)).filter(Boolean));
      } catch (e) {
        errors.push(e);
      }
    }
    const unique = new Map();
    for (const item of results) {
      const label = String(item.name || item.roadAddress || '').toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g, '');
      const key = `${Number(item.lat).toFixed(5)},${Number(item.lon).toFixed(5)},${label}`;
      if (!unique.has(key)) unique.set(key, item);
      else {
        const prior = unique.get(key);
        for (const field of ['roadAddress','address','jibunAddress','buildingName','name','zipCode','regionLabel','district','neighborhood','category']) {
          if ((!prior[field] || String(prior[field]).trim() === '') && item[field]) prior[field] = item[field];
        }
      }
    }
    const value = {
      source: 'Nominatim / OpenStreetMap',
      totalCount: unique.size,
      results: [...unique.values()],
      queryUsed: queries.join(' | '),
      error: unique.size ? undefined : (errors[0]?.message || undefined)
    };
    transitousGeocodeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };
  const promise = nominatimGeocodeQueue.then(task, task);
  nominatimGeocodeQueue = promise.catch(() => {});
  return promise;
}

function looksLikeAddressQuery(query) {
  const q = cleanKoreanAddressQuery(query);
  // City/district words alone do not make a query an address; e.g. '대전광역시 미라클빌딩'
  // should rank named buildings/POIs alongside address matches. Numeric house/lot terms
  // or a road-name pattern are stronger evidence of an address query.
  return /(?:\d+\s*(?:번지|번|동|호|층)|(?:로|길|대로|번길)\s*\d+|\d+\s*(?:로|길|대로|번길)|[가-힣]+동\s+\d+)/.test(q)
    || /\d/.test(q);
}
function rankGeocodeResults(payload, query, limit = 8) {
  const results = Array.isArray(payload?.results) ? [...payload.results] : [];
  const qClean = cleanKoreanAddressQuery(query).toLocaleLowerCase('ko-KR');
  const q = qClean.replace(/[\s,.-]/g,'');
  const ignoredTokens = new Set(['대전광역시','대전','대한민국','한국','daejeon','korea','southkorea']);
  const queryTokens = qClean.split(/\s+/).map(t => t.replace(/[，,.-]/g,'')).filter(t => t && !ignoredTokens.has(t));
  const addressQuery = looksLikeAddressQuery(query);
  const resultText = item => `${item.roadAddress||''} ${item.address||''} ${item.jibunAddress||''} ${item.name||''} ${item.buildingName||''}`.toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g,'');
  const isTextRelevant = item => {
    const text = resultText(item);
    if (!queryTokens.length) return true;
    const matched = queryTokens.filter(token => text.includes(token.replace(/[\s,.-]/g,'')));
    // For a specific POI/address, unrelated matches must not be returned merely
    // because they are geographically close to the city centre.
    return matched.length > 0 && (queryTokens.length === 1 || matched.length === queryTokens.length || (addressQuery && matched.length >= 2));
  };
  const score = item => {
    const lat = Number(item.lat), lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) return -1e6;
    const text = resultText(item);
    let s = 0;
    if (text.includes(q)) s += 80;
    const matchedTokenCount = queryTokens.filter(token => text.includes(token.replace(/[\s,.-]/g,''))).length;
    if (queryTokens.length && matchedTokenCount === queryTokens.length) s += 65;
    else s += matchedTokenCount * 14;
    const queryDigits = (query.match(/\d+/g)||[]).join('');
    const resultDigits = (text.match(/\d+/g)||[]).join('');
    if (queryDigits && resultDigits.includes(queryDigits)) s += 30;
    if (addressQuery && item.type === 'ADDRESS') s += 15;
    if (!addressQuery && item.type === 'STOP') s += 15;
    // This app is built around the Daejeon tram; prefer Daejeon-area matches,
    // but do not silently discard other valid Korean results.
    const d = geoDistanceKm(lat, lon, 36.3504, 127.3845);
    if (isInsideDaejeonBounds(lat, lon)) s += 100;
    else s -= 1000; // never let an out-of-Daejeon result outrank a local result
    if (d <= 35) s += 20;
    else s -= Math.min(60, d);
    if (item.source && /OpenStreetMap|Photon/i.test(item.source) && addressQuery) s += 8;
    return s;
  };
  const relevant = results.filter(isTextRelevant);
  relevant.sort((a,b)=>score(b)-score(a));
  return {...payload, results:relevant.slice(0, Math.max(1, limit)), totalCount:relevant.length};
}
// Small verified aliases for locally important buildings that may be absent from
// free OSM/Transitous POI indexes. Coordinates are for the building address, not an
// individual tenant. Source: public business/address listings for Daejeon Miracle Building,
// Dunsan-ro 52 / Dunsan-dong 1169 (coordinates around 36.35103, 127.37972).
const KNOWN_DAEJEON_BUILDINGS = [
  {
    id: 'daejeon-miracle-building',
    aliases: ['미라클빌딩', '미라클 빌딩', '둔산로 52', '둔산로52', '둔산동 1169', '둔산동1169'],
    name: '미라클빌딩', buildingName: '미라클빌딩',
    roadAddress: '대전광역시 서구 둔산로 52',
    address: '대전광역시 서구 둔산로 52',
    jibunAddress: '대전광역시 서구 둔산동 1169',
    regionLabel: '대전광역시 서구 둔산동', district: '서구', neighborhood: '둔산동',
    category: '건물', type: 'PLACE', score: 1,
    lat: 36.3510328726446, lon: 127.379723813064,
    source: '확인된 대전 지역 건물 별칭 데이터'
  }
];
function knownDaejeonBuildingResults(query) {
  const compact = cleanKoreanAddressQuery(query).toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g, '');
  if (!compact) return [];
  return KNOWN_DAEJEON_BUILDINGS.filter(item => item.aliases.some(alias => {
    const key = alias.toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g, '');
    return compact.includes(key) || (compact.length >= 3 && key.includes(compact));
  })).map(({ aliases, ...item }) => ({ ...item }));
}

function geocodeLabelKey(item) {
  return String(item?.name || item?.buildingName || item?.roadAddress || item?.address || '')
    .toLocaleLowerCase('ko-KR').replace(/[\s,.-]/g, '');
}
function mergeGeocodeCandidate(unique, item) {
  const label = geocodeLabelKey(item);
  const lat = Number(item.lat), lon = Number(item.lon);
  // Providers often geocode the same building to slightly different points. Merge
  // same-name hits within 80 m, but keep identically named branches farther apart.
  let prior = null;
  for (const candidate of unique.values()) {
    if (geocodeLabelKey(candidate) !== label) continue;
    if (geoDistanceKm(lat, lon, Number(candidate.lat), Number(candidate.lon)) <= 0.08) {
      prior = candidate;
      break;
    }
  }
  if (!prior) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)},${label}`;
    unique.set(key, { ...item });
    return;
  }
  for (const field of ['jibunAddress','roadAddress','address','buildingName','name','zipCode','regionLabel','district','neighborhood','category']) {
    if ((!prior[field] || String(prior[field]).trim() === '') && item[field]) prior[field] = item[field];
  }
  if (item.type === 'PLACE' && prior.type !== 'PLACE') prior.type = 'PLACE';
  const sources = String(prior.source || '').split(' + ').filter(Boolean);
  if (item.source && !sources.includes(item.source)) sources.push(item.source);
  prior.source = sources.join(' + ');
}

async function betterAddressSearch(query, limit = 8) {
  const originalQuery = String(query || '').trim();
  const cleanOriginal = cleanKoreanAddressQuery(originalQuery);
  if (!cleanOriginal || cleanOriginal.length < 2) {
    return { source: 'Transitous + OpenStreetMap', totalCount: 0, results: [], queryUsed: originalQuery };
  }
  // Curated known aliases are merged as a fallback, never as an exclusive result set;
  // general building/place candidates from each provider remain available as well.
  const knownMatches = knownDaejeonBuildingResults(originalQuery);
  // Qualify vague searches for the Daejeon project, but query address and named-place
  // indexes separately. transitousGeocodeSearch returns the first successful type,
  // so requesting 'ADDRESS,PLACE' once would hide POI/building results when addresses exist.
  const localQuery = /대전|daejeon/i.test(originalQuery) ? originalQuery : `대전광역시 ${originalQuery}`;
  const perProviderLimit = Math.max(limit, 10);
  const settled = await Promise.allSettled([
    transitousGeocodeSearch(localQuery, perProviderLimit, 'ADDRESS'),
    transitousGeocodeSearch(localQuery, perProviderLimit, 'PLACE'),
    osmGeocodeSearch(originalQuery, perProviderLimit),
    nominatimGeocodeSearch(originalQuery, perProviderLimit)
  ]);
  const sources = [];
  const combined = [];
  let firstError = null;
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      const payload = item.value;
      sources.push(payload?.source || 'public geocoder');
      for (const candidate of Array.isArray(payload?.results) ? payload.results : []) {
        if (isInsideDaejeonBounds(candidate.lat, candidate.lon)) combined.push(candidate);
      }
    } else if (!firstError) firstError = item.reason;
  }

  // Merge same-provider and cross-provider duplicate hits (same name within 80 m),
  // while preserving distinct buildings and same-name branches farther apart.
  const unique = new Map();
  for (const item of combined) mergeGeocodeCandidate(unique, item);
  // Include verified aliases for buildings whose name/address is publicly listed
  // but missing from one or both free geocoders (e.g. 미라클빌딩).
  for (const known of knownDaejeonBuildingResults(originalQuery)) mergeGeocodeCandidate(unique, known);
  const sourceLabel = [...new Set([...sources, ...(knownDaejeonBuildingResults(originalQuery).length ? ['확인된 지역 건물 별칭 데이터'] : [])])].join(' + ') || 'Transitous + OpenStreetMap';
  let ranked = rankGeocodeResults({ source: sourceLabel, totalCount: unique.size, results: [...unique.values()] }, originalQuery, limit);
  if (ranked.results.length) return {...ranked, source: sourceLabel, queryUsed: originalQuery,
    searchModes: ['Transitous ADDRESS', 'Transitous PLACE/buildings', 'Photon/OpenStreetMap POI + addresses', 'Nominatim/OpenStreetMap POI + addresses']};

  // Stops are an additional named candidate class (stations and transit stops),
  // still requiring exact user selection before routing.
  try {
    const stops = await transitousGeocodeSearch(localQuery, Math.max(limit, 8), 'STOP');
    const localStops = (stops.results || []).filter(r => isInsideDaejeonBounds(r.lat, r.lon));
    ranked = rankGeocodeResults({ source: stops.source || 'Transitous / MOTIS stops', totalCount: localStops.length, results: localStops }, originalQuery, limit);
    if (ranked.results.length) return ranked;
  } catch (e) { if (!firstError) firstError = e; }
  if (settled.every(item => item.status === 'rejected') && firstError) throw firstError;
  return { source: sourceLabel, totalCount: 0, results: [], queryUsed: originalQuery,
    searchModes: ['Transitous ADDRESS', 'Transitous PLACE/buildings', 'Photon/OpenStreetMap POI + addresses', 'Nominatim/OpenStreetMap POI + addresses'] };
}
async function publicAddressGeocode(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) { const error = new Error('출발지 또는 목적지를 입력하세요.'); error.status = 400; throw error; }
  const payload = await betterAddressSearch(cleanQuery, 8);
  if (payload.results?.length) {
    const best = payload.results.find(r => isInsideDaejeonBounds(r.lat, r.lon));
    if (!best) { const error = new Error('대전 시내 범위에서 주소를 찾지 못했습니다. 구 이름을 포함해 다시 검색해 주세요.'); error.status=404; error.code='GEOCODE_OUTSIDE_DAEJEON'; throw error; }
    return {lat:best.lat,lon:best.lon,name:best.name||best.roadAddress||cleanQuery,address:best.roadAddress||best.address||cleanQuery,source:best.source,matchType:best.type||'ADDRESS/PLACE'};
  }
  const error = new Error(`주소를 찾지 못했습니다: ${cleanQuery}. 시·구 이름이나 도로명과 건물번호를 포함해 다시 검색해 주세요.`);
  error.status=404; error.code='GEOCODE_NO_RESULT'; throw error;
}
async function loadTramCoordinates(force = false) {
  if (tramLoadPromise) return tramLoadPromise;
  if (!force && tramState.status === 'ready' && tramState.available >= 20) return tramCache;
  tramLoadPromise = (async () => {
    tramState.status = 'loading'; tramState.error = null; tramState.step = '정거장 위치 조회'; tramState.progress = 0; tramState.total = STATIONS.length; tramState.fromCache = false;
    try {
      if (force) tramCache = {};
      if (!force && existsSync(TRAM_CACHE_PATH)) {
        try { tramCache = JSON.parse(await readFile(TRAM_CACHE_PATH, 'utf8')); tramState.fromCache = Object.keys(tramCache).length > 0; } catch { tramCache = {}; }
      }
      const existing = STATIONS.filter(s => tramCache[s.id] && Number.isFinite(tramCache[s.id].lat) && Number.isFinite(tramCache[s.id].lon)).length;
      tramState.progress = existing; tramState.available = existing;
      for (const station of STATIONS) {
        if (tramCache[station.id] && Number.isFinite(tramCache[station.id].lat) && Number.isFinite(tramCache[station.id].lon)) continue;
        tramState.step = `트램 정거장 위치 확인: ${station.id} ${station.name}`;
        try {
          const geo = await transitousPlaceGeocode(`대전광역시 ${station.search}`, { allowStops: true, preferPlaces: true });
          tramCache[station.id] = { ...station, lat: geo.lat, lon: geo.lon, geocodeName: geo.name };
          tramState.available++;
          await mkdir(DATA_DIR, { recursive: true });
          await writeFile(TRAM_CACHE_PATH, JSON.stringify(tramCache), 'utf8');
        } catch { /* keep processing; not all landmarks have an OSM match */ }
        tramState.progress++;
      }
      if (tramState.available < 20) throw new Error(`트램 정거장 위치를 ${tramState.available}개만 확보했습니다. OpenStreetMap 검색 결과가 부족합니다.`);
      tramState.status = 'ready'; tramState.step = '트램 정거장 위치 준비 완료'; tramState.fromCache = existing > 0;
      return tramCache;
    } catch (e) { tramState.status = 'error'; tramState.error = e.message; tramState.step = '트램 정거장 위치를 준비하지 못했습니다'; throw e; }
    finally { tramLoadPromise = null; }
  })();
  return tramLoadPromise;
}
function startTramLoad(force = false) { if (tramLoadPromise) return; if (!force && tramState.status === 'ready') return; loadTramCoordinates(force).catch(() => {}); }

function nval(v, fallback = NaN) { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : fallback; }
function haversine(a, b) {
  const r = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(x)));
}
function minuteWalk(meters, walkKmh = 4.5) { return Math.max(0, meters / 1000 / walkKmh * 60); }
function routeHeadway(row) {
  let v = nval(firstField(row, ['ALLO_INTERVAL','ALLO_INTERVAL_SAT']), 12);
  if (!Number.isFinite(v) || v <= 0) v = 12;
  if (v > 60) v = v / 60;
  return Math.max(3, Math.min(60, v));
}
function routeTypeName(v) { const key=String(v || '').trim(); return ({'1':'급행','2':'간선','3':'지선','4':'외곽','5':'마을','6':'첨단','11':'고속','12':'시외','13':'공항','14':'마을','15':'간선','16':'지선','17':'순환','18':'광역','21':'농어촌'})[key] || '버스'; }
function buildGraph(dataset, busSpeedKmh = 17) {
  if (graphCache && graphCache.busSpeedKmh === busSpeedKmh) return graphCache;
  const routeInfoById = new Map();
  for (const row of dataset.routes) {
    const id = firstField(row, ['ROUTE_CD','ROUTE_ID','BUS_ROUTE_ID']);
    if (!id) continue;
    routeInfoById.set(id, {
      id,
      no: firstField(row, ['ROUTE_NO','ROUTE_NM','ROUTENO']) || id,
      type: routeTypeName(firstField(row, ['ROUTE_TP','ROUTE_TYPE'])),
      headway: routeHeadway(row),
      raw: row
    });
  }
  const grouped = new Map();
  for (const row of dataset.routeStops) {
    const routeId = firstField(row, ['ROUTE_CD','ROUTE_ID','BUS_ROUTE_ID']);
    const lat = nval(firstField(row, ['GPS_LATI','LAT','LATITUDE']));
    const lon = nval(firstField(row, ['GPS_LONG','LON','LONGITUDE']));
    const seq = nval(firstField(row, ['BUSSTOP_SEQ','STOP_SEQ','SEQ']), 0);
    if (!routeId || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < 36.1 || lat > 36.6 || lon < 127.1 || lon > 127.7) continue;
    if (!grouped.has(routeId)) grouped.set(routeId, []);
    grouped.get(routeId).push({ raw: row, routeId, lat, lon, seq, stopId: firstField(row, ['BUS_NODE_ID','BUS_STOP_ID','NODE_ID']) || `${lat.toFixed(5)},${lon.toFixed(5)}`, stopName: firstField(row, ['BUSSTOP_NM','STOP_NAME','BUS_STOP_NM']) || '이름 없는 정류장' });
  }
  const nodes = [], edges = [], reverseEdges = [], physicalGroups = new Map();
  const addNode = (s, route) => {
    const index = nodes.length;
    const node = { index, routeId: route.id, routeNo: route.no, routeType: route.type, headway: route.headway, lat:s.lat, lon:s.lon, stopId:s.stopId, stopName:s.stopName, seq:s.seq, edges:[], reverse:[] };
    nodes.push(node);
    if (!physicalGroups.has(s.stopId)) physicalGroups.set(s.stopId, { key:s.stopId, lat:s.lat, lon:s.lon, nodes:[] });
    const group = physicalGroups.get(s.stopId); group.nodes.push(index);
    // Prefer mean position when a stop ID has slightly varying coordinates across route records.
    group.lat += 0; group.lon += 0;
    return index;
  };
  let routeWithStops = 0;
  for (const [routeId, stops] of grouped) {
    const route = routeInfoById.get(routeId) || { id:routeId, no:routeId, type:'버스', headway:12 };
    stops.sort((a,b) => a.seq - b.seq);
    const clean = [];
    for (const s of stops) {
      if (clean.length && clean[clean.length - 1].stopId === s.stopId && clean[clean.length - 1].seq === s.seq) continue;
      clean.push(s);
    }
    if (clean.length < 2) continue;
    routeWithStops++;
    const routeNodes = clean.map(s => addNode(s, route));
    for (let i=0;i<routeNodes.length-1;i++) {
      const a = nodes[routeNodes[i]], b = nodes[routeNodes[i+1]];
      const meters = haversine(a,b) * 1.22;
      if (meters > 10000) continue;
      const minutes = (meters / 1000 / busSpeedKmh * 60) + 0.25;
      const forward = { from:a.index, to:b.index, type:'ride', routeId, routeNo:route.no, minutes, distanceKm:meters/1000, fromStop:a, toStop:b };
      const backward = { ...forward, from:b.index, to:a.index, fromStop:b, toStop:a };
      a.edges.push(forward); b.reverse.push(forward); b.edges.push(backward); a.reverse.push(backward);
    }
  }
  // Build transfers between routes that share or closely neighbor a physical stop.
  const cell = p => `${Math.floor(p.lat/0.0018)}:${Math.floor(p.lon/0.0022)}`;
  const buckets = new Map();
  for (const node of nodes) { const key=cell(node); if(!buckets.has(key))buckets.set(key,[]); buckets.get(key).push(node.index); }
  const transferSeen = new Set();
  for (const a of nodes) {
    const cy=Math.floor(a.lat/0.0018), cx=Math.floor(a.lon/0.0022);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      const list=buckets.get(`${cy+dy}:${cx+dx}`)||[];
      for(const j of list) {
        if(j<=a.index) continue;
        const b=nodes[j]; if(a.routeId===b.routeId) continue;
        const pair=`${a.index}:${b.index}`; if(transferSeen.has(pair))continue;
        const meters=haversine(a,b); if(meters>180)continue; transferSeen.add(pair);
        const walk=minuteWalk(meters,4.5)+1.0;
        const ab={from:a.index,to:b.index,type:'transfer',minutes:walk+b.headway/2,distanceKm:meters/1000,fromStop:a,toStop:b,routeNo:b.routeNo};
        const ba={from:b.index,to:a.index,type:'transfer',minutes:walk+a.headway/2,distanceKm:meters/1000,fromStop:b,toStop:a,routeNo:a.routeNo};
        a.edges.push(ab); b.reverse.push(ab); b.edges.push(ba); a.reverse.push(ba);
      }
    }
  }
  // Deduplicate physical stop records and index their route-state nodes.
  const groups = [...physicalGroups.values()].map(g => {
    const uniqueNodes = [...new Set(g.nodes)];
    const latAvg = uniqueNodes.reduce((sum,i)=>sum+nodes[i].lat,0)/uniqueNodes.length;
    const lonAvg = uniqueNodes.reduce((sum,i)=>sum+nodes[i].lon,0)/uniqueNodes.length;
    return { ...g, lat:latAvg, lon:lonAvg, nodes:uniqueNodes };
  });
  graphCache = { busSpeedKmh, nodes, groups, routeWithStops, edgeCount:nodes.reduce((s,n)=>s+n.edges.length,0) };
  return graphCache;
}
class MinHeap {
  constructor(){this.a=[];}
  push(item){const a=this.a;a.push(item);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p].d<=item.d)break;a[i]=a[p];i=p;}a[i]=item;}
  pop(){const a=this.a;if(!a.length)return null;const top=a[0],last=a.pop();if(a.length){let i=0;while(true){let l=i*2+1,r=l+1,m=i;if(l<a.length&&a[l].d<(m===i?last.d:a[m].d))m=l;if(r<a.length&&a[r].d<(m===i?last.d:a[m].d))m=r;if(m===i)break;a[i]=a[m];i=m;}a[i]=last;}return top;}
  get size(){return this.a.length;}
}
function nearestGroups(graph, point, maxGroups=6, maxMeters=2500) {
  return graph.groups.map(g=>({group:g, meters:haversine(point,g)})).sort((a,b)=>a.meters-b.meters).filter(x=>x.meters<=maxMeters).slice(0,maxGroups);
}
function runDijkstra(graph, seeds, reverse = false) {
  const n=graph.nodes.length, dist=new Float64Array(n); dist.fill(Infinity);
  const prevNode=new Int32Array(n); prevNode.fill(-1);
  const prevEdge=new Array(n), seedInfo=new Array(n), heap=new MinHeap();
  for (const seed of seeds) {
    const i=seed.index;
    if(seed.minutes < dist[i]) { dist[i]=seed.minutes; seedInfo[i]=seed; heap.push({i,d:seed.minutes}); }
  }
  while(heap.size) {
    const cur=heap.pop(); if(cur.d!==dist[cur.i])continue;
    const node=graph.nodes[cur.i]; const list=reverse?node.reverse:node.edges;
    for(const edge of list) {
      const next=reverse?edge.from:edge.to; const nd=cur.d+edge.minutes;
      if(nd<dist[next]) {dist[next]=nd;prevNode[next]=cur.i;prevEdge[next]=edge;seedInfo[next]=seedInfo[cur.i];heap.push({i:next,d:nd});}
    }
  }
  return {dist,prevNode,prevEdge,seedInfo};
}
function makeSeeds(graph, point, busSpeedKmh=17, walkSpeedKmh=4.5) {
  const candidates=nearestGroups(graph,point,7,3500);
  const seeds=[];
  for(const c of candidates) for(const index of c.group.nodes) {
    const node=graph.nodes[index];
    const walkMin=minuteWalk(c.meters,walkSpeedKmh);
    seeds.push({index,minutes:walkMin+node.headway/2+0.4,walkMin,waitMin:node.headway/2,stopName:node.stopName,stopId:node.stopId,routeNo:node.routeNo,group:c.group});
  }
  return seeds;
}
function buildPathResult(graph, search, destination, walkSpeedKmh=4.5, allowWalk=true) {
  const targets=nearestGroups(graph,destination,8,3500);
  let best=null;
  for(const item of targets) for(const index of item.group.nodes) {
    const candidate=search.dist[index]+minuteWalk(item.meters,walkSpeedKmh);
    if(Number.isFinite(candidate)&&(!best||candidate<best.total))best={index,total:candidate,endWalkMin:minuteWalk(item.meters,walkSpeedKmh),endGroup:item.group,endMeters:item.meters};
  }
  if(!best)return null;
  let indices=[best.index], edges=[]; let current=best.index, guard=0;
  while(search.prevNode[current]>=0 && guard++ < graph.nodes.length+4) {
    edges.push(search.prevEdge[current]); current=search.prevNode[current]; indices.push(current);
  }
  indices.reverse(); edges.reverse();
  const seed=search.seedInfo[indices[0]];
  if(!seed)return null;
  const steps=[];
  if(seed.walkMin>0.2)steps.push({kind:'walk',label:'출발지에서 승차 정류장까지 도보',minutes:seed.walkMin,from:'출발지',to:seed.stopName});
  steps.push({kind:'wait',label:`${seed.routeNo}번 버스 평균 대기(배차간격 절반 가정)`,minutes:seed.waitMin,from:seed.stopName,to:seed.stopName});
  let currentRide=null;
  const flushRide=()=>{if(currentRide){steps.push(currentRide);currentRide=null;}};
  for(const edge of edges) {
    if(edge.type==='ride') {
      if(currentRide && currentRide.routeId===edge.routeId && currentRide.to===edge.fromStop.stopName) {
        currentRide.to=edge.toStop.stopName; currentRide.minutes+=edge.minutes; currentRide.distanceKm+=edge.distanceKm; currentRide.stopCount++; currentRide.coords.push([edge.toStop.lat,edge.toStop.lon]);
      } else {
        flushRide();
        currentRide={kind:'bus',label:`${edge.routeNo}번 ${edge.toStop.routeType||'버스'}`,routeId:edge.routeId,routeNo:edge.routeNo,from:edge.fromStop.stopName,to:edge.toStop.stopName,minutes:edge.minutes,distanceKm:edge.distanceKm,stopCount:1,coords:[[edge.fromStop.lat,edge.fromStop.lon],[edge.toStop.lat,edge.toStop.lon]]};
      }
    } else {
      flushRide();
      steps.push({kind:'transfer',label:'정류장 이동·환승 대기 추정',minutes:edge.minutes,from:edge.fromStop.stopName,to:edge.toStop.stopName,distanceKm:edge.distanceKm,routeNo:edge.routeNo});
      steps.push({kind:'wait',label:`${edge.routeNo}번 버스 환승 대기 포함`,minutes:0,from:edge.toStop.stopName,to:edge.toStop.stopName});
    }
  }
  flushRide();
  if(best.endWalkMin>0.2)steps.push({kind:'walk',label:'하차 정류장에서 목적지까지 도보',minutes:best.endWalkMin,from:best.endGroup.nodes.length?graph.nodes[best.index].stopName:'하차 정류장',to:'목적지'});
  const busSteps=steps.filter(s=>s.kind==='bus');
  const routeNumbers=[]; for(const s of busSteps)if(!routeNumbers.length||routeNumbers[routeNumbers.length-1]!==s.routeNo)routeNumbers.push(s.routeNo);
  const geometry=[[seed.group.lat,seed.group.lon],...indices.map(i=>[graph.nodes[i].lat,graph.nodes[i].lon]),[best.endGroup.lat,best.endGroup.lon]];
  return { timeMin:best.total, distanceKm:edges.reduce((s,e)=>s+(e.distanceKm||0),0), transferCount:Math.max(0,busSteps.length-1), routeNumbers, boardingStop:seed.stopName, alightingStop:graph.nodes[best.index].stopName, steps:steps.filter(s=>s.kind!=='wait'||s.minutes>0.1), geometry, startWalkMin:seed.walkMin, endWalkMin:best.endWalkMin, estimated:true };
}
function findBusRoute(graph,start,end,options={}) {
  const walkSpeed=options.walkSpeedKmh||4.5;
  const seeds=makeSeeds(graph,start,graph.busSpeedKmh,walkSpeed);
  if(!seeds.length)return null;
  const search=runDijkstra(graph,seeds,false);
  let result=buildPathResult(graph,search,end,walkSpeed,true);
  const directMeters=haversine(start,end);
  if(options.allowWalk!==false && directMeters<=1300) {
    const directMinutes=minuteWalk(directMeters,walkSpeed);
    if(!result||directMinutes<result.timeMin) result={timeMin:directMinutes,distanceKm:directMeters/1000,transferCount:0,routeNumbers:[],boardingStop:null,alightingStop:null,steps:[{kind:'walk',label:'도보 이동',minutes:directMinutes,from:'출발지',to:'목적지'}],geometry:[[start.lat,start.lon],[end.lat,end.lon]],startWalkMin:directMinutes,endWalkMin:0,estimated:true,directWalk:true};
  }
  if(result) {result.start={...start};result.end={...end};}
  return result;
}
let tramNetwork;
function getTramNetwork() {
  // No synthetic ring or coordinate-cache fallback when the graph is absent/invalid.
  return tramNetwork ||= loadTramGraph();
}
function nearestTram(stations,point,count=4) { return [...stations].map(s=>({...s,meters:haversine(s,point)})).sort((a,b)=>a.meters-b.meters).slice(0,count); }
function uniqueLatLon(points) {
  const result = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) continue;
    const p = [Number(point[0]), Number(point[1])];
    if (Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) continue;
    const last = result[result.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 0.000001 || Math.abs(last[1] - p[1]) > 0.000001) result.push(p);
  }
  return result;
}

// Map-only geometry approximation: follow mapped streets between ordered tram stops.
// This is not an official engineering alignment; OSRM is used only to draw a less
// misleading shape than straight lines between landmark geocodes.
const tramGeometryCache = new Map();
async function roadFollowTramGeometry(path) {
  const fallback = (path || []).map(s => [Number(s.lat), Number(s.lon)])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!Array.isArray(path) || path.length < 2) return fallback;
  const key = path.map(s => `${Number(s.lat).toFixed(5)},${Number(s.lon).toFixed(5)}`).join(';');
  const cached = tramGeometryCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.geometry;
  const points = path.filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
  const chunks = [];
  const maxWaypoints = 18;
  for (let i = 0; i < points.length - 1; i += maxWaypoints - 1) {
    const chunk = points.slice(i, Math.min(points.length, i + maxWaypoints));
    if (chunk.length >= 2) chunks.push(chunk);
  }
  try {
    const all = [];
    for (const chunk of chunks) {
      const coords = chunk.map(s => `${Number(s.lon)},${Number(s.lat)}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&continue_straight=true`;
      const response = await fetch(url, {headers:{Accept:'application/json'}, signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
      const payload = await response.json();
      const coordsOut = payload?.routes?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coordsOut) || coordsOut.length < 2) throw new Error('OSRM route geometry missing');
      for (const p of coordsOut) {
        const ll = [Number(p[1]), Number(p[0])];
        if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
        const last = all[all.length-1];
        if (!last || Math.abs(last[0]-ll[0])>0.000001 || Math.abs(last[1]-ll[1])>0.000001) all.push(ll);
      }
    }
    if (all.length >= 2) {
      tramGeometryCache.set(key,{at:Date.now(),geometry:all});
      return all;
    }
  } catch (_) {
    // Fall back to stop coordinates when the public routing service is unavailable.
  }
  return fallback;
}

function placeLatLon(place) {
  if (!place || typeof place !== 'object') return null;
  const lat = nval(place.lat ?? place.latitude ?? place.y ?? place.coord?.lat);
  const lon = nval(place.lon ?? place.lng ?? place.longitude ?? place.x ?? place.coord?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}
function decodeGooglePolyline(encoded, precision = 6) {
  if (typeof encoded !== 'string' || !encoded) return [];
  const factor = 10 ** precision, out = [];
  let index = 0, lat = 0, lon = 0;
  try {
    while (index < encoded.length) {
      let result = 0, shift = 0, b;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < encoded.length);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1); lat += dlat;
      result = 0; shift = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < encoded.length);
      const dlon = (result & 1) ? ~(result >> 1) : (result >> 1); lon += dlon;
      const p = [lat / factor, lon / factor];
      if (Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180) out.push(p);
    }
  } catch { return []; }
  return out;
}
function polylineForLeg(leg, from, to) {
  const raw = leg?.polyline ?? leg?.legGeometry?.points ?? leg?.geometry?.points ?? leg?.geometry;
  if (Array.isArray(raw?.coordinates)) return raw.coordinates.map(p => [Number(p[1]), Number(p[0])]).filter(p => p.every(Number.isFinite));
  if (Array.isArray(raw)) {
    if (raw.length && Array.isArray(raw[0])) return raw.map(p => Array.isArray(p) ? (p.length >= 2 ? [Number(p[1]),Number(p[0])] : null) : null).filter(p => p && p.every(Number.isFinite));
    return [];
  }
  const encoded = typeof raw === 'string' ? raw : (raw?.points ?? raw?.encodedPolyline ?? raw?.encoded);
  if (typeof encoded !== 'string' || !encoded) return [];
  const variants = [6, 5, 7].map(precision => ({precision, points:decodeGooglePolyline(encoded, precision)})).filter(v => v.points.length >= 2);
  if (!variants.length) return [];
  if (!from || !to) return variants[0].points;
  const endpointError = points => haversine({lat:points[0][0],lon:points[0][1]},{lat:from[0],lon:from[1]}) + haversine({lat:points.at(-1)[0],lon:points.at(-1)[1]},{lat:to[0],lon:to[1]});
  return variants.sort((a,b)=>endpointError(a.points)-endpointError(b.points))[0].points;
}
function legTimeSeconds(leg) {
  const explicit = nval(leg?.duration ?? leg?.durationSeconds ?? leg?.timeSeconds);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const departure = Date.parse(leg?.departure ?? leg?.startTime ?? '');
  const arrival = Date.parse(leg?.arrival ?? leg?.endTime ?? '');
  return Number.isFinite(departure) && Number.isFinite(arrival) && arrival >= departure ? (arrival-departure)/1000 : 0;
}
function normalizeTransitousItinerary(itinerary, index = 0) {
  const legs = asArray(itinerary?.legs).filter(leg => leg && typeof leg === 'object');
  const steps = [], geometry = [], routeLabels = [];
  let derivedDistance = 0, derivedDuration = 0, walkDistance = 0, walkDuration = 0;
  let boardingStop = '', alightingStop = '', transitLegCount = 0;
  for (const leg of legs) {
    const mode = String(leg.mode ?? leg.transportMode ?? 'WALK').toUpperCase();
    const durationSec = legTimeSeconds(leg);
    const minutes = durationSec / 60;
    const fromPoint = placeLatLon(leg.from ?? leg.start);
    const toPoint = placeLatLon(leg.to ?? leg.end);
    const from = String(leg.from?.name ?? leg.from?.stopName ?? leg.start?.name ?? (mode === 'WALK' ? '현재 위치' : '승차 지점'));
    const to = String(leg.to?.name ?? leg.to?.stopName ?? leg.end?.name ?? (mode === 'WALK' ? '이동 지점' : '하차 지점'));
    let distanceMeters = nval(leg.distance ?? leg.distanceMeters, NaN);
    let shape = polylineForLeg(leg, fromPoint, toPoint);
    if (!shape.length) shape = [fromPoint, toPoint].filter(Boolean);
    shape = uniqueLatLon(shape);
    if (!(Number.isFinite(distanceMeters) && distanceMeters >= 0) && shape.length >= 2) {
      distanceMeters = 0;
      for (let i=1;i<shape.length;i++) distanceMeters += haversine({lat:shape[i-1][0],lon:shape[i-1][1]},{lat:shape[i][0],lon:shape[i][1]});
    }
    if (!Number.isFinite(distanceMeters) || distanceMeters < 0) distanceMeters = 0;
    derivedDistance += distanceMeters; derivedDuration += durationSec;
    geometry.push(...shape);
    const transit = mode !== 'WALK' && mode !== 'FOOT' && mode !== 'TRANSFER' && mode !== 'WAIT';
    if (!transit) {
      walkDistance += distanceMeters; walkDuration += durationSec;
      steps.push({kind:'walk',label:from && to ? '도보 이동' : '도보 이동',from,to,minutes,distanceKm:distanceMeters/1000,description:leg?.steps?.map(s=>s?.instruction || s?.description).filter(Boolean).slice(0,2).join(' · ') || ''});
      continue;
    }
    transitLegCount++;
    if (!boardingStop) boardingStop = from;
    alightingStop = to;
    const tripList = asArray(leg.trips);
    const trip = tripList[0] || {};
    const rawLine = String(leg.displayName ?? leg.routeShortName ?? trip.routeShortName ?? leg.routeLongName ?? trip.routeLongName ?? leg.headsign ?? trip.headsign ?? (mode === 'BUS' ? '버스' : mode));
    const line = mode === 'BUS' && /^\d+[A-Za-z가-힣]*$/.test(rawLine) && !rawLine.includes('번') ? `${rawLine}번` : rawLine;
    if (!routeLabels.includes(line)) routeLabels.push(line);
    const intermediate = asArray(leg.intermediateStops ?? leg.stops ?? leg.stopEvents);
    steps.push({kind:mode === 'BUS' || mode === 'TROLLEYBUS' ? 'bus' : 'rail',label:line,from,to,minutes,distanceKm:distanceMeters/1000,stopCount:intermediate.length+1,mode,headsign:leg.headsign ?? trip.headsign ?? ''});
  }
  const explicitDuration = nval(itinerary?.duration ?? itinerary?.durationSeconds, NaN);
  const timeMin = Number.isFinite(explicitDuration) && explicitDuration >= 0 ? explicitDuration/60 : derivedDuration/60;
  const explicitTransfers = nval(itinerary?.transfers ?? itinerary?.transferCount, NaN);
  const transferCount = Number.isFinite(explicitTransfers) ? explicitTransfers : Math.max(0,transitLegCount-1);
  const fareRaw = itinerary?.fare?.total ?? itinerary?.fare?.amount ?? itinerary?.fares?.[0]?.amount;
  return {
    id:index+1, source:'TRANSITOUS', estimated:false, timeMin,
    distanceKm:derivedDistance/1000, transferCount,
    routeNumbers:routeLabels, boardingStop:boardingStop || (steps[0]?.from ?? '도보 출발'),
    alightingStop:alightingStop || (steps.at(-1)?.to ?? '도보 도착'), steps,
    geometry:uniqueLatLon(geometry), fare:Number.isFinite(Number(fareRaw)) ? Number(fareRaw) : null,
    walkDistanceKm:walkDistance/1000, walkTimeMin:walkDuration/60,
    rawLegCount:legs.length, noTransitLegs:transitLegCount===0,
    departureTime:itinerary?.startTime ?? itinerary?.departure ?? null,
    arrivalTime:itinerary?.endTime ?? itinerary?.arrival ?? null
  };
}
function transitousCacheKey(start, end, count) {
  const now = new Date(Date.now() + 9*60*60*1000);
  now.setMinutes(Math.floor(now.getMinutes()/5)*5,0,0);
  return [Number(start.lat).toFixed(5),Number(start.lon).toFixed(5),Number(end.lat).toFixed(5),Number(end.lon).toFixed(5),Number(count),now.toISOString().slice(0,16)].join('|');
}
function koreaIsoDateTime() {
  const shifted = new Date(Date.now() + 9*60*60*1000);
  return shifted.toISOString().slice(0,19) + '+09:00';
}
async function transitousRoutes(start, end, count = 3) {
  const key = transitousCacheKey(start,end,count), now = Date.now(), cached = transitousRouteCache.get(key);
  if (cached && now-cached.at < TRANSITOUS_CACHE_TTL_MS) return cached.value;
  const query = new URLSearchParams({
    fromPlace:`${Number(start.lat)},${Number(start.lon)}`,
    toPlace:`${Number(end.lat)},${Number(end.lon)}`,
    time:koreaIsoDateTime(),
    maxTransfers:'3',
    maxTravelTime:'240',
    maxPreTransitTime:'1800',
    maxPostTransitTime:'1800',
    maxMatchingDistance:'250',
    transitModes:'TRANSIT',
    directModes:'WALK',
    preTransitModes:'WALK',
    postTransitModes:'WALK',
    timetableView:'true',
    numItineraries:String(Math.max(1,Math.min(5,Number(count)||3))),
    maxItineraries:String(Math.max(1,Math.min(5,Number(count)||3))),
    searchWindow:'1800',
    detailedLegs:'true',
    detailedTransfers:'true',
    withFares:'true'
  });
  const requestUrl = `${TRANSITOUS_PLAN_URL}?${query.toString()}`;
  let response;
  try {
    response = await fetch(requestUrl, {headers:{Accept:'application/json','User-Agent':'DaejeonTramRouteLab/1.13.7 (public Transitous routing prototype)'},signal:AbortSignal.timeout(30000)});
  } catch (e) {
    const error = new Error(`무료 Transitous 경로 API 연결에 실패했습니다: ${e.message}. 인터넷 연결 또는 서비스 상태를 확인하세요.`);
    error.status=502; error.code='TRANSITOUS_NETWORK_ERROR'; throw error;
  }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = {rawText:raw.slice(0,500)}; }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.detail || payload?.rawText || raw.slice(0,300);
    const error = new Error(`무료 Transitous API HTTP ${response.status}: ${String(detail).slice(0,300)}`);
    error.status=response.status; error.code=response.status===429?'TRANSITOUS_RATE_LIMITED':'TRANSITOUS_HTTP_ERROR'; throw error;
  }
  const rawItineraries = asArray(payload?.itineraries ?? payload?.connections ?? payload?.plan?.itineraries).filter(x=>x&&typeof x==='object');
  const routes = rawItineraries.map((item,i)=>normalizeTransitousItinerary(item,i)).filter(r=>Number.isFinite(r.timeMin)&&r.timeMin>=0&&!r.noTransitLegs).sort((a,b)=>a.timeMin-b.timeMin);
  if (!routes.length) {
    const message = payload?.error?.message || payload?.message || '무료 대중교통 데이터에서 이 출발지·목적지의 환승 경로를 찾지 못했습니다.';
    const error = new Error(`Transitous에서 대중교통 경로를 찾지 못했습니다. ${String(message)} 대전 지역 노선이 데이터에 없거나 현재 시간표가 제공되지 않을 수 있습니다. 이 경우 대전시 버스 공공 API를 별도로 연결해야 합니다.`);
    error.status=404; error.code='TRANSITOUS_NO_ROUTE'; error.detail={endpoint:TRANSITOUS_PLAN_URL,availableTopLevelKeys:Object.keys(payload||{})}; throw error;
  }
  for (const route of routes) {
    if (!route.geometry || route.geometry.length<2) route.geometry=[[start.lat,start.lon],[end.lat,end.lon]];
  }
  const value={provider:'Transitous 무료 공개 대중교통 경로 API',endpoint:TRANSITOUS_PLAN_URL,requestTime:koreaIsoDateTime(),totalRoutes:routes.length,routes,best:routes[0],coverageNote:'커뮤니티 GTFS 데이터 기반; 대전 버스 노선 범위는 제공 데이터에 따라 달라질 수 있음'};
  transitousRouteCache.set(key,{at:now,value});
  if (transitousRouteCache.size>120) for(const [k,v] of transitousRouteCache) if(now-v.at>TRANSITOUS_CACHE_TTL_MS) transitousRouteCache.delete(k);
  return value;
}
function walkOnlyRoute(start,end,label='도보 접근') {
  const meters=haversine(start,end), timeMin=minuteWalk(meters,4.5);
  return { source:'WALK_ESTIMATE', estimated:true, timeMin, distanceKm:meters/1000, transferCount:0, routeNumbers:[], boardingStop:label, alightingStop:label, fare:null, walkDistanceKm:meters/1000, walkTimeMin:timeMin, geometry:[[start.lat,start.lon],[end.lat,end.lon]], steps:[{kind:'walk',label,from:label==='도보 접근'?'출발 지점':label,to:'정거장/목적지',minutes:timeMin,distanceKm:meters/1000}] };
}
async function routeOrWalk(start,end,label) {
  // Avoid extra Transitous calls for every tram-station candidate. The current origin->destination
  // transit itinerary is the only Transitous call in a fresh search; access/egress use a clearly
  // labeled straight-line walking estimate with a 1.3 route-detour factor.
  const directMeters = haversine(start,end);
  const estimatedMeters = directMeters * 1.3;
  const minutes = minuteWalk(estimatedMeters, 4.5);
  return {
    source:'WALK_ESTIMATE', estimated:true, timeMin:minutes,
    distanceKm:estimatedMeters / 1000, transferCount:0, routeNumbers:[],
    boardingStop:label, alightingStop:label, fare:null,
    walkDistanceKm:estimatedMeters / 1000, walkTimeMin:minutes,
    geometry:[[start.lat,start.lon],[end.lat,end.lon]],
    steps:[{kind:'walk',label:'도보 접근 추정',from:label,to:label,minutes,distanceKm:estimatedMeters/1000,description:'직선거리 × 1.3 우회계수, 보행속도 4.5km/h로 계산한 추정치'}]
  };
}
function chooseTramCandidates(stations, point, count = 2) {
  const ranked = [...stations].map(station => ({ ...station, meters: haversine(station, point) })).sort((a, b) => a.meters - b.meters);
  if (ranked.length <= count) return ranked;
  const picked = [];
  if (ranked[0]) picked.push(ranked[0]);
  // If the nearest stop is close enough to walk, also try a farther stop where a bus feeder may make sense.
  const farther = ranked.find(station => !picked.some(p => p.id === station.id) && station.meters >= 1200 && station.meters <= 10000);
  if (farther) picked.push(farther);
  for (const station of ranked) {
    if (picked.length >= count) break;
    if (!picked.some(p => p.id === station.id)) picked.push(station);
  }
  return picked.slice(0, count);
}
function routeHasBus(route) { return Boolean(route?.steps?.some(step => step.kind === 'bus' || String(step.mode || '').toUpperCase() === 'BUS')); }
function routeHasTransit(route) { return Boolean(route?.steps?.some(step => step.kind === 'bus' || step.kind === 'rail')); }
function routeModeLabel(route) {
  if (routeHasBus(route)) return `버스 ${((route.routeNumbers || []).filter(Boolean)).join(' → ')}`.trim();
  if (routeHasTransit(route)) return `대중교통 ${(route.routeNumbers || []).filter(Boolean).join(' → ')}`.trim();
  return '도보 접근 추정';
}
async function planFeederLeg(start, end, label) {
  const straightMeters = haversine(start, end);
  if (straightMeters <= 450) {
    const walk = await routeOrWalk(start, end, label);
    return { ...walk, label, hasBus: false, hasTransit: false, fallback: '근거리 도보 연결' };
  }
  try {
    const response = await transitousRoutes(start, end, 2);
    const route = response.routes.find(item => routeHasBus(item)) || response.routes.find(item => routeHasTransit(item)) || response.routes[0];
    if (route && routeHasTransit(route)) return { ...route, label, hasBus: routeHasBus(route), hasTransit: true, feederSource: 'Transitous 공개 대중교통 경로' };
  } catch (error) {
    // A feeder with no available transit itinerary may be represented as a short walk only.
    // Do not silently treat long walking distances as a realistic bus connection.
    if (error.code !== 'TRANSITOUS_NO_ROUTE') throw error;
  }
  if (straightMeters <= 1800) {
    const walk = await routeOrWalk(start, end, label);
    return { ...walk, label, hasBus: false, hasTransit: false, fallback: '대중교통 경로 미제공으로 도보 추정' };
  }
  return null;
}
function estimateTramRide(stations, startStation, endStation, params = {}) {
  const ride = getTramNetwork().findRide(startStation.id, endStation.id, params);
  if (!ride || ride.hops < 1 || ride.distanceKm <= 0) return null;
  return {ride, rideMin:ride.rideMin, waitMin:ride.waitMin,
          tramSpeed:ride.tramSpeed, headway:ride.headway, dwell:ride.dwell};
}
async function compareRoutesWithTransitous(start, end, params = {}) {
  const network = getTramNetwork();
  const full = await transitousRoutes(start, end, 5); // Baseline route, usually cached from the current-route request.
  const current = { ...full.best, alternatives: full.routes.slice(1, 5).map(route => ({ timeMin: route.timeMin, distanceKm: route.distanceKm, transferCount: route.transferCount, routeNumbers: route.routeNumbers, fare: route.fare })) };
  const stations = network.stations();

  const startCandidates = chooseTramCandidates(stations, start, 2);
  const endCandidates = chooseTramCandidates(stations, end, 2);
  const access = [], egress = [];
  // At most 2 origin-to-station and 2 station-to-destination queries per new comparison.
  // Cache inside transitousRoutes prevents repeated queries for identical endpoints.
  for (const station of startCandidates) {
    const leg = await planFeederLeg(start, { lat: station.lat, lon: station.lon }, `출발지 → ${station.name}`);
    if (leg) access.push({ station, route: leg });
  }
  for (const station of endCandidates) {
    const leg = await planFeederLeg({ lat: station.lat, lon: station.lon }, end, `${station.name} → 목적지`);
    if (leg) egress.push({ station, route: leg });
  }

  const transferBufferMin = Math.max(0, nval(params.transferBuffer, 2));
  const combos = [];
  for (const a of access) for (const b of egress) {
    if (a.station.id === b.station.id) continue;
    const estimate = estimateTramRide(stations, a.station, b.station, params);
    if (!estimate) continue;
    const busSides = Number(routeHasBus(a.route)) + Number(routeHasBus(b.route));
    const transitSides = Number(routeHasTransit(a.route)) + Number(routeHasTransit(b.route));
    // Include realistic interchange buffers where the separate feeder routes join the hypothetical tram.
    const totalMin = Number(a.route.timeMin) + transferBufferMin + estimate.rideMin + transferBufferMin + Number(b.route.timeMin);
    if (!Number.isFinite(totalMin)) continue;
    // Prefer genuine bus -> tram -> bus when available; use a small preference penalty, not actual time.
    const score = totalMin + (2 - busSides) * 6 + (2 - transitSides) * 2;
    const geometry = uniqueLatLon([...(a.route.geometry || []), ...estimate.ride.path.map(station => [station.lat, station.lon]), ...(b.route.geometry || [])]);
    const accessLabel = routeModeLabel(a.route);
    const egressLabel = routeModeLabel(b.route);
    const segments = [
      { kind: 'access', label: `출발지 → ${a.station.name}`, minutes: a.route.timeMin, sub: accessLabel, source: a.route.source, steps: a.route.steps || [], estimated: Boolean(a.route.estimated), warning: a.route.fallback || '' },
      { kind: 'tram', label: `트램 ${a.station.name} → ${b.station.name}`, minutes: estimate.rideMin, sub: `약 ${estimate.ride.distanceKm.toFixed(1)}km · 평균 대기 ${Math.round(estimate.waitMin)}분 포함`, source: '트램 시뮬레이션', steps: [], estimated: true },
      { kind: 'egress', label: `${b.station.name} → 목적지`, minutes: b.route.timeMin, sub: egressLabel, source: b.route.source, steps: b.route.steps || [], estimated: Boolean(b.route.estimated), warning: b.route.fallback || '' }
    ];
    combos.push({
      startStation: a.station, endStation: b.station, ride: estimate.ride,
      totalMin, access: a.route, egress: b.route, rideMin: estimate.rideMin,
      waitMin: estimate.waitMin, transferBufferMin, segments, geometry,
      busSides, transitSides, hasBusTramBus: busSides === 2,
      modeChain: busSides === 2 ? '버스 → 트램 → 버스' : transitSides === 2 ? '대중교통 → 트램 → 대중교통' : busSides === 1 ? '버스 → 트램 → 도보/대중교통' : '도보·대중교통 + 트램 시뮬레이션',
      routeNumbers: [...(a.route.routeNumbers || []), '대전 트램(가상)', ...(b.route.routeNumbers || [])],
      score
    });
  }
  if (!combos.length) {
    const error = new Error('트램 탑승역까지 또는 하차역부터 연결할 수 있는 경로를 찾지 못했습니다. Transitous에 대전 대중교통 데이터가 없거나, 선택한 정거장까지 연결 경로가 없을 수 있습니다.');
    error.status = 404; error.code = 'HYBRID_TRAM_ROUTE_NOT_FOUND'; throw error;
  }
  // Prefer a genuine bus -> tram -> bus itinerary whenever both feeder sides support a bus route.
  // If unavailable, fall back to any transit on both sides, then the best reachable mixed scenario.
  const busTramBus = combos.filter(route => route.busSides === 2);
  const transitTramTransit = combos.filter(route => route.transitSides === 2);
  const eligible = busTramBus.length ? busTramBus : transitTramTransit.length ? transitTramTransit : combos;
  eligible.sort((a, b) => a.totalMin - b.totalMin || a.score - b.score);
  const best = eligible[0];
  // Use the ordered station coordinates directly. OSRM driving routes can diverge from tram alignment.
  // This is a schematic connector, not an official track geometry.
  best.ride.geometry = (best.ride.path || []).map(s => [Number(s.lat), Number(s.lon)]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  best.geometry = uniqueLatLon([...(best.access.geometry || []), ...best.ride.geometry, ...(best.egress.geometry || [])]);
  best.geometrySource = 'station-coordinate schematic (not official track alignment)';
  best.fare = null;
  best.transferCount = Number(best.access.transferCount || 0) + Number(best.egress.transferCount || 0) + 1;
  const saved = current.timeMin - best.totalMin;
  const pct = current.timeMin > 0 ? saved / current.timeMin * 100 : null;
  return {
    current, currentRoutes: full.routes, tram: best,
    comparison: { currentTimeMin: current.timeMin, tramTimeMin: best.totalMin, minutesSaved: saved, reductionPercent: pct, resultType: 'transitous_bus_tram_bus_simulation' },
    assumptions: {
      tramSpeedKmh: best.ride.tramSpeed,
      headwayMin: best.ride.headway, dwellSec: best.ride.dwell,
      transferBufferMin, tramTotalKm: network.totalDistanceKm,
      tramDistanceBasis: 'sum of JSON schematic links, no fixed-length rescaling',
      tramBranchOperation: 'JSON-permitted junction transitions, simulation assumption only',
      accessEgressSource: 'Transitous public-transport routing where available; walking fallback only for short connections',
      note: 'Feeder bus routes are planned separately at the current time, then combined with a hypothetical tram leg. This is a scenario estimate, not a synchronized timetable.'
    },
    stationCount: stations.length, currentProvider: 'Transitous 무료 공개 대중교통 경로 API',
    candidateSummary: eligible.slice(0,4).map(route => ({startStation:route.startStation.name,endStation:route.endStation.name,totalMin:route.totalMin,busSides:route.busSides,modeChain:route.modeChain}))
  };
}

function compareRoutesTagoUnused(start,end,params={}) {
  if(!busDataset)throw new Error('대전 버스 데이터가 아직 준비되지 않았습니다.');
  const speed=nval(params.busSpeed,17);
  const walk=nval(params.walkSpeed,4.5);
  const graph=buildGraph(busDataset,speed);
  const current=findBusRoute(graph,start,end,{walkSpeedKmh:walk});
  const stations=getTramNetwork().stations();
  const accessCandidates=nearestTram(stations,start,5);
  const egressCandidates=nearestTram(stations,end,5);
  const access=accessCandidates.map(station=>({station,route:findBusRoute(graph,start,{lat:station.lat,lon:station.lon},{walkSpeedKmh:walk})})).filter(x=>x.route);
  const egress=egressCandidates.map(station=>({station,route:findBusRoute(graph,{lat:station.lat,lon:station.lon},end,{walkSpeedKmh:walk})})).filter(x=>x.route);
  let best=null;
  const {tramSpeed,headway,dwell}=rideParameters(params);
  for(const a of access)for(const b of egress) {
    const estimate=estimateTramRide(stations,a.station,b.station,{tramSpeed,headway,dwell});
    if(!estimate)continue;
    const {ride,rideMin}=estimate;
    const total=a.route.timeMin+rideMin+b.route.timeMin;
    if(!best||total<best.totalMin)best={startStation:a.station,endStation:b.station,ride,totalMin:total,access:a.route,egress:b.route,rideMin,waitMin:headway/2};
  }
  if(best) {
    best.geometry=best.ride.path.map(s=>[s.lat,s.lon]);
    best.segments=[{label:'출발지 → 트램 탑승역',minutes:best.access.timeMin,sub:best.access.routeNumbers.length?`${best.access.routeNumbers.join('번 → ')}번 버스 이용`:'도보 접근'},{label:`트램 ${best.startStation.name} → ${best.endStation.name}`,minutes:best.rideMin,sub:`${best.ride.distanceKm.toFixed(1)}km · 트램 대기 ${Math.round(best.waitMin)}분 포함`},{label:'트램 하차역 → 목적지',minutes:best.egress.timeMin,sub:best.egress.routeNumbers.length?`${best.egress.routeNumbers.join('번 → ')}번 버스 이용`:'도보 접근'}];
  }
  const minutesSaved = current && best ? current.timeMin - best.totalMin : null;
  const reductionPercent = current && current.timeMin > 0 && Number.isFinite(minutesSaved) ? (minutesSaved / current.timeMin) * 100 : null;
  if (best) {
    best.minutesSaved = Number.isFinite(minutesSaved) ? minutesSaved : null;
    best.reductionPercent = Number.isFinite(reductionPercent) ? reductionPercent : null;
  }
  return {
    current, tram:best,
    comparison: {
      currentTimeMin: current?.timeMin ?? null,
      tramTimeMin: best?.totalMin ?? null,
      minutesSaved: Number.isFinite(minutesSaved) ? minutesSaved : null,
      reductionPercent: Number.isFinite(reductionPercent) ? reductionPercent : null,
      resultType: 'model_estimate'
    },
    dataset:{routes:busDataset.routes.length, routeStops:busDataset.routeStops.length, graphNodes:graph.nodes.length, graphEdges:graph.edgeCount},
    assumptions:{busSpeedKmh:speed,walkSpeedKmh:walk,tramSpeedKmh:tramSpeed,headwayMin:headway,dwellSec:dwell,tramTotalKm:getTramNetwork().totalDistanceKm},
    stationCount:stations.length
  };
}


async function handleApi(req,res,url) {
  if (url.pathname === '/api/health') {
    return sendJson(res,200,{
      ok:true,
      version:'1.13.7-multi-provider-building-search',
      transitProvider:'Transitous / MOTIS',
      transitousEndpoint:TRANSITOUS_PLAN_URL,
      transitousApiKeyRequired:false,
      transitousCacheMinutes:TRANSITOUS_CACHE_TTL_MS/60000,
      transitousGeocoderEndpoint:TRANSITOUS_GEOCODE_URL,
      transitousGeocodeCacheHours:TRANSITOUS_GEOCODE_CACHE_TTL_MS/3600000,
      provider:'현재 대중교통 경로 = Transitous 무료 공개 API; 트램 도입 시 = 대중교통 접근 + 가상 트램 + 대중교통 이탈 혼합 경로',
      addressGeocoder:{primary:'Transitous ADDRESS + PLACE + Photon/OpenStreetMap + Nominatim/OpenStreetMap POI and address search',fallback:'verified local aliases',apiKeyRequired:false,selectionRequired:true,roadAndParcelSearch:true,buildingPlaceCandidates:true},
      tramStations:tramState,
      legacyTagoRoutingUsed:false
    });
  }
  if (url.pathname === '/api/address-search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) return sendJson(res, 200, { source: 'Transitous / MOTIS geocoding', totalCount: 0, results: [] });
    try {
      const payload = await betterAddressSearch(q, 8);
      return sendJson(res, 200, payload);
    } catch (e) {
      return sendJson(res, e.status || 502, { error: e.message, code: e.code || 'TRANSITOUS_GEOCODE_ERROR', provider: 'Transitous / OpenStreetMap' });
    }
  }
  if (url.pathname === '/api/geocode') {
    const q=String(url.searchParams.get('q')||'').trim();
    if(!q)return sendJson(res,400,{error:'출발지 또는 목적지를 입력하세요.'});
    try{return sendJson(res,200,await publicAddressGeocode(q));}
    catch(e){return sendJson(res,e.status||502,{error:e.message,code:e.code||'GEOCODE_ERROR',provider:'Transitous / MOTIS'});}
  }
  if (url.pathname === '/api/tram/stations/load' || url.pathname === '/api/tram/status') {
    try {
      const available=getTramNetwork().stations().length;
      Object.assign(tramState,{status:'ready',progress:available,total:available,available,step:'로컬 트램 그래프 준비 완료',fromCache:true});
      return sendJson(res,200,{...tramState});
    } catch(e) { return sendJson(res,e.status||503,{error:e.message,code:e.code}); }
  }
  if (url.pathname === '/api/transit-route' || url.pathname === '/api/current-route') {
    const startPoint={lat:nval(url.searchParams.get('startLat')),lon:nval(url.searchParams.get('startLon'))};
    const endPoint={lat:nval(url.searchParams.get('endLat')),lon:nval(url.searchParams.get('endLon'))};
    if(!Number.isFinite(startPoint.lat)||!Number.isFinite(startPoint.lon)||!Number.isFinite(endPoint.lat)||!Number.isFinite(endPoint.lon))return sendJson(res,400,{error:'출발지와 목적지 좌표가 필요합니다.'});
    try {
      const result=await transitousRoutes(startPoint,endPoint,Number(url.searchParams.get('count')||3));
      return sendJson(res,200,{...result,current:{...result.best,alternatives:result.routes.slice(1,5)}});
    } catch(e) { return sendJson(res,e.status||502,{error:e.message,code:e.code||'TRANSITOUS_ROUTE_ERROR',detail:e.detail||undefined}); }
  }
  if (url.pathname === '/api/compare') {
    const startPoint={lat:nval(url.searchParams.get('startLat')),lon:nval(url.searchParams.get('startLon'))};
    const endPoint={lat:nval(url.searchParams.get('endLat')),lon:nval(url.searchParams.get('endLon'))};
    if(!Number.isFinite(startPoint.lat)||!Number.isFinite(startPoint.lon)||!Number.isFinite(endPoint.lat)||!Number.isFinite(endPoint.lon))return sendJson(res,400,{error:'출발지와 목적지 좌표가 필요합니다.'});
    try {
      getTramNetwork();
      const result=await compareRoutesWithTransitous(startPoint,endPoint,{tramSpeed:url.searchParams.get('tramSpeed'),headway:url.searchParams.get('headway'),dwell:url.searchParams.get('dwell')});
      return sendJson(res,200,result);
    } catch(e) { return sendJson(res,e.status||502,{error:e.message,code:e.code||'TRANSITOUS_COMPARE_ERROR',detail:e.detail||undefined}); }
  }
  if (url.pathname.startsWith('/api/data/')) return sendJson(res,404,{error:'이 Transitous 무료 경로 버전에는 TAGO 데이터 엔드포인트가 없습니다.',code:'ENDPOINT_NOT_FOUND'});
  return sendJson(res,404,{error:'API endpoint not found.'});
}

// Restore a fresh bus cache at launch so follow-up searches are fast.
try {
  if (existsSync(BUS_CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(BUS_CACHE_PATH,'utf8'));
    if (cached.cityCode === CITY_CODE && cached.routes?.length && cached.routeStops?.length && Date.now()-Number(cached.fetchedAt||0)<24*60*60*1000) {
      busDataset=cached; Object.assign(busState,{status:'ready',progress:1,total:1,step:'캐시 데이터 준비 완료',routeCount:cached.routes.length,stopCount:cached.routeStops.length,fromCache:true});
    }
  }
  if (existsSync(TRAM_CACHE_PATH)) {
    tramCache=JSON.parse(readFileSync(TRAM_CACHE_PATH,'utf8'))||{};
    const available=Object.keys(tramCache).filter(k=>Number.isFinite(tramCache[k]?.lat)&&Number.isFinite(tramCache[k]?.lon)).length;
    if(available>=20)Object.assign(tramState,{status:'ready',progress:available,total:STATIONS.length,available,step:'캐시 정거장 좌표 준비 완료',fromCache:true});
  }
} catch { /* Ignore damaged cache; it will be rebuilt. */ }

const server=createServer(async(req,res)=>{
  const host=req.headers.host||`localhost:${PORT}`; const url=new URL(req.url||'/',`http://${host}`);
  if(url.pathname.startsWith('/api/')) { if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();} return handleApi(req,res,url); }
  let requestPath;
  try { requestPath=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname); }
  catch { res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Bad request path'); }
  const publicDir=path.resolve(__dirname,'public');
  const fullPath=path.resolve(publicDir, `.${requestPath}`);
  if(fullPath!==publicDir && !fullPath.startsWith(publicDir+path.sep)){res.writeHead(403);return res.end('Forbidden');}
  try {const body=await readFile(fullPath);res.writeHead(200,{'Content-Type':MIME[path.extname(fullPath)]||'application/octet-stream'});res.end(body);}
  catch {res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');}
});
export {estimateTramRide, compareRoutesWithTransitous};
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) server.listen(PORT,()=>{
  console.log(`Daejeon Tram Route Lab v1.13.7 (multi-provider building search; origin + destination picker; no key): http://localhost:${PORT}`);
  console.log(`Current transit route provider: Transitous (${TRANSITOUS_PLAN_URL}); no API key required; ${TRANSITOUS_CACHE_TTL_MS/60000}-minute memory cache.`);
  console.log(`Address/place autocomplete: Transitous ADDRESS + PLACE, Photon/OSM, and Nominatim/OSM (building candidates enabled; no API key; explicit selection required). Endpoint: ${TRANSITOUS_GEOCODE_URL}`);
  if(tramState.status==='ready') console.log(`Tram station cache loaded: ${tramState.available} stations`);
});
