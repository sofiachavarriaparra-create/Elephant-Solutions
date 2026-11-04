#!/usr/bin/env node
// =================================================================================================
//  PRUEBAS DE INTEGRACIÓN LOCAL: n8n real (2.46.x, SQLite) + MOCK de Google Calendar.
//  · Ejecuta los workflows reales generados por scripts/build-workflows.mjs (variante de prueba que
//    apunta al MOCK). Prueba la lógica, los nodos y las Data tables de n8n.
//  · NO prueba Google Calendar real, ni Gmail, ni n8n Cloud (Postgres). Ver README › Verificación.
//
//  Uso: node tests/integracion/run-local-n8n.mjs --n8n=/ruta/node_modules/n8n/bin/n8n [--node=/ruta/node24]
//  Requiere Node >= 24 para n8n 2.46 (se puede indicar otro binario con --node).
// =================================================================================================
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const N8N = args.n8n; const NODE = args.node || process.execPath;
if (!N8N) { console.error('Falta --n8n=/ruta/a/node_modules/n8n/bin/n8n'); process.exit(2); }
const WORK = mkdtempSync(join(args.tmp || tmpdir(), 'siena-n8n-'));
const PORT = 5678, MOCK = 8787, BASE = `http://127.0.0.1:${PORT}/webhook`;
const ENV = {
  ...process.env, N8N_USER_FOLDER: WORK, N8N_PORT: String(PORT), N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_ENCRYPTION_KEY: 'solo-pruebas-locales-' + randomBytes(8).toString('hex'),
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', GENERIC_TIMEZONE: 'America/Santiago', TZ: 'UTC', N8N_LOG_LEVEL: 'warn',
};
const Z = 'America/Santiago';
const log = (...a) => console.log(...a);
const results = [];
let allResponses = [];

/* ------------------------------------------------------------------ preparación */
const cfg = JSON.parse(readFileSync(`${ROOT}/config/siena.config.example.json`, 'utf8'));
cfg._aviso += ' · VARIANTE LOCAL CONTRA MOCK';
cfg.google.apiBase = `http://127.0.0.1:${MOCK}/calendar/v3`;
cfg.google.timeoutMs = 4000;
cfg.profesionales[0].calendarId = 'cal-prueba-1@mock.local';
cfg.profesionales[1].calendarId = 'cal-prueba-2@mock.local';
cfg.limites.disponibilidadPorMinutoIp = 40; cfg.limites.reservasPor10MinIp = 500; cfg.limites.gestionPor10MinIp = 500;
// El nodo Gmail sigue DESACTIVADO: esto solo hace que el flujo intente la ruta de email y registre su falla.
cfg.notificaciones.enviosExternosHabilitados = true; cfg.notificaciones.email.habilitado = true;
cfg.notificaciones.email.destinatariosAutorizados = ['pruebas-cliente@example.com'];
cfg.candado.duracionMs = 30000; cfg.candado.margenMinimoMs = 10000;
writeFileSync(`${WORK}/config.json`, JSON.stringify(cfg));

const n8n = (cmdArgs, opts = {}) => execFileSync(NODE, [N8N, ...cmdArgs], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, ...opts });
log('· Carpeta temporal:', WORK);
execFileSync(process.execPath, [`${ROOT}/scripts/build-workflows.mjs`, `--config=${WORK}/config.json`, `--salida=${WORK}/wf`, '--credencial-id=mockGcalCred0001', '--con-ids'], { stdio: 'inherit' });
// Solo en la variante local: un webhook para disparar la ronda de avisos a demanda (no existe en la entrega).
const wf4path = `${WORK}/wf/04-avisos-y-recordatorios.json`;
const wf4 = JSON.parse(readFileSync(wf4path, 'utf8'));
wf4.nodes.push({ id: randomUUID(), name: 'Ronda (solo prueba local)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, webhookId: randomUUID(), position: [0, 640],
  parameters: { httpMethod: 'POST', path: 'siena-pruebas/ronda-local', responseMode: 'lastNode', responseData: 'allEntries', options: {} } });
wf4.connections['Ronda (solo prueba local)'] = { main: [[{ node: 'Preparar ronda', type: 'main', index: 0 }]] };
writeFileSync(wf4path, JSON.stringify(wf4));
// Igual para el workflow 00: el comando "execute" del CLI no carga el módulo de Data tables.
const wf0path = `${WORK}/wf/00-preparar-tablas.json`;
const wf0 = JSON.parse(readFileSync(wf0path, 'utf8'));
wf0.nodes.push({ id: randomUUID(), name: 'Preparar (solo prueba local)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, webhookId: randomUUID(), position: [0, 640],
  parameters: { httpMethod: 'POST', path: 'siena-pruebas/preparar-local', responseMode: 'lastNode', responseData: 'allEntries', options: {} } });
