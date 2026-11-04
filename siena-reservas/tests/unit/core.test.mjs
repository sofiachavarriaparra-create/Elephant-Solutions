// Pruebas UNITARIAS del núcleo (sin red, sin n8n, sin Google). Reloj fijo inyectado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createSienaCore } = require('../../core/siena-core.js');
const core = createSienaCore(DateTime);
const CFG = JSON.parse(readFileSync(new URL('../../config/siena.config.example.json', import.meta.url)));
const Z = 'America/Santiago';
const ms = (isoLocal) => DateTime.fromISO(isoLocal, { zone: Z }).toMillis();
const NOW = ms('2026-11-09T08:00'); // lunes 9 de noviembre de 2026, 08:00 en Santiago

test('sha256 coincide con vectores conocidos', () => {
  assert.equal(core.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(core.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(core.sha256Hex('a'.repeat(1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  for (const t of ['ñandú', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), '😀 reserva']) {
    assert.equal(core.sha256Hex(t), createHash('sha256').update(t, 'utf8').digest('hex'));
  }
});

test('la configuración de ejemplo es válida y está marcada como datos de prueba', () => {
  assert.deepEqual(core.validateConfig(CFG), []);
  assert.match(CFG._aviso, /DATOS DE PRUEBA/);
  assert.equal(CFG.notificaciones.enviosExternosHabilitados, false);
  assert.equal(CFG.notificaciones.whatsapp.habilitado, false);
  const bad = structuredClone(CFG); bad.notificaciones.whatsapp.habilitado = true;
  assert.ok(core.validateConfig(bad).some((e) => /whatsapp/.test(e)));
});

test('jornada con descanso, sábado corto, domingo cerrado y excepciones', () => {
  const p1 = CFG.profesionales[0];
  const lun = core.workingDay(CFG, p1, '2026-11-09');
  assert.deepEqual(lun.tramos, [[ms('2026-11-09T10:00'), ms('2026-11-09T13:00')], [ms('2026-11-09T14:00'), ms('2026-11-09T19:00')]]);
  assert.equal(core.workingDay(CFG, p1, '2026-11-14').tramos.length, 1); // sábado
  assert.equal(core.workingDay(CFG, p1, '2026-11-15').tramos.length, 0); // domingo
  assert.equal(core.workingDay(CFG, p1, '2026-12-25').tramos.length, 0); // feriado de prueba
  assert.deepEqual(core.workingDay(CFG, p1, '2026-12-31').tramos, [[ms('2026-12-31T10:00'), ms('2026-12-31T13:00')]]);
  // horario propio de la profesional 2: lunes no trabaja
  assert.equal(core.workingDay(CFG, CFG.profesionales[1], '2026-11-09').tramos.length, 0);
});

test('horarios: anticipación mínima, descanso y fin de jornada', () => {
  const slots = core.slotsForDay(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', fecha: '2026-11-09', busy: [], nowMs: NOW });
  const horas = slots.map((s) => s.hora);
  assert.equal(horas[0], '10:00'); // 08:00 + 120 min de anticipación
  assert.ok(horas.includes('12:30') && !horas.includes('12:45') && !horas.includes('13:00'));
  assert.ok(horas.includes('14:00') && horas.includes('18:30') && !horas.includes('18:45'));
  const tarde = core.slotsForDay(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', fecha: '2026-11-09', busy: [], nowMs: ms('2026-11-09T11:10') });
  // 11:10 + 2 h = 13:10 → el primer inicio válido es 14:00 (13:00–14:00 es descanso)
  assert.equal(tarde[0].hora, '14:00');
});

test('un servicio de 90 min no puede atravesar el descanso', () => {
  const r = core.checkSlot(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-c', startMs: ms('2026-11-10T11:45'), busy: [], nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'cruza_descanso' });
  assert.equal(core.checkSlot(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-c', startMs: ms('2026-11-10T11:30'), busy: [], nowMs: NOW }).ok, true);
});

test('horario ocupado, pasado, fuera de jornada, fuera de grilla y fuera de horizonte', () => {
  const busy = [[ms('2026-11-10T10:00'), ms('2026-11-10T10:30')]];
  const chk = (iso, extra = {}) => core.checkSlot(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', startMs: ms(iso), busy, nowMs: NOW, ...extra }).code || 'ok';
  assert.equal(chk('2026-11-10T10:00'), 'hora_tomada');
  assert.equal(chk('2026-11-10T10:30'), 'hora_tomada'); // tiempo entre citas de 10 min
  assert.equal(chk('2026-11-10T10:45'), 'ok');
  assert.equal(chk('2026-11-10T09:45'), 'fuera_de_horario');
  assert.equal(chk('2026-11-10T19:00'), 'fuera_de_horario');
  assert.equal(chk('2026-11-10T10:50'), 'fuera_de_horario'); // fuera de la grilla de 15 min
  assert.equal(chk('2026-11-09T07:00'), 'hora_pasada');
  assert.equal(chk('2026-11-09T09:30'), 'muy_pronto');
  assert.equal(chk('2026-12-15T10:00'), 'fuera_de_horizonte');
  assert.equal(chk('2026-11-15T10:00'), 'fuera_de_horario'); // domingo
  // una cita existente justo antes deja margen: 10:20–10:40 bloquea 10:45? (10:40 + 10 min > 10:45)
  const b2 = [[ms('2026-11-10T10:20'), ms('2026-11-10T10:40')]];
  assert.equal(core.checkSlot(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', startMs: ms('2026-11-10T10:45'), busy: b2, nowMs: NOW }).code, 'hora_tomada');
  assert.equal(core.checkSlot(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', startMs: ms('2026-11-10T11:00'), busy: b2, nowMs: NOW }).ok, true);
});

test('America/Santiago: los horarios respetan el cambio de hora (2026-09 y 2027-04)', () => {
  const utc = (fecha) => core.slotsForDay(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', fecha, busy: [], nowMs: ms(fecha + 'T00:00') - 86400000 * 2 })[0].inicio;
  // Invierno (UTC-4) → verano (UTC-3): el sábado 5-sep-2026 a las 24:00 los relojes pasan a 01:00.
  assert.equal(utc('2026-09-04'), '2026-09-04T14:00:00.000Z');
  assert.equal(utc('2026-09-07'), '2026-09-07T13:00:00.000Z');
  // Verano → invierno: el sábado 3-abr-2027 a las 24:00 vuelven a 23:00.
  assert.equal(utc('2027-04-02'), '2027-04-02T13:00:00.000Z');
  assert.equal(utc('2027-04-05'), '2027-04-05T14:00:00.000Z');
  // Hora local inexistente (00:00 del 6-sep-2026): un tramo que la usa se descarta.
  const cfg = structuredClone(CFG);
  cfg.horario.excepciones.push({ fecha: '2026-09-06', tramos: [['00:00', '00:30']] });
  assert.equal(core.workingDay(cfg, cfg.profesionales[0], '2026-09-06').tramos.length, 0);
  // Las fechas se calculan en la zona del negocio y no en UTC: 23:30 local del lunes sigue siendo lunes.
  assert.equal(DateTime.fromMillis(ms('2026-11-09T23:30'), { zone: Z }).toFormat('yyyy-MM-dd'), '2026-11-09');
});

test('ocupación: ignora cancelados, transparentes y el propio evento; días completos bloquean', () => {
  const items = [
    { id: 'a', status: 'confirmed', start: { dateTime: '2026-11-10T10:00:00-03:00' }, end: { dateTime: '2026-11-10T11:00:00-03:00' } },
    { id: 'b', status: 'cancelled', start: { dateTime: '2026-11-10T12:00:00-03:00' }, end: { dateTime: '2026-11-10T13:00:00-03:00' } },
    { id: 'c', status: 'confirmed', transparency: 'transparent', start: { dateTime: '2026-11-10T15:00:00-03:00' }, end: { dateTime: '2026-11-10T16:00:00-03:00' } },
    { id: 'propio', status: 'confirmed', start: { dateTime: '2026-11-10T17:00:00-03:00' }, end: { dateTime: '2026-11-10T18:00:00-03:00' } },
    { id: 'dia', status: 'confirmed', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
  ];
  const busy = core.busyFromEvents(CFG, items, 'propio');
  assert.equal(busy.length, 2);
  assert.equal(core.slotsForDay(CFG, { profId: 'prof-prueba-1', serviceId: 'srv-prueba-a', fecha: '2026-11-12', busy, nowMs: NOW }).length, 0);
  assert.throws(() => core.busyFromEvents(CFG, [{ id: 'x', start: {}, end: {} }]));
});

const valid = () => ({
  servicioId: 'srv-prueba-a', profesionalId: 'prof-prueba-1', inicio: '2026-11-10T13:00:00.000Z',
  nombre: '  Ana  María ', telefono: '+56 9 1234 5678', email: 'Ana@Example.com', consentimiento: true,
  claveIdempotencia: '0b5c7a3e-9a51-4c43-8f2a-6c1d2e3f4a5b', claveGestion: 'a'.repeat(64),
});

test('validación de reserva: normaliza, rechaza basura y genera identificadores estables', () => {
  const r = core.validateBooking(CFG, valid(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.nombre, 'Ana María');
  assert.equal(r.data.telefono, '+56912345678');
  assert.equal(r.data.email, 'ana@example.com');
  assert.match(r.data.reserva, /^r[a-f0-9]{23}$/);
  assert.match(r.data.evento, /^[a-v0-9]{5,1024}$/); // reglas de id de Google Calendar
  assert.equal(core.validateBooking(CFG, valid(), NOW).data.reserva, r.data.reserva); // misma clave → mismo id
  assert.notEqual(core.validateBooking(CFG, { ...valid(), nombre: 'Otra Persona' }, NOW).data.huella, r.data.huella);
  for (const [campo, valor] of [['telefono', '12345'], ['nombre', '<script>'], ['email', 'no-es-correo'], ['consentimiento', false], ['claveIdempotencia', 'corta'], ['claveGestion', 'xyz'], ['inicio', 'mañana']]) {
    const bad = core.validateBooking(CFG, { ...valid(), [campo]: valor }, NOW);
    assert.equal(bad.ok, false, campo);
    assert.equal(bad.res.status, 400);
    assert.ok(bad.res.body.extra === undefined);
  }
  assert.equal(core.validateBooking(CFG, { ...valid(), sitioWeb: 'http://spam' }, NOW).ok, false);
  assert.equal(core.validateBooking(CFG, { ...valid(), nombre: 'x'.repeat(5000) }, NOW).ok, false); // tamaño máximo
  assert.equal(core.validateBooking(CFG, { ...valid(), servicioId: 'srv-prueba-c', profesionalId: 'prof-prueba-2' }, NOW).res.body.error, 'servicio_no_disponible');
});

test('token de gestión: se guarda solo el hash y se compara en tiempo constante', () => {
  const row = { reserva: 'r' + 'a'.repeat(23), tokenHash: core.tokenHash('b'.repeat(64)) };
  assert.equal(core.verifyToken(row, 'b'.repeat(64)), true);
  assert.equal(core.verifyToken(row, 'c'.repeat(64)), false);
  assert.equal(core.verifyToken(null, 'b'.repeat(64)), false);
  assert.equal(core.validateManage(CFG, { accion: 'cancelar', reserva: 'r123', clave: 'x' }).res.status, 404);
});

test('catálogo público: sin calendarId ni datos internos', () => {
  const c = core.publicCatalog(CFG);
  const txt = JSON.stringify(c);
  assert.ok(!/calendar|@|REEMPLAZAR|credencial/i.test(txt));
  assert.equal(c.aviso, 'Entorno de pruebas: no genera reservas reales en Siena');
  assert.equal(c.notificaciones.demostrativas, true);
});

test('modo producción queda bloqueado mientras falten requisitos', () => {
  assert.deepEqual(core.productionGate(CFG), { ok: true });
  const p = structuredClone(CFG); p.entorno.modo = 'produccion';
  const g = core.productionGate(p);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'produccion_bloqueada');
  assert.ok(g.faltan.includes('pruebaIntegracionGoogleCalendarAprobada'));
  const d = structuredClone(CFG); d.entorno.modo = 'demo';
  assert.equal(core.productionGate(d).code, 'modo_demo');
});

const ev = (startIso, extra = {}) => ({
  id: 'spx', status: 'confirmed', start: { dateTime: startIso }, end: { dateTime: startIso },
  extendedProperties: { private: { sienaServicio: 'srv-prueba-a', sienaProfesional: 'prof-prueba-1', sienaNombre: 'Ana María', sienaEmail: 'pruebas-cliente@example.com', sienaTelefono: '+56912345678' } },
  ...extra,
});
const START = '2026-11-12T14:00:00.000Z';
const booking = { reserva: 'r' + 'a'.repeat(23), estado: 'confirmada', inicio: START };
const rem = { reserva: booking.reserva, tipo: 'recordatorio', destinatario: 'cliente', inicioRef: START, intentos: 0 };

test('avisos: se consulta el estado vigente antes de cada recordatorio', () => {
  assert.equal(core.decideNotification(CFG, rem, { ...booking, estado: 'cancelada' }, ev(START), 200, NOW).update.estado, 'omitido_cancelada');
  assert.equal(core.decideNotification(CFG, rem, booking, ev(START, { status: 'cancelled' }), 200, NOW).update.estado, 'omitido_cancelada');
  assert.equal(core.decideNotification(CFG, rem, booking, null, 404, NOW).update.estado, 'omitido_cancelada');
  const moved = core.decideNotification(CFG, rem, booking, ev('2026-11-13T15:00:00.000Z'), 200, NOW);
  assert.equal(moved.update.estado, 'omitido_horario_cambiado');
  assert.equal(moved.nuevoAviso.inicioRef, '2026-11-13T15:00:00.000Z');
  const ok = core.decideNotification(CFG, rem, booking, ev(START), 200, NOW);
  assert.equal(ok.update.estado, 'vista_previa');
  assert.equal(ok.update.resultado, 'envios_externos_apagados');
  assert.match(ok.update.vistaPrevia, /^\[PRUEBA/);
  assert.ok(!ok.update.vistaPrevia.includes('Ana'));
  const retry = core.decideNotification(CFG, rem, booking, null, 503, NOW);
  assert.equal(retry.update.estado, 'pendiente');
  assert.equal(retry.update.intentos, 1);
});

test('avisos: email solo con envíos externos activos y destinatario autorizado; WhatsApp nunca', () => {
  const on = structuredClone(CFG);
  on.notificaciones.enviosExternosHabilitados = true; on.notificaciones.email.habilitado = true;
  const send = core.decideNotification(on, rem, booking, ev(START), 200, NOW);
  assert.equal(send.accion, 'enviar_email');
  assert.equal(send.email.para, 'pruebas-cliente@example.com');
  const notAllowed = core.decideNotification(on, rem, booking, ev(START, { extendedProperties: { private: { sienaEmail: 'no-autorizada@example.org' } } }), 200, NOW);
  assert.equal(notAllowed.update.resultado, 'destinatario_no_autorizado');
  assert.equal(core.emailResult(on, rem, { id: 'abc' }, NOW).estado, 'enviado');
  const failed = core.emailResult(on, { ...rem, intentos: 2 }, { error: 'x' }, NOW);
  assert.equal(failed.estado, 'fallido'); // máximo 3 intentos
});

test('filas de avisos: confirmación inmediata y recordatorio 24 h antes si alcanza', () => {
  const rows = core.notificationRows(CFG, booking.reserva, Date.parse(START), NOW);
  assert.deepEqual(rows.map((r) => `${r.tipo}/${r.destinatario}`).sort(), ['confirmacion/cliente', 'confirmacion/salon', 'recordatorio/cliente', 'recordatorio/salon']);
  const soon = core.notificationRows(CFG, booking.reserva, NOW + 3 * 3600e3, NOW);
  assert.ok(soon.every((r) => r.tipo === 'confirmacion'));
});

test('límite de uso por IP con ventana fija', () => {
  const store = {};
  for (let i = 0; i < 3; i++) assert.equal(core.rateLimit(store, 'x', '1.2.3.4', 3, 60000, NOW), true);
  assert.equal(core.rateLimit(store, 'x', '1.2.3.4', 3, 60000, NOW), false);
  assert.equal(core.rateLimit(store, 'x', '1.2.3.4', 3, 60000, NOW + 60001), true);
  assert.ok(!JSON.stringify(store).includes('1.2.3.4')); // no guarda la IP en claro
  // Se toma el valor que agrega el proxy de confianza (derecha), no el que puede falsificar el cliente (izquierda).
  assert.equal(core.clientIp({ 'x-forwarded-for': '6.6.6.6, 5.6.7.8' }, 1), '5.6.7.8');
  assert.equal(core.clientIp({ 'x-forwarded-for': '6.6.6.6, 5.6.7.8, 10.0.0.1' }, 2), '5.6.7.8');
  assert.equal(core.clientIp({}, 1), 'desconocida');
});

test('evento de Google: sin invitados, con id válido y datos solo en propiedades privadas', () => {
  const d = core.validateBooking(CFG, valid(), NOW).data;
  const e = core.buildEvent(CFG, d, 'prof-prueba-1');
  assert.equal(e.id, d.evento);
  assert.equal(e.attendees, undefined);
  assert.match(e.summary, /^\[PRUEBA\]/);
  assert.equal(e.start.timeZone, Z);
  assert.equal(Date.parse(e.start.dateTime), d.startMs);
  assert.equal(e.extendedProperties.private.sienaReserva, d.reserva);
});
