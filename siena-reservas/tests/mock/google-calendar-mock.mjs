// ================================================================================================
//  MOCK de Google Calendar API v3 — SOLO PARA PRUEBAS. No es Google y no prueba la integración real.
//  Imita las reglas documentadas en el documento de descubrimiento oficial (revision 20261030):
//   · events.insert acepta un id propio [a-v0-9]{5,1024}; un id repetido responde 409.
//   · events.delete deja el evento con status "cancelled"; events.get lo sigue devolviendo.
//   · events.list no devuelve cancelados salvo showDeleted=true; timeMin filtra por fin y timeMax por inicio.
//  Diferencia conocida: en Google la detección de ids duplicados NO está garantizada al crear
//  ("we cannot guarantee that ID collisions will be detected at event creation time"); aquí sí.
//  Por eso el sistema no usa el id como candado: usa la tabla de candados de n8n.
//
//  Control de pruebas (no existe en Google):
//    POST /__mock/reset            {calendarios:[...], eventos:[{calendarId, ...evento}]}
//    POST /__mock/fallas           [{metodo, contiene, modo:'status'|'demora'|'aplicar-y-cortar', status, ms, veces}]
//    GET  /__mock/estado           eventos + contador de llamadas
// ================================================================================================
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);
let calendarios = new Set();
let eventos = new Map(); // calendarId -> Map(id -> evento)
let fallas = [];
let llamadas = [];
let etagSeq = 1;

const json = (res, status, body, headers = {}) => {
  const txt = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', ...headers });
  res.end(txt);
};
const gErr = (res, status, message, reason) => json(res, status, { error: { code: status, message, errors: [{ domain: 'global', reason: reason || 'error', message }] } });
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({ __invalido: true }); } }); });
const cal = (id) => { if (!eventos.has(id)) eventos.set(id, new Map()); return eventos.get(id); };
const pick = (e) => ({ id: e.id, status: e.status, start: e.start, end: e.end, ...(e.transparency ? { transparency: e.transparency } : {}) });
const startMs = (x) => (x.dateTime ? Date.parse(x.dateTime) : Date.parse(x.date + 'T00:00:00-03:00'));

function tomarFalla(method, path) {
  const f = fallas.find((x) => (!x.metodo || x.metodo === method) && (!x.contiene || path.includes(x.contiene)) && x.veces > 0);
  if (f) f.veces -= 1;
  return f;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;
  const method = req.method;

  if (path === '/__mock/reset' && method === 'POST') {
    const b = await readBody(req);
    calendarios = new Set(b.calendarios || []); eventos = new Map(); fallas = []; llamadas = [];
    for (const e of b.eventos || []) cal(e.calendarId).set(e.id, { status: 'confirmed', etag: `"${etagSeq++}"`, ...e, calendarId: undefined });
    return json(res, 200, { ok: true });
  }
  if (path === '/__mock/fallas' && method === 'POST') { fallas.push(...(await readBody(req))); return json(res, 200, { ok: true, fallas }); }
  if (path === '/__mock/estado' && method === 'GET') {
    const out = {};
    for (const [c, m] of eventos) out[c] = [...m.values()];
    return json(res, 200, { eventos: out, llamadas });
  }

  const m = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (!m) return gErr(res, 404, 'Not Found', 'notFound');
  if (!/^Bearer \S+/.test(req.headers.authorization || '')) return gErr(res, 401, 'Login Required', 'required');
  const calendarId = decodeURIComponent(m[1]);
  const eventId = m[2] ? decodeURIComponent(m[2]) : null;
  llamadas.push({ method, eventId, t: Date.now() });
  if (!calendarios.has(calendarId)) return gErr(res, 404, 'Not Found', 'notFound');

  const falla = tomarFalla(method, path);
  if (falla && falla.modo === 'status') return gErr(res, falla.status || 503, 'Backend Error (simulado)', 'backendError');
  if (falla && falla.modo === 'demora') await new Promise((r) => setTimeout(r, falla.ms || 15000));
  const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? await readBody(req) : null;
  const store = cal(calendarId);

  // Ejecuta la operación y devuelve [status, cuerpo]
  let r;
  if (!eventId && method === 'GET') {
    const tMin = url.searchParams.get('timeMin'), tMax = url.searchParams.get('timeMax');
    const showDeleted = url.searchParams.get('showDeleted') === 'true';
    const items = [...store.values()].filter((e) => (showDeleted || e.status !== 'cancelled')
      && (!tMin || startMs(e.end) > Date.parse(tMin)) && (!tMax || startMs(e.start) < Date.parse(tMax)));
    const fields = url.searchParams.get('fields') || '';
    r = [200, { kind: 'calendar#events', items: fields.startsWith('items(id,status,start,end,transparency)') ? items.map(pick) : items }];
  } else if (!eventId && method === 'POST') {
    if (body.__invalido) r = [400, { error: { code: 400, message: 'Parse Error' } }];
    else if (body.id !== undefined && !/^[a-v0-9]{5,1024}$/.test(body.id)) r = [400, { error: { code: 400, message: 'Invalid resource id value.' } }];
    else if (body.id && store.has(body.id)) r = [409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } }];
    else {
      const e = { ...body, id: body.id || 'mock' + Math.random().toString(32).slice(2), status: body.status || 'confirmed', etag: `"${etagSeq++}"` };
      store.set(e.id, e); r = [200, e];
    }
  } else if (eventId && method === 'GET') {
    r = store.has(eventId) ? [200, store.get(eventId)] : [404, { error: { code: 404, message: 'Not Found' } }];
  } else if (eventId && method === 'PATCH') {
    if (!store.has(eventId)) r = [404, { error: { code: 404, message: 'Not Found' } }];
    else { const e = { ...store.get(eventId), ...body, id: eventId, etag: `"${etagSeq++}"` }; store.set(eventId, e); r = [200, e]; }
  } else if (eventId && method === 'DELETE') {
    if (!store.has(eventId)) r = [404, { error: { code: 404, message: 'Not Found' } }];
    else if (store.get(eventId).status === 'cancelled') r = [410, { error: { code: 410, message: 'Resource has been deleted' } }];
    else { store.get(eventId).status = 'cancelled'; r = [204, undefined]; }
  } else r = [405, { error: { code: 405, message: 'Method not allowed' } }];

  if (falla && falla.modo === 'aplicar-y-cortar') { req.socket.destroy(); return; } // respuesta perdida
  return json(res, r[0], r[1]);
});

server.listen(PORT, '127.0.0.1', () => console.log(`MOCK Google Calendar escuchando en http://127.0.0.1:${PORT}/calendar/v3`));