wf0.connections['Preparar (solo prueba local)'] = { main: [[{ node: 'Crear tabla siena_pruebas_reservas', type: 'main', index: 0 }]] };
writeFileSync(wf0path, JSON.stringify(wf0));

if (args['sin-candado']) {
  // CONTROL NEGATIVO (solo diagnóstico): se anula la verificación del candado para comprobar que la prueba detecta dobles reservas.
  const p2 = `${WORK}/wf/02-reservar.json`, w2 = JSON.parse(readFileSync(p2, 'utf8'));
  const n = w2.nodes.find((x) => x.name === '¿Candado propio?');
  n.parameters.jsCode = n.parameters.jsCode.replace("if (!rows.every((r) => r.titular === e.lockToken && Number(r.bloqueadoHasta) === e.lockUntil)) return resp(503, 'agenda_ocupada');", '/* candado anulado */');
  const pedir = w2.nodes.find((x) => x.name === 'Pedir candado');
  pedir.parameters.filters.conditions = pedir.parameters.filters.conditions.filter((c) => c.keyName === 'recurso');
  writeFileSync(p2, JSON.stringify(w2));
  log('· ⚠ CONTROL NEGATIVO: candado anulado en esta corrida');
}
writeFileSync(`${WORK}/cred.json`, JSON.stringify([{ id: 'mockGcalCred0001', name: cfg.google.credencial, type: 'googleCalendarOAuth2Api',
  data: { clientId: 'mock', clientSecret: 'mock', oauthTokenData: { access_token: 'token-del-mock', token_type: 'Bearer', expires_in: 315360000, expiry_date: Date.now() + 315360000000 } } }]));
log('· Importando credencial falsa (solo mock) y workflows en la n8n local…');
n8n(['import:credentials', `--input=${WORK}/cred.json`]);
n8n(['import:workflow', '--separate', `--input=${WORK}/wf`]);
const ids = readdirSync(`${WORK}/wf`).sort().map((f) => JSON.parse(readFileSync(`${WORK}/wf/${f}`, 'utf8')).id);

const mock = spawn(process.execPath, [`${ROOT}/tests/mock/google-calendar-mock.mjs`], { env: { ...process.env, MOCK_PORT: String(MOCK) }, stdio: ['ignore', 'pipe', 'inherit'] });
const children = [mock];
const cleanup = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } };
process.on('exit', cleanup); process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
await new Promise((r) => mock.stdout.once('data', r));
const mockCall = (path, body) => fetch(`http://127.0.0.1:${MOCK}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const resetMock = (eventos = []) => mockCall('/__mock/reset', { calendarios: ['cal-prueba-1@mock.local', 'cal-prueba-2@mock.local'], eventos });
await resetMock();

for (const id of ids) n8n(['publish:workflow', `--id=${id}`]);
log('· Workflows publicados SOLO en esta n8n local temporal.');

const server = spawn(NODE, [N8N, 'start'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(server);
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));
const t0 = Date.now();
while (true) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz/readiness`); if (r.ok) break; } catch {}
  if (Date.now() - t0 > 120000) { console.error(serverLog.slice(-3000)); throw new Error('n8n no arrancó'); }
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 3000));
log('· n8n local lista en', BASE);
const prep = await fetch(`${BASE}/siena-pruebas/preparar-local`, { method: 'POST' });
log('· Workflow 00 (preparar tablas):', prep.status, (await prep.text()).slice(0, 200));

const db = new DatabaseSync(join(WORK, '.n8n', 'database.sqlite'));
db.exec('PRAGMA busy_timeout = 5000');
const tableId = (name) => db.prepare('SELECT id FROM data_table WHERE name = ?').get(name).id;
const rows = (name, where = '', p = []) => db.prepare(`SELECT * FROM data_table_user_${tableId(name)} ${where}`).all(...p);
const exec = (sql, p = []) => db.prepare(sql).run(...p);

if (args['solo-servidor']) {
  log('LISTO · n8n local y MOCK en marcha para pruebas de navegador (Ctrl+C para terminar)');
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  await new Promise(() => {});
}

