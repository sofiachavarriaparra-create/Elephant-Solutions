#!/usr/bin/env node
// Genera los workflows importables de n8n a partir de:
//   core/siena-core.js  (lógica pura, probada con tests/unit)
//   config/siena.config.json  (o, si no existe, config/siena.config.example.json)
//
// Uso:
//   node scripts/build-workflows.mjs                       → n8n/workflows/*.json (entrega, inactivos)
//   node scripts/build-workflows.mjs --config=X --salida=Y --credencial-id=Z --con-ids
//                                                         → variante para pruebas locales con el MOCK
// Los nodos Code no tienen red (sandbox de n8n): solo calculan. Las llamadas van por nodos HTTP Request
// (Google Calendar, credencial OAuth2 de n8n) y Data table (estado persistente y candados).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const cfgPath = args.config ? resolve(args.config) : existsSync(`${ROOT}/config/siena.config.json`) ? `${ROOT}/config/siena.config.json` : `${ROOT}/config/siena.config.example.json`;
const OUT = args.salida ? resolve(args.salida) : `${ROOT}/n8n/workflows`;
const CFG = JSON.parse(readFileSync(cfgPath, 'utf8'));
const CORE_SRC = readFileSync(`${ROOT}/core/siena-core.js`, 'utf8');
const CRED_ID = args['credencial-id'] || null;
const WITH_IDS = !!args['con-ids'];
const T = CFG.tablas;

// Validación previa con el mismo núcleo
const { DateTime } = await import('luxon');
const { createSienaCore } = (await import('node:module')).createRequire(import.meta.url)('../core/siena-core.js');
const problems = createSienaCore(DateTime).validateConfig(CFG);
if (problems.length) { console.error('Configuración inválida:\n- ' + problems.join('\n- ')); process.exit(1); }

/* ------------------------------------------------------------------ utilidades de construcción */
const uid = (s) => { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const bodyOf = (fn) => { const t = fn.toString(); return t.slice(t.indexOf('{') + 1, t.lastIndexOf('}')).replace(/^\n/, ''); };
// El núcleo se minifica (esbuild) para que los nodos pesen menos; la fuente legible es core/siena-core.js.
const { transformSync } = await import('esbuild');
const CORE_MIN = transformSync(CORE_SRC.replace(/^if \(typeof module.*$/m, ''), { minify: true, legalComments: 'none', target: 'es2020' }).code;
const PRELUDE = `// ===== Generado por scripts/build-workflows.mjs: no editar a mano (editar core/ o config/ y regenerar) =====
${CORE_MIN}
const CORE = createSienaCore(DateTime);
const CFG = ${JSON.stringify(CFG)};
const NOW = Date.now();
const resp = (status, code, extra) => [{ json: { route: 'responder', response: CORE.fail(status, code, extra) } }];
const respond = (status, body) => [{ json: { route: 'responder', response: { status, body } } }];
const liberar = (response) => [{ json: { route: 'liberar', response } }];
const CONFLICTOS = ['hora_tomada', 'clave_reutilizada', 'reserva_cancelada', 'fuera_de_plazo', 'cruza_descanso', 'fuera_de_horario', 'muy_pronto', 'hora_pasada', 'fuera_de_horizonte', 'servicio_no_disponible'];
const lockFail = (code) => liberar(CORE.fail(CONFLICTOS.includes(code) ? 409 : 503, code));
// ===== Lógica del nodo =====
`;
const SCHEMA = {
  reservas: { reserva: 'string', estado: 'string', huella: 'string', tokenHash: 'string', servicio: 'string', profesional: 'string', calendario: 'string', evento: 'string', inicio: 'string', fin: 'string', telefonoHash: 'string', version: 'number', ultimoError: 'string', consentimiento: 'boolean', entorno: 'string' },
  avisos: { reserva: 'string', tipo: 'string', destinatario: 'string', canal: 'string', estado: 'string', programadaPara: 'number', inicioRef: 'string', intentos: 'number', reclamo: 'string', reclamadaEn: 'number', resultado: 'string', vistaPrevia: 'string' },
  candados: { recurso: 'string', titular: 'string', bloqueadoHasta: 'number', adquiridoEn: 'number' },
};

class WF {
  constructor(name, settings = {}) {
    this.name = name; this.nodes = []; this.connections = {}; this.x = 0;
    this.settings = { executionOrder: 'v1', timezone: CFG.entorno.zonaHoraria, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner', ...settings };
  }
  add(n, [x, y] = [this.x += 240, 300]) { n.id = uid(this.name + '|' + n.name); n.position = [x, y]; this.nodes.push(n); return n.name; }
  link(from, to, out = 0, inp = 0) {
    const c = (this.connections[from] ||= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to, type: 'main', index: inp });
  }
  chain(...names) { for (let i = 0; i < names.length - 1; i++) this.link(names[i], names[i + 1]); return names[names.length - 1]; }
  toJSON() {
    const j = { name: this.name, nodes: this.nodes, connections: this.connections, settings: this.settings, pinData: {}, active: false, meta: { templateCredsSetupCompleted: false, generadoPor: 'siena-reservas/scripts/build-workflows.mjs' } };
    if (WITH_IDS) j.id = createHash('sha256').update(this.name).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 16);
    return j;
  }
}
const code = (name, fn, { core = true, ...extra } = {}) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: (core ? PRELUDE : '// ===== Generado por scripts/build-workflows.mjs =====\nconst NOW = Date.now();\n') + bodyOf(fn) }, ...extra });
const iff = (name, expr) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.2,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(name), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
});
const webhook = (name, path) => ({
  name, type: 'n8n-nodes-base.webhook', typeVersion: 2.1, webhookId: uid('webhook|' + path),
  parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: { allowedOrigins: CFG.backend.origenesPermitidos.join(','), ignoreBots: true } },
});
const respondNode = (name) => ({
  name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4,
  parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.response.body) }}', options: { responseCode: '={{ $json.response.status }}', responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }, { name: 'X-Content-Type-Options', value: 'nosniff' }, { name: 'Referrer-Policy', value: 'no-referrer' }] } } },
});
const gcal = (name, method, urlExpr, bodyExpr) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  parameters: {
    method, url: `={{ ${urlExpr} }}`, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api',
    ...(bodyExpr ? { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}` } : {}),
    options: { response: { response: { fullResponse: true, neverError: true } }, timeout: CFG.google.timeoutMs || 8000 },
  },
  credentials: { googleCalendarOAuth2Api: CRED_ID ? { id: CRED_ID, name: CFG.google.credencial } : { name: CFG.google.credencial } },
  onError: 'continueRegularOutput', executeOnce: false,
});
const table = (t) => ({ __rl: true, mode: 'name', value: T[t] });
const conds = (list) => ({ conditions: list.map(([keyName, condition, keyValue]) => (keyValue === undefined ? { keyName, condition } : { keyName, condition, keyValue })) });
const columns = (t, values) => ({
  mappingMode: 'defineBelow', value: values, matchingColumns: [],
  schema: Object.keys(values).map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: SCHEMA[t][id], canBeUsedToMatch: true })),
});
const fromObj = (t, src, cols) => Object.fromEntries((cols || Object.keys(SCHEMA[t])).map((c) => [c, `={{ ${src}.${c} }}`]));
const dtGet = (name, t, list, { limit = 50, returnAll = false, matchType = 'allConditions', orderBy, ...extra } = {}) => ({
  name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
  parameters: { resource: 'row', operation: 'get', dataTableId: table(t), matchType, filters: conds(list), returnAll, ...(returnAll ? {} : { limit }), ...(orderBy ? { orderBy: true, orderByColumn: orderBy[0], orderByDirection: orderBy[1] } : {}) },
  alwaysOutputData: true, ...extra,
});
const dtWrite = (op) => (name, t, list, values, extra = {}) => ({
  name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
  parameters: { resource: 'row', operation: op, dataTableId: table(t), ...(list ? { matchType: 'allConditions', filters: conds(list) } : {}), columns: columns(t, values), options: {} },
  alwaysOutputData: true, ...extra,
});
const dtUpdate = dtWrite('update'), dtUpsert = dtWrite('upsert');
const dtInsert = (name, t, values, extra) => dtWrite('insert')(name, t, null, values, extra);

/* =================================================================================================
   00 · Preparar tablas (ejecución manual, una vez)
   ================================================================================================= */
function wf00() {
  const w = new WF('Siena PRUEBAS · 00 Preparar tablas', { executionTimeout: 120 });
  const t = w.add({ name: 'Ejecutar manualmente', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} });
  const mk = (tk) => w.add({ name: `Crear tabla ${T[tk]}`, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, executeOnce: true,
    parameters: { resource: 'table', operation: 'create', tableName: T[tk], columns: { column: Object.entries(SCHEMA[tk]).map(([name, type]) => ({ name, type })) }, options: { createIfNotExists: true } } });
  const a = mk('reservas'), b = mk('avisos'), c = mk('candados');
  const ex = w.add(dtGet('Candados existentes', 'candados', [['recurso', 'isNotEmpty']], { returnAll: true, executeOnce: true }));
  const falt = w.add(code('Candados faltantes', function () {
    const existentes = new Set($input.all().map((i) => i.json.recurso).filter(Boolean));
    const faltan = CFG.profesionales.map((p) => p.id).filter((id) => !existentes.has(id));
    if (!faltan.length) return [{ json: { nada: true } }];
    return faltan.map((recurso) => ({ json: { recurso, titular: '', bloqueadoHasta: 0, adquiridoEn: 0 } }));
  }));
  const hay = w.add(iff('¿Faltan candados?', '$json.nada !== true'));
  const ins = w.add(dtInsert('Crear candados (uno por profesional)', 'candados', fromObj('candados', '$json')));
  w.chain(t, a, b, c, ex, falt, hay); w.link(hay, ins, 0);
  return w;
}

/* =================================================================================================
   01 · Disponibilidad  (POST /webhook/<rutas.disponibilidad>)
   ================================================================================================= */
function wf01() {
  const w = new WF('Siena PRUEBAS · 01 Disponibilidad', { executionTimeout: 30 });
  const hook = w.add(webhook('Webhook disponibilidad', CFG.backend.rutas.disponibilidad));
  const val = w.add(code('Validar consulta', function () {
    const req = $input.first().json;
    const store = $getWorkflowStaticData('global');
    const gate = CORE.productionGate(CFG);
    if (!gate.ok) return resp(503, gate.code);
    if (!CORE.rateLimit(store, 'disp', CORE.clientIp(req.headers, CFG.limites.saltosProxy), CFG.limites.disponibilidadPorMinutoIp, 60000, NOW)) return resp(429, 'demasiadas_solicitudes');
    const q = CORE.validateAvailabilityQuery(CFG, req.body, NOW);
    if (!q.ok) return [{ json: { route: 'responder', response: q.res } }];
    if (q.accion === 'catalogo') return respond(200, CORE.publicCatalog(CFG));
    return q.candidatos.map((pid) => {
      const p = CFG.profesionales.find((x) => x.id === pid);
      return { json: { route: 'consultar', q, profId: pid, url: CORE.listUrl(CFG, p.calendarId, q.timeMin, q.timeMax) } };
    });
  }));
  const ifq = w.add(iff('¿Consultar agenda?', "$json.route === 'consultar'"));
  const list = w.add(gcal('Leer ocupación (Google Calendar)', 'GET', '$json.url'));
  const calc = w.add(code('Calcular horarios', function () {
    const reqs = $('Validar consulta').all();
    const res = $input.all();
    const q = reqs[0].json.q;
    const busyByProf = {};
    for (let i = 0; i < res.length; i++) {
      const r = CORE.busyFromListResult(CFG, res[i], null);
      if (!r.ok) return resp(503, r.code);
      busyByProf[reqs[i].json.profId] = r.busy;
    }
    return respond(200, CORE.computeAvailability(CFG, q, busyByProf, NOW));
  }));
  const out = w.add(respondNode('Responder'));
  w.chain(hook, val, ifq); w.link(ifq, list, 0); w.chain(list, calc, out); w.link(ifq, out, 1);
  return w;
}

/* ------------------------------------------------------------ candado (compartido por 02 y 03) */
function lockNodes(w, prefix, srcPlan) {
  // Compare-and-swap en la tabla de candados: solo actualiza si el candado está libre o vencido.
  const pedir = w.add(dtUpdate(`${prefix}Pedir candado`, 'candados',
    [['recurso', 'eq', `={{ ${srcPlan}.profId }}`], ['bloqueadoHasta', 'lt', `={{ ${srcPlan}.now }}`]],
    { titular: `={{ ${srcPlan}.lockToken }}`, bloqueadoHasta: `={{ ${srcPlan}.lockUntil }}`, adquiridoEn: `={{ ${srcPlan}.now }}` }, { executeOnce: true }));
  const leer = w.add(dtGet(`${prefix}Leer candado`, 'candados', [['recurso', 'eq', `={{ ${srcPlan}.profId }}`]], { executeOnce: true, limit: 10 }));
  return [pedir, leer];
}
function releaseNodes(w, planNode) {
  const prep = w.add(code('Preparar liberación', function () {
    const plan = $('__PLAN__').first().json;
    return [{ json: { response: $input.first().json.response, profId: plan.profId, lockToken: plan.lockToken } }];
  }, { core: false }));
  w.nodes[w.nodes.length - 1].parameters.jsCode = w.nodes[w.nodes.length - 1].parameters.jsCode.replace('__PLAN__', planNode);
  const lib = w.add(dtUpdate('Liberar candado', 'candados', [['recurso', 'eq', '={{ $json.profId }}'], ['titular', 'eq', '={{ $json.lockToken }}']], { bloqueadoHasta: '={{ 0 }}' }, { executeOnce: true }));
  const fin = w.add(code('Respuesta final', function () {
    return [{ json: { response: $('Preparar liberación').first().json.response } }];
  }, { core: false }));
  w.chain(prep, lib, fin);
  return [prep, fin];
}

/* =================================================================================================
   02 · Reservar  (POST /webhook/<rutas.reservar>)
   ================================================================================================= */
function wf02() {
  const w = new WF('Siena PRUEBAS · 02 Reservar', { executionTimeout: Math.floor((CFG.candado.duracionMs - CFG.candado.margenMinimoMs) / 1000) });
  const hook = w.add(webhook('Webhook reservar', CFG.backend.rutas.reservar));
  const val = w.add(code('Validar solicitud', function () {
    const req = $input.first().json;
    const store = $getWorkflowStaticData('global');
    const gate = CORE.productionGate(CFG);
    if (!gate.ok) return resp(503, gate.code);
    if (!CORE.rateLimit(store, 'res', CORE.clientIp(req.headers, CFG.limites.saltosProxy), CFG.limites.reservasPor10MinIp, 600000, NOW)) return resp(429, 'demasiadas_solicitudes');
    const v = CORE.validateBooking(CFG, req.body, NOW);
    if (!v.ok) return [{ json: { route: 'responder', response: v.res } }];
    const d = v.data;
    // Reglas sin ocupación (horario, anticipación, horizonte): si ninguna candidata sirve, no se toca la agenda.
    const reglas = d.candidatos.map((pid) => CORE.checkSlot(CFG, { profId: pid, serviceId: d.servicioId, startMs: d.startMs, busy: [], nowMs: NOW }));
    if (!reglas.some((r) => r.ok)) return resp(409, reglas[0].code);
    return [{ json: {
      route: 'continuar', d,
      lockToken: `${d.reserva}.${NOW.toString(36)}.${Math.random().toString(36).slice(2, 10)}`,
      timeMin: new Date(d.startMs - 12 * 3600e3).toISOString(), timeMax: new Date(d.endMs + 12 * 3600e3).toISOString(),
    } }];
  }));
  const if1 = w.add(iff('¿Solicitud válida?', "$json.route === 'continuar'"));
  const buscar = w.add(dtGet('Buscar reserva por clave', 'reservas', [['reserva', 'eq', "={{ $json.d.reserva }}"]], { limit: 1 }));
  const reint = w.add(code('¿Reintento o reserva nueva?', function () {
    const v = $('Validar solicitud').first().json;
    const row = $input.first().json;
    const existing = row && row.reserva ? row : null;
    if (existing) {
      if (existing.huella !== v.d.huella) return resp(409, 'clave_reutilizada');
      if (existing.estado === 'confirmada') return respond(200, { ok: true, idempotente: true, reserva: CORE.bookingSummary(CFG, existing) });
      if (existing.estado === 'cancelada') return resp(409, 'reserva_cancelada');
    }
    const candidatos = existing ? [existing.profesional] : v.d.candidatos;
    return candidatos.map((pid) => {
      const p = CFG.profesionales.find((x) => x.id === pid);
      return { json: { route: 'continuar', profId: pid, url: CORE.listUrl(CFG, p.calendarId, v.timeMin, v.timeMax) } };
    });
  }));
  const if2 = w.add(iff('¿Consultar agenda?', "$json.route === 'continuar'"));
  const pre = w.add(gcal('Ocupación previa (Google Calendar)', 'GET', '$json.url'));
  const elegir = w.add(code('Elegir profesional', function () {
    const v = $('Validar solicitud').first().json;
    const reqs = $('¿Reintento o reserva nueva?').all();
    const res = $input.all();
    let last = 'hora_tomada';
    for (let i = 0; i < res.length; i++) {
      const r = CORE.busyFromListResult(CFG, res[i], v.d.evento);
      if (!r.ok) return resp(503, r.code);
      const c = CORE.checkSlot(CFG, { profId: reqs[i].json.profId, serviceId: v.d.servicioId, startMs: v.d.startMs, busy: r.busy, nowMs: NOW });
      if (c.ok) return [{ json: { route: 'continuar', profId: reqs[i].json.profId, now: NOW, lockUntil: NOW + CFG.candado.duracionMs, lockToken: v.lockToken } }];
      last = c.code;
    }
    return resp(409, last);
  }));
  const if3 = w.add(iff('¿Hay profesional libre?', "$json.route === 'continuar'"));
  const [pedir, leer] = lockNodes(w, '', "$('Elegir profesional').first().json");
  const propio = w.add(code('¿Candado propio?', function () {
    const e = $('Elegir profesional').first().json;
    const v = $('Validar solicitud').first().json;
    const rows = $input.all().map((i) => i.json).filter((r) => r && r.recurso);
    if (!rows.length) return [{ json: { route: 'responder', response: Object.assign(CORE.fail(503, 'configuracion_incompleta'), {}) } }];
    if (!rows.every((r) => r.titular === e.lockToken && Number(r.bloqueadoHasta) === e.lockUntil)) return resp(503, 'agenda_ocupada');
    const p = CFG.profesionales.find((x) => x.id === e.profId);
    return [{ json: { route: 'continuar', listUrl: CORE.listUrl(CFG, p.calendarId, v.timeMin, v.timeMax), getUrl: CORE.eventUrl(CFG, p.calendarId, v.d.evento) } }];
  }));
  const if4 = w.add(iff('¿Candado obtenido?', "$json.route === 'continuar'"));
  const releer = w.add(dtGet('Releer reserva (con candado)', 'reservas', [['reserva', 'eq', "={{ $('Validar solicitud').first().json.d.reserva }}"]], { limit: 1, executeOnce: true }));
  const reval = w.add({ ...gcal('Revalidar ocupación (Google Calendar)', 'GET', "$('¿Candado propio?').first().json.listUrl"), executeOnce: true });
  const leerEv = w.add({ ...gcal('Buscar evento propio (Google Calendar)', 'GET', "$('¿Candado propio?').first().json.getUrl"), executeOnce: true });
  const decidir = w.add(code('Decidir creación', function () {
    const v = $('Validar solicitud').first().json;
    const e = $('Elegir profesional').first().json;
    const rowIn = $('Releer reserva (con candado)').first().json;
    const row = rowIn && rowIn.reserva ? rowIn : null;
    // Cerca de tiempo: si el candado está por vencer, no se crea nada.
    if (NOW - e.now > CFG.candado.duracionMs - CFG.candado.margenMinimoMs) return lockFail('agenda_ocupada');
    if (row) {
      if (row.huella !== v.d.huella) return lockFail('clave_reutilizada');
      if (row.estado === 'confirmada') return liberar({ status: 200, body: { ok: true, idempotente: true, reserva: CORE.bookingSummary(CFG, row) } });
      if (row.estado === 'cancelada') return lockFail('reserva_cancelada');
    }
    const profId = row ? row.profesional : e.profId;
    const p = CFG.profesionales.find((x) => x.id === profId);
    const target = CORE.bookingRow(CFG, v.d, profId, 'creando', row ? { version: Number(row.version) || 1 } : {});
    const g = CORE.httpResult($input.first());
    if (g.ok && g.body && g.body.status !== 'cancelled') {
      const mine = g.body.extendedProperties && g.body.extendedProperties.private && g.body.extendedProperties.private.sienaReserva === v.d.reserva;
      if (!mine) return lockFail('calendario_no_disponible');
      return [{ json: { route: 'confirmar', row: target } }]; // el evento ya existía (respuesta perdida)
    }
    if (g.ok && g.body && g.body.status === 'cancelled') return lockFail('reserva_cancelada');
    if (!g.ok && g.status !== 404) return lockFail('calendario_no_disponible');
    const r = CORE.busyFromListResult(CFG, $('Revalidar ocupación (Google Calendar)').first(), v.d.evento);
    if (!r.ok) return lockFail(r.code);
    const c = CORE.checkSlot(CFG, { profId, serviceId: v.d.servicioId, startMs: v.d.startMs, busy: r.busy, nowMs: NOW });
    if (!c.ok) return lockFail(c.code);
    return [{ json: { route: 'crear', row: target, event: CORE.buildEvent(CFG, v.d, profId), insertUrl: CORE.calendarUrl(CFG, p.calendarId, '?sendUpdates=none') } }];
  }));
  const if5 = w.add(iff('¿Liberar sin crear?', "$json.route === 'liberar'"));
  const if6 = w.add(iff('¿Crear evento?', "$json.route === 'crear'"));
  const reg = w.add(dtUpsert('Registrar reserva (creando)', 'reservas', [['reserva', 'eq', '={{ $json.row.reserva }}']], fromObj('reservas', '$json.row'), { executeOnce: true }));
  const crear = w.add({ ...gcal('Crear evento (Google Calendar)', 'POST', "$('Decidir creación').first().json.insertUrl", "$('Decidir creación').first().json.event"), executeOnce: true });
  const resCrear = w.add(code('Resultado creación', function () {
    const r = CORE.httpResult($input.first());
    if (r.ok) return [{ json: { route: 'confirmar' } }];
    return [{ json: { route: 'error', ultimoError: r.status ? 'calendario_' + r.status : (r.timeout ? 'calendario_timeout' : 'calendario_sin_respuesta') } }];
  }));
  const if7 = w.add(iff('¿Evento creado?', "$json.route === 'confirmar'"));
  const marcarErr = w.add(dtUpdate('Marcar error recuperable', 'reservas', [['reserva', 'eq', "={{ $('Decidir creación').first().json.row.reserva }}"]], { estado: '={{ "error_calendario" }}', ultimoError: '={{ $json.ultimoError }}' }, { executeOnce: true }));
  const respErr = w.add(code('Respuesta error recuperable', function () {
    return liberar(CORE.fail(503, 'calendario_no_disponible'));
  }));
  const avEx = w.add(dtGet('Avisos existentes', 'avisos', [['reserva', 'eq', "={{ $('Decidir creación').first().json.row.reserva }}"]], { limit: 20, executeOnce: true }));
  const prepAv = w.add(code('Preparar avisos', function () {
    const row = $('Decidir creación').first().json.row;
    const ya = new Set($input.all().map((i) => i.json).filter((r) => r && r.reserva).map((r) => `${r.tipo}/${r.destinatario}`));
    const nuevos = CORE.notificationRows(CFG, row.reserva, Date.parse(row.inicio), NOW).filter((r) => !ya.has(`${r.tipo}/${r.destinatario}`));
    return nuevos.length ? nuevos.map((r) => ({ json: r })) : [{ json: { nada: true } }];
  }));
  const if8 = w.add(iff('¿Hay avisos nuevos?', '$json.nada !== true'));
  const insAv = w.add(dtInsert('Guardar avisos', 'avisos', fromObj('avisos', '$json')));
  const conf = w.add(dtUpsert('Marcar confirmada', 'reservas', [['reserva', 'eq', "={{ $('Decidir creación').first().json.row.reserva }}"]],
    Object.assign(fromObj('reservas', "$('Decidir creación').first().json.row"), { estado: '={{ "confirmada" }}', ultimoError: '={{ "" }}' }), { executeOnce: true }));
  const respOk = w.add(code('Respuesta confirmada', function () {
    const row = Object.assign({}, $('Decidir creación').first().json.row, { estado: 'confirmada' });
    return liberar({ status: 201, body: { ok: true, reserva: CORE.bookingSummary(CFG, row) } });
  }));
  const [prep, fin] = releaseNodes(w, 'Elegir profesional');
  const out = w.add(respondNode('Responder'));

  w.chain(hook, val, if1); w.link(if1, buscar, 0); w.link(if1, out, 1);
  w.chain(buscar, reint, if2); w.link(if2, pre, 0); w.link(if2, out, 1);
  w.chain(pre, elegir, if3); w.link(if3, pedir, 0); w.link(if3, out, 1);
  w.chain(pedir, leer, propio, if4); w.link(if4, releer, 0); w.link(if4, out, 1);
  w.chain(releer, reval, leerEv, decidir, if5); w.link(if5, prep, 0); w.link(if5, if6, 1);
  w.link(if6, reg, 0); w.link(if6, avEx, 1);
  w.chain(reg, crear, resCrear, if7); w.link(if7, avEx, 0); w.link(if7, marcarErr, 1);
  w.chain(marcarErr, respErr, prep);
  w.chain(avEx, prepAv, if8); w.link(if8, insAv, 0); w.link(if8, conf, 1); w.link(insAv, conf);
  w.chain(conf, respOk, prep);
  w.link(fin, out);
  return w;
}

/* =================================================================================================
   03 · Gestionar cita: consultar, cancelar, reagendar  (POST /webhook/<rutas.gestionar>)
   ================================================================================================= */
function wf03() {
  const w = new WF('Siena PRUEBAS · 03 Gestionar cita', { executionTimeout: Math.floor((CFG.candado.duracionMs - CFG.candado.margenMinimoMs) / 1000) });
  const hook = w.add(webhook('Webhook gestionar', CFG.backend.rutas.gestionar));
  const val = w.add(code('Validar gestión', function () {
    const req = $input.first().json;
    const store = $getWorkflowStaticData('global');
    const gate = CORE.productionGate(CFG);
    if (!gate.ok) return resp(503, gate.code);
    if (!CORE.rateLimit(store, 'gest', CORE.clientIp(req.headers, CFG.limites.saltosProxy), CFG.limites.gestionPor10MinIp, 600000, NOW)) return resp(429, 'demasiadas_solicitudes');
    const m = CORE.validateManage(CFG, req.body);
    if (!m.ok) return [{ json: { route: 'responder', response: m.res } }];
    return [{ json: { route: 'continuar', m } }];
  }));
  const if1 = w.add(iff('¿Solicitud válida?', "$json.route === 'continuar'"));
  const buscar = w.add(dtGet('Buscar reserva', 'reservas', [['reserva', 'eq', '={{ $json.m.reserva }}']], { limit: 1 }));
  const verif = w.add(code('Verificar enlace', function () {
    const m = $('Validar gestión').first().json.m;
    const row = $input.first().json;
    if (!CORE.verifyToken(row, m.clave)) return resp(404, 'enlace_invalido'); // misma respuesta exista o no la reserva
    const summary = CORE.bookingSummary(CFG, row);
    if (m.accion === 'consultar') return respond(200, { ok: true, reserva: summary, puedeCambiar: row.estado === 'confirmada' && CORE.changeDeadlineOk(CFG, row, NOW) });
    if (row.estado === 'cancelada') return m.accion === 'cancelar' ? respond(200, { ok: true, idempotente: true, reserva: summary }) : resp(409, 'reserva_cancelada');
    if (row.estado !== 'confirmada') return resp(503, 'calendario_no_disponible');
    if (!CORE.changeDeadlineOk(CFG, row, NOW)) return resp(409, 'fuera_de_plazo');
    if (m.accion === 'reagendar') {
      const c = CORE.checkSlot(CFG, { profId: row.profesional, serviceId: row.servicio, startMs: m.nuevoInicioMs, busy: [], nowMs: NOW });
      if (!c.ok) return resp(409, c.code);
      if (m.nuevoInicioMs === Date.parse(row.inicio)) return respond(200, { ok: true, idempotente: true, reserva: summary });
    }
    return [{ json: { route: 'continuar', profId: row.profesional, now: NOW, lockUntil: NOW + CFG.candado.duracionMs, lockToken: `${row.reserva}.${NOW.toString(36)}.${Math.random().toString(36).slice(2, 10)}` } }];
  }));
  const if2 = w.add(iff('¿Continuar?', "$json.route === 'continuar'"));
  const [pedir, leer] = lockNodes(w, '', "$('Verificar enlace').first().json");
  const propio = w.add(code('¿Candado propio?', function () {
    const e = $('Verificar enlace').first().json;
    const m = $('Validar gestión').first().json.m;
    const row = $('Buscar reserva').first().json;
    const rows = $input.all().map((i) => i.json).filter((r) => r && r.recurso);
    if (!rows.length) return resp(503, 'configuracion_incompleta');
    if (!rows.every((r) => r.titular === e.lockToken && Number(r.bloqueadoHasta) === e.lockUntil)) return resp(503, 'agenda_ocupada');
    const p = CFG.profesionales.find((x) => x.id === row.profesional);
    const a = Math.min(Date.parse(row.inicio), m.nuevoInicioMs || Infinity) - 12 * 3600e3;
    const b = Math.max(Date.parse(row.fin), (m.nuevoInicioMs || 0) + 12 * 3600e3) + 12 * 3600e3;
    return [{ json: { route: 'continuar', getUrl: CORE.eventUrl(CFG, p.calendarId, row.evento), listUrl: CORE.listUrl(CFG, p.calendarId, new Date(a).toISOString(), new Date(b).toISOString()) } }];
  }));
  const if3 = w.add(iff('¿Candado obtenido?', "$json.route === 'continuar'"));
  const leerEv = w.add({ ...gcal('Leer evento vigente (Google Calendar)', 'GET', "$('¿Candado propio?').first().json.getUrl"), executeOnce: true });
  const leerOc = w.add({ ...gcal('Leer ocupación (Google Calendar)', 'GET', "$('¿Candado propio?').first().json.listUrl"), executeOnce: true });
  const plan = w.add(code('Planificar cambio', function () {
    const e = $('Verificar enlace').first().json;
    const m = $('Validar gestión').first().json.m;
    const row = $('Buscar reserva').first().json;
    if (NOW - e.now > CFG.candado.duracionMs - CFG.candado.margenMinimoMs) return lockFail('agenda_ocupada');
    const g = CORE.httpResult($('Leer evento vigente (Google Calendar)').first());
    const gone = g.status === 404 || g.status === 410 || (g.ok && g.body && g.body.status === 'cancelled');
    if (!g.ok && !gone) return lockFail('calendario_no_disponible');
    const p = CFG.profesionales.find((x) => x.id === row.profesional);
    if (m.accion === 'cancelar') {
      if (gone) return [{ json: { route: 'marcar_cancelada' } }];
      return [{ json: { route: 'borrar', deleteUrl: CORE.eventUrl(CFG, p.calendarId, row.evento, 'sendUpdates=none') } }];
    }
    if (gone) return lockFail('reserva_cancelada');
    const r = CORE.busyFromListResult(CFG, $input.first(), row.evento);
    if (!r.ok) return lockFail(r.code);
    const c = CORE.checkSlot(CFG, { profId: row.profesional, serviceId: row.servicio, startMs: m.nuevoInicioMs, busy: r.busy, nowMs: NOW });
    if (!c.ok) return lockFail(c.code); // la cita original queda intacta
    const zone = CFG.entorno.zonaHoraria;
    const iso = (t) => DateTime.fromMillis(t, { zone }).toISO({ suppressMilliseconds: true });
    return [{ json: {
      route: 'mover',
      patchUrl: CORE.eventUrl(CFG, p.calendarId, row.evento, 'sendUpdates=none'),
      patch: { start: { dateTime: iso(c.startMs), timeZone: zone }, end: { dateTime: iso(c.endMs), timeZone: zone } },
      nuevo: { inicio: new Date(c.startMs).toISOString(), fin: new Date(c.endMs).toISOString(), version: (Number(row.version) || 1) + 1 },
    } }];
  }));
  const if4 = w.add(iff('¿Liberar sin cambios?', "$json.route === 'liberar'"));
  const if5 = w.add(iff('¿Cancelar?', "$json.route === 'borrar' || $json.route === 'marcar_cancelada'"));
  const if6 = w.add(iff('¿Borrar evento?', "$json.route === 'borrar'"));
  const del = w.add({ ...gcal('Borrar evento (Google Calendar)', 'DELETE', '$json.deleteUrl'), executeOnce: true });
  const resDel = w.add(code('Resultado borrado', function () {
    const r = CORE.httpResult($input.first());
    if (r.ok || r.status === 404 || r.status === 410) return [{ json: { route: 'ok' } }];
    return liberar(CORE.fail(503, 'calendario_no_disponible'));
  }));
  const if7 = w.add(iff('¿Borrado?', "$json.route === 'ok'"));
  const marcarC = w.add(dtUpdate('Marcar cancelada', 'reservas', [['reserva', 'eq', "={{ $('Buscar reserva').first().json.reserva }}"]], { estado: '={{ "cancelada" }}' }, { executeOnce: true }));
  const omitir = w.add(dtUpdate('Omitir avisos pendientes', 'avisos', [['reserva', 'eq', "={{ $('Buscar reserva').first().json.reserva }}"], ['estado', 'eq', 'pendiente']], { estado: '={{ "omitido_cancelada" }}', resultado: '={{ "cancelada_por_cliente" }}' }, { executeOnce: true }));
  const avC = w.add(code('Avisos de cancelación', function () {
    const row = $('Buscar reserva').first().json;
    return ['cliente', 'salon'].map((destinatario) => ({ json: {
      reserva: row.reserva, tipo: 'cancelacion', destinatario, canal: 'auto', estado: 'pendiente', programadaPara: NOW,
      inicioRef: row.inicio, intentos: 0, reclamo: '', reclamadaEn: 0, resultado: '', vistaPrevia: '',
    } }));
  }));
  const insC = w.add(dtInsert('Guardar avisos de cancelación', 'avisos', fromObj('avisos', '$json')));
  const respC = w.add(code('Respuesta cancelada', function () {
    const row = Object.assign({}, $('Buscar reserva').first().json, { estado: 'cancelada' });
    return liberar({ status: 200, body: { ok: true, reserva: CORE.bookingSummary(CFG, row) } });
  }));
  const patch = w.add({ ...gcal('Mover evento (Google Calendar)', 'PATCH', "$('Planificar cambio').first().json.patchUrl", "$('Planificar cambio').first().json.patch"), executeOnce: true });
  const resPatch = w.add(code('Resultado cambio', function () {
    const r = CORE.httpResult($input.first());
    if (r.ok) return [{ json: { route: 'ok' } }];
    return liberar(Object.assign(CORE.fail(503, 'calendario_no_disponible'), {}));
  }));
  const if8 = w.add(iff('¿Movido?', "$json.route === 'ok'"));
  const actR = w.add(dtUpdate('Actualizar reserva', 'reservas', [['reserva', 'eq', "={{ $('Buscar reserva').first().json.reserva }}"]],
    { inicio: "={{ $('Planificar cambio').first().json.nuevo.inicio }}", fin: "={{ $('Planificar cambio').first().json.nuevo.fin }}", version: "={{ $('Planificar cambio').first().json.nuevo.version }}" }, { executeOnce: true }));
  const omitR = w.add(dtUpdate('Omitir recordatorios anteriores', 'avisos', [['reserva', 'eq', "={{ $('Buscar reserva').first().json.reserva }}"], ['estado', 'eq', 'pendiente'], ['tipo', 'eq', 'recordatorio']], { estado: '={{ "omitido_reagendada" }}', resultado: '={{ "reagendada" }}' }, { executeOnce: true }));
  const nuevosR = w.add(code('Nuevos recordatorios', function () {
    const row = $('Buscar reserva').first().json;
    const n = $('Planificar cambio').first().json.nuevo;
    const rows = CORE.reminderRows(CFG, row.reserva, Date.parse(n.inicio), NOW);
    return rows.length ? rows.map((r) => ({ json: r })) : [{ json: { nada: true } }];
  }));
  const if9 = w.add(iff('¿Hay recordatorios?', '$json.nada !== true'));
  const insR = w.add(dtInsert('Guardar recordatorios', 'avisos', fromObj('avisos', '$json')));
  const respR = w.add(code('Respuesta reagendada', function () {
    const n = $('Planificar cambio').first().json.nuevo;
    const row = Object.assign({}, $('Buscar reserva').first().json, n);
    return liberar({ status: 200, body: { ok: true, reserva: CORE.bookingSummary(CFG, row) } });
  }));
  const [prep, fin] = releaseNodes(w, 'Verificar enlace');
  const out = w.add(respondNode('Responder'));

  w.chain(hook, val, if1); w.link(if1, buscar, 0); w.link(if1, out, 1);
  w.chain(buscar, verif, if2); w.link(if2, pedir, 0); w.link(if2, out, 1);
  w.chain(pedir, leer, propio, if3); w.link(if3, leerEv, 0); w.link(if3, out, 1);
  w.chain(leerEv, leerOc, plan, if4); w.link(if4, prep, 0); w.link(if4, if5, 1);
  w.link(if5, if6, 0); w.link(if5, patch, 1);
  w.link(if6, del, 0); w.link(if6, marcarC, 1);
  w.chain(del, resDel, if7); w.link(if7, marcarC, 0); w.link(if7, prep, 1);
  w.chain(marcarC, omitir, avC, insC, respC, prep);
  w.chain(patch, resPatch, if8); w.link(if8, actR, 0); w.link(if8, prep, 1);
  w.chain(actR, omitR, nuevosR, if9); w.link(if9, insR, 0); w.link(if9, respR, 1); w.link(insR, respR);
  w.link(respR, prep);
  w.link(fin, out);
  return w;
}

/* =================================================================================================
   04 · Avisos y recordatorios (cada 5 minutos + ejecución manual)
   ================================================================================================= */
function wf04() {
  const w = new WF('Siena PRUEBAS · 04 Avisos y recordatorios', { executionTimeout: 240 });
  const sch = w.add({ name: 'Cada 5 minutos', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } } }, [0, 200]);
  const man = w.add({ name: 'Ejecutar manualmente', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }, [0, 420]);
  w.x = 0;
  const ronda = w.add(code('Preparar ronda', function () {
    return [{ json: { now: NOW, token: `w.${NOW.toString(36)}.${Math.random().toString(36).slice(2, 10)}`, staleBefore: NOW - 10 * 60000 } }];
  }, { core: false, executeOnce: true }));
  const R = "$('Preparar ronda').first().json";
  const stale = w.add(dtUpdate('Liberar reclamos vencidos', 'avisos', [['estado', 'eq', 'procesando'], ['reclamadaEn', 'lt', `={{ ${R}.staleBefore }}`]], { estado: '={{ "pendiente" }}', reclamo: '={{ "" }}' }, { executeOnce: true }));
  const due = w.add(dtGet('Avisos vencidos', 'avisos', [['estado', 'eq', 'pendiente'], ['programadaPara', 'lte', `={{ ${R}.now }}`]], { limit: 20, orderBy: ['programadaPara', 'ASC'], executeOnce: true, alwaysOutputData: false }));
  // Reclamo atómico por fila: solo una ejecución puede pasar un aviso de "pendiente" a "procesando".
  const claim = w.add(dtUpdate('Reclamar aviso', 'avisos', [['id', 'eq', '={{ $json.id }}'], ['estado', 'eq', 'pendiente']], { estado: '={{ "procesando" }}', reclamo: `={{ ${R}.token }}`, reclamadaEn: `={{ ${R}.now }}` }));
  const mine = w.add(dtGet('Avisos reclamados', 'avisos', [['reclamo', 'eq', `={{ ${R}.token }}`]], { returnAll: true, executeOnce: true, alwaysOutputData: false }));
  const loop = w.add({ name: 'Uno por uno', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: { batchSize: 1, options: {} } });
  const resumen = w.add(code('Resumen de la ronda', function () {
    return [{ json: { procesados: $input.all().length } }];
  }, { core: false }), [w.x, 120]);
  const rsv = w.add(dtGet('Reserva del aviso', 'reservas', [['reserva', 'eq', "={{ $json.reserva }}"]], { limit: 1 }));
  const prepL = w.add(code('Preparar lectura', function () {
    const b = $input.first().json;
    if (!b || !b.evento || !b.calendario) return [{ json: { hasEvent: false } }];
    const p = CFG.profesionales.find((x) => x.id === b.profesional);
    return [{ json: { hasEvent: true, url: CORE.eventUrl(CFG, p ? p.calendarId : b.calendario, b.evento) } }];
  }));
  const ifE = w.add(iff('¿Tiene evento?', '$json.hasEvent === true'));
  const getE = w.add(gcal('Leer evento vigente (Google Calendar)', 'GET', '$json.url'));
  const dec = w.add(code('Decidir aviso', function () {
    const aviso = $('Uno por uno').first().json;
    const bIn = $('Reserva del aviso').first().json;
    const booking = bIn && bIn.reserva ? bIn : null;
    const inp = $input.first().json;
    const fromHttp = !('hasEvent' in inp);
    const r = fromHttp ? CORE.httpResult($input.first()) : { ok: false, status: 404, body: null };
    const evento = r.ok ? r.body : null;
    const d = CORE.decideNotification(CFG, aviso, booking, evento, r.ok ? 200 : r.status, NOW);
    return [{ json: Object.assign({ avisoId: aviso.id, aviso }, d) }];
  }));
  const ifM = w.add(iff('¿Enviar email?', "$json.accion === 'enviar_email'"));
  const gmail = w.add({
    name: 'Enviar email (DESACTIVADO por defecto)', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, disabled: true, onError: 'continueRegularOutput',
    parameters: { resource: 'message', operation: 'send', sendTo: '={{ $json.email.para }}', subject: '={{ $json.email.asunto }}', emailType: 'text', message: '={{ $json.email.texto }}', options: { appendAttribution: false } },
    credentials: { gmailOAuth2: { name: CFG.notificaciones.email.credencialGmail } },
    notes: 'Desactivado. Solo se usa si notificaciones.enviosExternosHabilitados y email.habilitado son true y el destinatario está en la lista autorizada. Activarlo exige una credencial Gmail de una cuenta autorizada.',
  });
  const resM = w.add(code('Resultado email', function () {
    const d = $('Decidir aviso').first().json;
    const out = $input.first().json;
    const gmailOut = out && (out.id || out.error) ? out : null; // nodo desactivado = pasa el item sin id
    return [{ json: Object.assign({}, d, { update: Object.assign(CORE.emailResult(CFG, d.aviso, gmailOut, NOW), { vistaPrevia: d.vistaPrevia }) }) }];
  }));
  const fin = w.add(code('Estado final del aviso', function () {
    const d = $input.first().json;
    const a = d.aviso;
    const u = Object.assign({ canal: a.canal, intentos: Number(a.intentos) || 0, programadaPara: Number(a.programadaPara) || 0, vistaPrevia: a.vistaPrevia || '', resultado: a.resultado || '' }, d.update, { reclamo: '' });
    return [{ json: { avisoId: d.avisoId, u, nuevoAviso: d.nuevoAviso || null } }];
  }, { core: false }));
  const save = w.add(dtUpdate('Guardar estado del aviso', 'avisos', [['id', 'eq', '={{ $json.avisoId }}'], ['reclamo', 'eq', `={{ ${R}.token }}`]],
    Object.fromEntries(['estado', 'canal', 'intentos', 'programadaPara', 'vistaPrevia', 'resultado', 'reclamo'].map((c) => [c, `={{ $json.u.${c} }}`])), { executeOnce: true }));
  const ifN = w.add(iff('¿Recordatorio reprogramado?', "$('Estado final del aviso').first().json.nuevoAviso !== null"));
  const insN = w.add(dtInsert('Crear recordatorio actualizado', 'avisos', fromObj('avisos', "$('Estado final del aviso').first().json.nuevoAviso"), { executeOnce: true }));

  w.chain(sch, ronda); w.link(man, ronda);
  w.chain(ronda, stale, due, claim, mine, loop);
  w.link(loop, resumen, 0); w.link(loop, rsv, 1);
  w.chain(rsv, prepL, ifE); w.link(ifE, getE, 0); w.link(ifE, dec, 1); w.link(getE, dec);
  w.link(dec, ifM); w.link(ifM, gmail, 0); w.link(ifM, fin, 1); w.chain(gmail, resM, fin);
  w.chain(fin, save, ifN); w.link(ifN, insN, 0); w.link(ifN, loop, 1); w.link(insN, loop);
  return w;
}

/* ------------------------------------------------------------------ escritura */
mkdirSync(OUT, { recursive: true });
const files = [['00-preparar-tablas', wf00()], ['01-disponibilidad', wf01()], ['02-reservar', wf02()], ['03-gestionar-cita', wf03()], ['04-avisos-y-recordatorios', wf04()]];
for (const [file, w] of files) {
  const j = w.toJSON();
  for (const n of j.nodes) if (n.type === 'n8n-nodes-base.code') new Function('$input', '$', '$getWorkflowStaticData', 'DateTime', n.parameters.jsCode); // falla si hay errores de sintaxis
  writeFileSync(`${OUT}/${file}.json`, JSON.stringify(j, null, 2) + '\n');
  console.log(`✓ ${file}.json  (${j.nodes.length} nodos, inactivo)`);
}
console.log(`Configuración usada: ${cfgPath.replace(ROOT + '/', '')} · modo ${CFG.entorno.modo}`);