/* ------------------------------------------------------------------ cliente HTTP de prueba (imita al navegador) */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 siena-pruebas';
let ipSeq = 1;
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
async function call(ruta, body, { ip = freshIp(), origin, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
  const t = Date.now();
  try {
    const r = await fetch(`${BASE}/siena-pruebas/${ruta}`, { method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-forwarded-for': `203.0.113.250, ${ip}`, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    allResponses.push({ ruta, status: r.status, text, headers: Object.fromEntries(r.headers) });
    return { status: r.status, body: json, text, ms: Date.now() - t, headers: r.headers };
  } catch (e) { return { status: 0, error: String(e), ms: Date.now() - t }; } finally { clearTimeout(tm); }
}
// Igual que la web: reintenta con la MISMA clave ante errores reintentables o respuestas perdidas.
async function book(body, { intentos = 6 } = {}) {
  let r;
  for (let i = 0; i < intentos; i++) {
    r = await call('reservar', body);
    if (r.status && !(r.body && r.body.reintentable) && r.status < 500) return { ...r, intentos: i + 1 };
    await new Promise((s) => setTimeout(s, 400 + i * 400));
  }
  return { ...r, intentos };
}
const hex = () => randomBytes(32).toString('hex');
function nextWeekday(addDays, weekday = [1, 2, 3, 4, 5]) {
  let d = DateTime.now().setZone(Z).startOf('day').plus({ days: addDays });
  while (!weekday.includes(d.weekday)) d = d.plus({ days: 1 });
  return d;
}
const at = (day, hhmm) => DateTime.fromISO(`${day.toFormat('yyyy-MM-dd')}T${hhmm}`, { zone: Z }).toUTC().toISO();
const reserva = (over = {}) => ({
  servicioId: 'srv-prueba-a', profesionalId: 'prof-prueba-1', inicio: at(nextWeekday(3), '10:00'), nombre: 'Prueba Integración', telefono: '+56 9 1111 2222',
  email: 'otra-persona@example.org', consentimiento: true, claveIdempotencia: randomUUID(), claveGestion: hex(), ...over,
});
const events = async (cal = 'cal-prueba-1@mock.local') => (await mockCall('/__mock/estado')).eventos[cal] || [];
const ronda = async () => { const r = await fetch(`${BASE}/siena-pruebas/ronda-local`, { method: 'POST' }); return r.status; };

async function t(nombre, fn) {
  if (args.solo && !nombre.includes(args.solo)) return;
  const t0 = Date.now();
  try { const detalle = await fn(); results.push({ nombre, ok: true, ms: Date.now() - t0, detalle }); log(`  ✔ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
  catch (e) { results.push({ nombre, ok: false, ms: Date.now() - t0, detalle: e.message }); log(`  ✘ ${nombre} — ${e.message}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ------------------------------------------------------------------ escenarios */
log('\n== Escenarios ==');
// Días hábiles distintos (lunes a viernes) a partir de 3 días desde hoy, dentro del horizonte de 30 días.
const DIAS = []; for (let d = nextWeekday(3); DIAS.length < 7; d = d.plus({ days: 1 })) if (d.weekday <= 5) DIAS.push(d);
const [D1, D2, D3, D4, D5, D6, D7] = DIAS;
log('· Días de prueba:', DIAS.map((d) => d.toFormat('ccc dd-LL')).join(', '));

await t('Catálogo público sin datos internos', async () => {
  const r = await call('disponibilidad', { accion: 'catalogo' });
  expect(r.status === 200 && r.body.ok, `status ${r.status}`);
  expect(!/mock\.local|calendar|credencial|@/i.test(r.text), 'el catálogo filtra datos internos');
  expect(r.body.aviso === 'Entorno de pruebas: no genera reservas reales en Siena', 'falta aviso');
  return `${r.body.servicios.length} servicios de prueba, ${r.ms} ms`;
});

await t('Disponibilidad: sin datos de eventos existentes y con hora ocupada excluida', async () => {
  await resetMock([{ calendarId: 'cal-prueba-1@mock.local', id: 'evtajeno001', summary: 'Juana Pérez +56 9 8888 7777 juana@example.org', description: 'privado',
    start: { dateTime: at(D1, '11:00') }, end: { dateTime: at(D1, '12:00') } }]);
  const r = await call('disponibilidad', { accion: 'horarios', servicioId: 'srv-prueba-a', profesionalId: 'prof-prueba-1', desde: D1.toFormat('yyyy-MM-dd'), dias: 1 });
  expect(r.status === 200, `status ${r.status} ${r.text}`);
  const horas = r.body.dias[0].horarios.map((h) => h.hora);
  expect(!horas.includes('11:00') && !horas.includes('11:30') && !horas.includes('12:00') && horas.includes('12:15'), 'ocupación mal aplicada: ' + horas.join(','));
  expect(!/Juana|8888|juana@|privado|evtajeno/.test(r.text), 'se filtraron datos del evento existente');
  expect(JSON.stringify(Object.keys(r.body.dias[0].horarios[0])) === '["inicio","hora"]', 'la respuesta trae campos de más');
  return `${horas.length} horarios libres el ${D1.toFormat('yyyy-MM-dd')}`;
});

let R1;
await t('Reserva válida: un único evento, reserva registrada y avisos creados', async () => {
  R1 = reserva({ inicio: at(D1, '10:00') });
  const r = await book(R1);
  expect(r.status === 201 && r.body.ok, `status ${r.status} ${r.text}`);
  const evs = (await events()).filter((e) => e.extendedProperties?.private?.sienaReserva === r.body.reserva.reserva);
  expect(evs.length === 1, `eventos: ${evs.length}`);
  expect(!evs[0].attendees, 'el evento no debe tener invitados');
  const row = rows('siena_pruebas_reservas', 'WHERE reserva = ?', [r.body.reserva.reserva])[0];
  expect(row && row.estado === 'confirmada', 'reserva no confirmada');
  const av = rows('siena_pruebas_avisos', 'WHERE reserva = ?', [row.reserva]);
  expect(av.length === 4, `avisos: ${av.length}`);
  expect(!/Prueba Integración|1111|otra-persona/.test(r.text), 'la respuesta no debe repetir datos personales');
  R1.reservaId = r.body.reserva.reserva;
  return `reserva ${row.reserva}, ${r.ms} ms, candado liberado=${rows('siena_pruebas_candados', "WHERE recurso='prof-prueba-1'")[0].bloqueadoHasta === 0}`;
});

await t('Horario ocupado (evento existente en la agenda) → 409', async () => {
  const r = await book(reserva({ inicio: at(D1, '11:00') }));
  expect(r.status === 409 && r.body.error === 'hora_tomada', `${r.status} ${r.text}`);
});
await t('Horario ocupado por otra reserva (incluye tiempo entre citas) → 409', async () => {
  const r = await book(reserva({ inicio: at(D1, '10:30') }));
  expect(r.status === 409 && r.body.error === 'hora_tomada', `${r.status} ${r.text}`);
});
await t('Horario pasado → 409 hora_pasada', async () => {
  const r = await book(reserva({ inicio: at(DateTime.now().setZone(Z).minus({ days: 1 }), '10:00') }));
  expect(r.status === 409 && r.body.error === 'hora_pasada', `${r.status} ${r.text}`);
});
await t('Fuera de jornada (09:00 y domingo) → 409 fuera_de_horario', async () => {
  const a = await book(reserva({ inicio: at(D2, '09:00') }));
  const b = await book(reserva({ inicio: at(nextWeekday(3, [7]), '11:00') }));
  expect(a.body.error === 'fuera_de_horario' && b.body.error === 'fuera_de_horario', `${a.text} | ${b.text}`);
});
await t('Duración que atraviesa el descanso (90 min a las 12:00) → 409 cruza_descanso', async () => {
  const r = await book(reserva({ servicioId: 'srv-prueba-c', inicio: at(D2, '12:00') }));
  expect(r.status === 409 && r.body.error === 'cruza_descanso', `${r.status} ${r.text}`);
});
await t('Entrada inválida y trampa anti-bots → 400 sin detalles internos', async () => {
  const a = await call('reservar', reserva({ telefono: '123', nombre: '<b>x</b>' }));
  const b = await call('reservar', reserva({ sitioWeb: 'http://spam.example' }));
  const c = await call('reservar', { basura: 'x'.repeat(6000) });
  expect(a.status === 400 && b.status === 400 && c.status === 400, `${a.status} ${b.status} ${c.status}`);
  expect(!/stack|at |Error:|n8n/i.test(a.text + b.text + c.text), 'respuesta con detalles internos');
  return `campos rechazados: ${a.body.extra?.campos?.join(',') || '(no expuestos)'}`;
});

await t('Dos solicitudes simultáneas al mismo intervalo → exactamente una reserva', async () => {
  const inicio = at(D2, '15:00');
  const [a, b] = await Promise.all([book(reserva({ inicio, nombre: 'Concurrente Uno' })), book(reserva({ inicio, nombre: 'Concurrente Dos' }))]);
  const st = [a.status, b.status].sort();
  const n = (await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(inicio) && e.status !== 'cancelled').length;
  expect(st[0] === 201 && st[1] === 409 && n === 1, `estados ${st} eventos ${n} | ${a.text} | ${b.text}`);
  return `estados ${st.join('/')}, intentos ${a.intentos}+${b.intentos}, eventos=1`;
});
await t('Ocho solicitudes simultáneas (distinta clave, mismo intervalo) → exactamente una', async () => {
  const inicio = at(D2, '16:00');
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => book(reserva({ inicio, nombre: `Carga ${'ABCDEFGH'[i]}` }), { intentos: 10 })));
  const ok = rs.filter((r) => r.status === 201).length, conf = rs.filter((r) => r.status === 409).length;
  const n = (await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(inicio) && e.status !== 'cancelled').length;
  expect(ok === 1 && conf === 7 && n === 1, `201=${ok} 409=${conf} eventos=${n} otros=${rs.filter((r) => ![201, 409].includes(r.status)).map((r) => r.status + ':' + r.text).join(' ')}`);
  return `201=1, 409=7, eventos=1, intentos totales ${rs.reduce((s, r) => s + r.intentos, 0)}`;
});
await t('Doble clic y reintento con la misma clave → una sola reserva y misma respuesta', async () => {
  const body = reserva({ inicio: at(D3, '10:00') });
  const [a, b] = await Promise.all([book(body), book(body)]);
  const c = await book(body);
  const ids = new Set([a, b, c].map((r) => r.body && r.body.reserva && r.body.reserva.reserva));
  const n = (await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(body.inicio)).length;
  expect([a, b, c].every((r) => r.status === 201 || (r.status === 200 && r.body.idempotente)) && ids.size === 1 && n === 1, `${a.status}/${b.status}/${c.status} ids=${ids.size} eventos=${n}`);
  const d = await call('reservar', { ...body, nombre: 'Otro Nombre' });
  expect(d.status === 409 && d.body.error === 'clave_reutilizada', `misma clave con otros datos: ${d.status} ${d.text}`);
  return `estados ${a.status}/${b.status}/${c.status}; misma clave con otros datos → 409`;
});
await t('Falla de Google Calendar al crear → 503 reintentable, sin evento; el reintento crea uno solo', async () => {
  const body = reserva({ inicio: at(D3, '11:00') });
  await mockCall('/__mock/fallas', [{ metodo: 'POST', contiene: '/events', modo: 'status', status: 503, veces: 1 }]);
  const a = await call('reservar', body);
  expect(a.status === 503 && a.body.reintentable && a.body.error === 'calendario_no_disponible', `${a.status} ${a.text}`);
  const row = rows('siena_pruebas_reservas', 'WHERE estado = ?', ['error_calendario']).find((x) => x.inicio === new Date(body.inicio).toISOString());
  expect(row, 'la reserva debería quedar en error_calendario');
  expect((await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(body.inicio)).length === 0, 'no debía crearse evento');
  const b = await book(body);
  const n = (await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(body.inicio)).length;
  expect(b.status === 201 && n === 1, `${b.status} eventos=${n}`);
  return 'la interfaz recibe error, no confirmación; luego 201 con un evento';
});
await t('Respuesta perdida de Google (aplica y corta la conexión) → el reintento adopta el mismo evento', async () => {
  const body = reserva({ inicio: at(D3, '12:00') });
  await mockCall('/__mock/fallas', [{ metodo: 'POST', contiene: '/events', modo: 'aplicar-y-cortar', veces: 1 }]);
  const a = await call('reservar', body);
  expect(a.status === 503, `primer intento debía fallar: ${a.status} ${a.text}`);
  expect((await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(body.inicio)).length === 1, 'el mock debía tener el evento');
  const b = await book(body);
  const n = (await events()).filter((e) => Date.parse(e.start.dateTime) === Date.parse(body.inicio)).length;
  expect(b.status === 201 && n === 1, `${b.status} eventos=${n} ${b.text}`);
  return 'sin evento duplicado';
});
await t('Tiempo de espera de Google (demora > timeout) → 503 en tiempo acotado', async () => {
  await mockCall('/__mock/fallas', [{ metodo: 'GET', contiene: '/events', modo: 'demora', ms: 9000, veces: 1 }]);
  const a = await call('reservar', reserva({ inicio: at(D3, '14:00') }));
  expect(a.status === 503 && a.body.reintentable && a.ms < 8000, `${a.status} en ${a.ms} ms`);
  return `${a.ms} ms`;
});
await t('Candado ocupado por otra ejecución → 503 reintentable; vencido → se recupera', async () => {
  exec(`UPDATE data_table_user_${tableId('siena_pruebas_candados')} SET titular='otra-ejecucion', bloqueadoHasta=? WHERE recurso='prof-prueba-1'`, [Date.now() + 60000]);
  const body = reserva({ inicio: at(D3, '15:00') });
  const a = await call('reservar', body);
  expect(a.status === 503 && a.body.error === 'agenda_ocupada', `${a.status} ${a.text}`);
  exec(`UPDATE data_table_user_${tableId('siena_pruebas_candados')} SET bloqueadoHasta=? WHERE recurso='prof-prueba-1'`, [Date.now() - 1]);
  const b = await book(body);
  expect(b.status === 201, `${b.status} ${b.text}`);
});
await t('Profesional "cualquiera": asigna una libre', async () => {
  const r = await book(reserva({ profesionalId: 'cualquiera', servicioId: 'srv-prueba-b', inicio: at(D4, '14:00') }));
  expect(r.status === 201, `${r.status} ${r.text}`);
  return `asignada: ${r.body.reserva.profesional}`;
});

// --- gestión
let G;
await t('Consultar y cancelar con enlace seguro; token inválido y reserva ajena → 404', async () => {
  G = reserva({ inicio: at(D5, '10:00') });
  const r = await book(G);
  const id = r.body.reserva.reserva;
  const c = await call('gestionar', { accion: 'consultar', reserva: id, clave: G.claveGestion });
  expect(c.status === 200 && c.body.reserva.estado === 'confirmada', `${c.status} ${c.text}`);
  const bad = await call('gestionar', { accion: 'cancelar', reserva: id, clave: hex() });
  const ajena = await call('gestionar', { accion: 'cancelar', reserva: R1.reservaId, clave: G.claveGestion });
  const inexist = await call('gestionar', { accion: 'cancelar', reserva: 'r' + '0'.repeat(23), clave: G.claveGestion });
  expect(bad.status === 404 && ajena.status === 404 && inexist.status === 404 && bad.text === ajena.text && ajena.text === inexist.text, 'las respuestas de enlace inválido deben ser idénticas');
  const x = await call('gestionar', { accion: 'cancelar', reserva: id, clave: G.claveGestion });
  expect(x.status === 200 && x.body.reserva.estado === 'cancelada', `${x.status} ${x.text}`);
  const ev = (await events()).find((e) => e.extendedProperties?.private?.sienaReserva === id);
  expect(ev.status === 'cancelled', 'evento no cancelado');
  const av = rows('siena_pruebas_avisos', 'WHERE reserva = ?', [id]);
  expect(av.filter((a) => a.tipo === 'recordatorio').every((a) => a.estado === 'omitido_cancelada'), 'recordatorios no omitidos');
  const again = await call('gestionar', { accion: 'cancelar', reserva: id, clave: G.claveGestion });
  expect(again.status === 200 && again.body.idempotente, 'cancelar dos veces debe ser idempotente');
  const ajenaSigue = rows('siena_pruebas_reservas', 'WHERE reserva = ?', [R1.reservaId])[0].estado;
  expect(ajenaSigue === 'confirmada', 'la reserva ajena no debe cambiar');
  return 'token inválido, reserva ajena e inexistente responden igual (404)';
});
await t('Reagendar: falla de Google conserva la cita original; hora ocupada → 409; luego éxito', async () => {
  const B = reserva({ inicio: at(D6, '10:00') });
  const r = await book(B);
  const id = r.body.reserva.reserva;
  const nuevo = at(D6, '16:00');
  await mockCall('/__mock/fallas', [{ metodo: 'PATCH', modo: 'status', status: 500, veces: 1 }]);
  const f = await call('gestionar', { accion: 'reagendar', reserva: id, clave: B.claveGestion, nuevoInicio: nuevo });
  expect(f.status === 503 && f.body.reintentable, `${f.status} ${f.text}`);
  let ev = (await events()).find((e) => e.extendedProperties?.private?.sienaReserva === id);
  let row = rows('siena_pruebas_reservas', 'WHERE reserva = ?', [id])[0];
  expect(Date.parse(ev.start.dateTime) === Date.parse(B.inicio) && row.inicio === new Date(B.inicio).toISOString() && ev.status !== 'cancelled', 'la cita original cambió');
  const ocup = await call('gestionar', { accion: 'reagendar', reserva: id, clave: B.claveGestion, nuevoInicio: at(D1, '11:00') });
  expect(ocup.status === 409, `hora ocupada: ${ocup.status} ${ocup.text}`);
  const ok = await call('gestionar', { accion: 'reagendar', reserva: id, clave: B.claveGestion, nuevoInicio: nuevo });
  expect(ok.status === 200, `${ok.status} ${ok.text}`);
  ev = (await events()).find((e) => e.extendedProperties?.private?.sienaReserva === id);
  row = rows('siena_pruebas_reservas', 'WHERE reserva = ?', [id])[0];
  const av = rows('siena_pruebas_avisos', "WHERE reserva = ? AND tipo='recordatorio'", [id]);
  expect(Date.parse(ev.start.dateTime) === Date.parse(nuevo) && row.inicio === new Date(nuevo).toISOString() && row.version === 2, 'no se movió');
  expect(av.some((a) => a.estado === 'omitido_reagendada') && av.some((a) => a.estado === 'pendiente' && a.inicioRef === new Date(nuevo).toISOString()), 'recordatorios no actualizados');
  return 'original intacta tras la falla; luego movida y recordatorios rehechos';
});

// --- avisos
await t('Ronda de avisos: confirmaciones en vista previa (sin envío) con datos enmascarados', async () => {
  const st = await ronda();
  expect(st === 200, `ronda ${st}`);
  const av = rows('siena_pruebas_avisos', "WHERE tipo='confirmacion' AND reserva = ?", [R1.reservaId]);
  expect(av.length === 2 && av.every((a) => a.estado === 'vista_previa' && a.canal === 'vista_previa'), JSON.stringify(av.map((a) => a.estado)));
  expect(av.every((a) => /^\[PRUEBA/.test(a.vistaPrevia) && !a.vistaPrevia.includes('Prueba Integración')), 'vista previa sin marcar o con nombre completo');
  expect(rows('siena_pruebas_avisos', "WHERE estado='enviado'").length === 0, 'no debe haber envíos');
  return av[0].vistaPrevia.slice(0, 90) + '…';
});
await t('Notificación fallida (ruta email con nodo Gmail desactivado) → reserva intacta, se reintenta sin duplicar', async () => {
  const E = reserva({ inicio: at(D7, '10:00'), email: 'pruebas-cliente@example.com' });
  const r = await book(E);
  const id = r.body.reserva.reserva;
  await ronda();
  let a = rows('siena_pruebas_avisos', "WHERE reserva = ? AND tipo='confirmacion' AND destinatario='cliente'", [id])[0];
  expect(a.estado === 'pendiente' && a.intentos === 1 && a.resultado === 'gmail_sin_confirmacion', JSON.stringify(a));
  for (let i = 0; i < 2; i++) { exec(`UPDATE data_table_user_${tableId('siena_pruebas_avisos')} SET programadaPara=? WHERE id=?`, [Date.now() - 1000, a.id]); await ronda(); }
  a = rows('siena_pruebas_avisos', 'WHERE id = ?', [a.id])[0];
  const evs = (await events()).filter((e) => e.extendedProperties?.private?.sienaReserva === id);
  const row = rows('siena_pruebas_reservas', 'WHERE reserva = ?', [id])[0];
  expect(a.estado === 'fallido' && a.intentos === 3 && evs.length === 1 && row.estado === 'confirmada', `${a.estado}/${a.intentos} eventos=${evs.length} reserva=${row.estado}`);
  return 'aviso: pendiente(1) → pendiente(2) → fallido(3); reserva y evento intactos';
});
await t('Recordatorio omitido si la cita se canceló o cambió directamente en la agenda', async () => {
  const C = reserva({ inicio: at(D7, '15:00') });
  const D = reserva({ inicio: at(D7, '16:00') });
  const rc = await book(C), rd = await book(D);
  const idC = rc.body.reserva.reserva, idD = rd.body.reserva.reserva;
  const evs = await events();
  const evC = evs.find((e) => e.extendedProperties?.private?.sienaReserva === idC), evD = evs.find((e) => e.extendedProperties?.private?.sienaReserva === idD);
  await fetch(`http://127.0.0.1:${MOCK}/calendar/v3/calendars/cal-prueba-1%40mock.local/events/${evC.id}`, { method: 'DELETE', headers: { authorization: 'Bearer x' } });
  const moved = at(D7, '17:00');
  await fetch(`http://127.0.0.1:${MOCK}/calendar/v3/calendars/cal-prueba-1%40mock.local/events/${evD.id}`, { method: 'PATCH', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ start: { dateTime: moved }, end: { dateTime: at(D7, '17:30') } }) });
  exec(`UPDATE data_table_user_${tableId('siena_pruebas_avisos')} SET programadaPara=? WHERE tipo='recordatorio' AND reserva IN (?, ?)`, [Date.now() - 1000, idC, idD]);
  await ronda();
  const ac = rows('siena_pruebas_avisos', "WHERE reserva=? AND tipo='recordatorio'", [idC]);
  const ad = rows('siena_pruebas_avisos', "WHERE reserva=? AND tipo='recordatorio'", [idD]);
  expect(ac.every((a) => a.estado === 'omitido_cancelada'), 'cancelada: ' + ac.map((a) => a.estado));
  expect(ad.filter((a) => a.estado === 'omitido_horario_cambiado').length === 2 && ad.filter((a) => a.estado === 'pendiente' && a.inicioRef === new Date(moved).toISOString()).length === 2, 'cambiada: ' + ad.map((a) => a.estado + '@' + a.inicioRef));
  return 'cancelada → omitido_cancelada; movida → omitido_horario_cambiado + nuevo recordatorio';
});

// --- protección
await t('Límite de uso por IP en disponibilidad → 429', async () => {
  const ip = '192.0.2.77'; let st = [];
  for (let i = 0; i < 45; i++) st.push((await call('disponibilidad', { accion: 'catalogo' }, { ip })).status);
  expect(st.includes(429) && st.filter((s) => s === 200).length <= 40, st.join(','));
  const other = await call('disponibilidad', { accion: 'catalogo' }, { ip: '192.0.2.78' });
  expect(other.status === 200, 'otra IP debe seguir funcionando');
  return `200×${st.filter((s) => s === 200).length}, luego 429`;
});
await t('CORS: origen permitido recibe cabecera; origen ajeno no', async () => {
  const ok = await fetch(`${BASE}/siena-pruebas/disponibilidad`, { method: 'OPTIONS', headers: { origin: 'http://localhost:8000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  const bad = await fetch(`${BASE}/siena-pruebas/disponibilidad`, { method: 'OPTIONS', headers: { origin: 'https://sitio-ajeno.example', 'access-control-request-method': 'POST' } });
  const a = ok.headers.get('access-control-allow-origin'), b = bad.headers.get('access-control-allow-origin');
  expect(a === 'http://localhost:8000' && b !== 'https://sitio-ajeno.example' && b !== '*', `permitido=${a} ajeno=${b}`);
  return `permitido=${a}, ajeno=${b}`;
});
await t('Respuestas públicas sin secretos ni datos personales', async () => {
  const txt = allResponses.map((r) => r.text).join('\n');
  const prohibido = [/Bearer|token-del-mock|access_token|clientSecret/i, /mock\.local|calendarId/i, /\+?56\s?9\s?\d{4}\s?\d{4}|\+569\d{8}/, /otra-persona@|pruebas-cliente@|Prueba Integración|Concurrente|Carga [A-H]/, /tokenHash|telefonoHash|huella/, /Juana|evtajeno/];
  const hits = prohibido.filter((re) => re.test(txt)).map(String);
  expect(hits.length === 0, 'encontrado: ' + hits.join(' '));
  return `${allResponses.length} respuestas revisadas`;
});
await t('Candados liberados al terminar', async () => {
  const c = rows('siena_pruebas_candados');
  expect(c.length === 2 && c.every((x) => Number(x.bloqueadoHasta) === 0 || Number(x.bloqueadoHasta) < Date.now()), JSON.stringify(c));
});

/* ------------------------------------------------------------------ cierre */
const pass = results.filter((r) => r.ok).length;
log(`\n== Resultado: ${pass}/${results.length} escenarios OK ==`);
writeFileSync(`${ROOT}/tests/integracion/ultimo-resultado${args['sin-candado'] ? '-control-negativo' : ''}.json`, JSON.stringify({
  fecha: new Date().toISOString(), entorno: 'n8n local (SQLite) + MOCK de Google Calendar; NO es Google real ni n8n Cloud',
  n8n: n8n(['--version']).trim(), node: execFileSync(NODE, ['-v'], { encoding: 'utf8' }).trim(), resultados: results,
}, null, 2) + '\n');
server.kill('SIGTERM'); mock.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));
process.exit(pass === results.length ? 0 : 1);
