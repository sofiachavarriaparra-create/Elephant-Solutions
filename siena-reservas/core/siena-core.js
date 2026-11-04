/*
 * Siena · Núcleo de reservas (DATOS Y ENTORNO DE PRUEBAS)
 *
 * Lógica pura, sin red ni secretos. Se usa de dos formas:
 *   1) En Node para las pruebas unitarias (tests/unit).
 *   2) Incrustada tal cual dentro de los nodos Code de n8n por scripts/build-workflows.mjs.
 *
 * Recibe Luxon (DateTime) por inyección: n8n lo expone como global en el nodo Code
 * y en las pruebas se importa del paquete "luxon".
 *
 * No hace llamadas HTTP (el sandbox del nodo Code de n8n no tiene red) y no genera
 * números aleatorios: los tokens de gestión los crea el navegador con crypto.getRandomValues
 * y aquí solo se guarda su hash.
 */
function createSienaCore(DateTime) {
  'use strict';

  /* ------------------------------------------------------------------ SHA-256 (puro) */
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
    return Uint8Array.from(out);
  }
  function sha256Hex(input) {
    const msg = utf8(String(input));
    const len = msg.length;
    const bitLenHi = Math.floor((len * 8) / 0x100000000);
    const bitLenLo = (len * 8) >>> 0;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHi);
    dv.setUint32(padded.length - 4, bitLenLo);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  function safeEqualHex(a, b) {
    a = String(a || ''); b = String(b || '');
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  /* ------------------------------------------------------------------ utilidades */
  const DIAS = ['', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']; // Luxon: 1 = lunes
  const MIN = 60000;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const findProf = (cfg, id) => (cfg.profesionales || []).find((p) => p.id === id && p.activo !== false) || null;
  const findSvc = (cfg, id) => (cfg.servicios || []).find((s) => s.id === id) || null;
  const tz = (cfg) => (cfg.entorno && cfg.entorno.zonaHoraria) || 'America/Santiago';
  const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  function err(status, code, mensaje, extra) {
    return Object.assign({ status, body: { ok: false, error: code, mensaje, reintentable: status >= 500 || status === 429 } }, extra ? { extra } : {});
  }
  const MENSAJES = {
    solicitud_invalida: 'Revisa los datos e inténtalo de nuevo.',
    demasiadas_solicitudes: 'Demasiadas solicitudes seguidas. Espera un momento e inténtalo de nuevo.',
    hora_tomada: 'Esa hora se acaba de ocupar. Elige otra.',
    hora_pasada: 'Esa hora ya pasó. Elige otra.',
    muy_pronto: 'Esa hora es demasiado pronto para reservar en línea. Elige una más adelante.',
    fuera_de_horizonte: 'Aún no abrimos la agenda para esa fecha.',
    fuera_de_horario: 'Esa hora no está dentro del horario de atención.',
    cruza_descanso: 'El servicio no alcanza a terminar antes del descanso. Elige otra hora.',
    servicio_no_disponible: 'Ese servicio no está disponible con esa profesional.',
    agenda_ocupada: 'Estamos procesando otra reserva para esa agenda. Reintentando…',
    calendario_no_disponible: 'No pudimos confirmar con la agenda. Tu solicitud no se perdió: inténtalo de nuevo.',
    clave_reutilizada: 'Esta solicitud ya se usó con otros datos. Vuelve a elegir tu hora.',
    reserva_cancelada: 'Esta reserva fue cancelada.',
    enlace_invalido: 'El enlace no es válido o ya venció.',
    fuera_de_plazo: 'Ya no es posible hacer cambios en línea para esta hora.',
    limite_por_telefono: 'Ya tienes varias horas reservadas con este número.',
    produccion_bloqueada: 'El sistema no está habilitado para reservas reales.',
    modo_demo: 'El backend está en modo demo.',
    configuracion_incompleta: 'La agenda no está configurada todavía.',
    demasiados_eventos: 'No pudimos leer la agenda completa. Inténtalo de nuevo.',
  };
  const fail = (status, code, extra) => err(status, code, MENSAJES[code] || 'Ocurrió un problema.', extra);

  /* ------------------------------------------------------------------ configuración */
  function validateConfig(cfg) {
    const errors = [];
    if (!isObj(cfg)) return ['config no es un objeto'];
    const modo = cfg.entorno && cfg.entorno.modo;
    if (!['demo', 'pruebas', 'produccion'].includes(modo)) errors.push('entorno.modo debe ser demo, pruebas o produccion');
    if (!DateTime.local().setZone(tz(cfg)).isValid) errors.push('zona horaria inválida');
    const profIds = new Set();
    for (const p of cfg.profesionales || []) {
      if (!p.id || !/^[a-z0-9-]{2,40}$/.test(p.id)) errors.push(`profesional con id inválido: ${p.id}`);
      if (profIds.has(p.id)) errors.push(`profesional duplicado: ${p.id}`);
      profIds.add(p.id);
      if (!p.calendarId) errors.push(`profesional ${p.id} sin calendarId`);
    }
    if (!profIds.size) errors.push('no hay profesionales');
    for (const s of cfg.servicios || []) {
      if (!s.id || !/^[a-z0-9-]{2,40}$/.test(s.id)) errors.push(`servicio con id inválido: ${s.id}`);
      if (!(s.duracionMin > 0 && s.duracionMin <= 600 && Number.isInteger(s.duracionMin))) errors.push(`servicio ${s.id}: duración inválida`);
      for (const pid of s.profesionales || []) if (!profIds.has(pid)) errors.push(`servicio ${s.id}: profesional desconocido ${pid}`);
    }
    const checkTramos = (obj, where) => {
      for (const [dia, tramos] of Object.entries(obj || {})) {
        if (!DIAS.includes(dia) || !dia) errors.push(`${where}: día inválido ${dia}`);
        for (const t of tramos || []) {
          if (!Array.isArray(t) || !hhmmRe.test(t[0]) || !hhmmRe.test(t[1]) || t[0] >= t[1]) errors.push(`${where}.${dia}: tramo inválido ${JSON.stringify(t)}`);
        }
      }
    };
    checkTramos(cfg.horario && cfg.horario.semana, 'horario.semana');
    checkTramos(cfg.horario && cfg.horario.descansos, 'horario.descansos');
    for (const ex of (cfg.horario && cfg.horario.excepciones) || []) {
      if (!dateRe.test(ex.fecha || '')) errors.push(`excepción con fecha inválida: ${ex.fecha}`);
    }
    const r = cfg.reglas || {};
    if (!(r.intervaloInicioMin >= 5 && r.intervaloInicioMin <= 120)) errors.push('reglas.intervaloInicioMin fuera de rango');
    if (!(r.horizonteDias >= 1 && r.horizonteDias <= 365)) errors.push('reglas.horizonteDias fuera de rango');
    if (!(cfg.candado && cfg.candado.duracionMs > cfg.candado.margenMinimoMs)) errors.push('candado.duracionMs debe ser mayor que margenMinimoMs');
    const n = cfg.notificaciones || {};
    if (n.whatsapp && n.whatsapp.habilitado) errors.push('notificaciones.whatsapp.habilitado debe ser false: no hay acceso oficial verificado');
    return errors;
  }

  function productionGate(cfg) {
    const modo = cfg.entorno && cfg.entorno.modo;
    if (modo === 'demo') return { ok: false, code: 'modo_demo' };
    if (modo !== 'produccion') return { ok: true };
    const p = cfg.produccion || {};
    const faltan = Object.entries(p.requisitos || {}).filter(([, v]) => v !== true).map(([k]) => k);
    if (p.habilitada !== true || faltan.length) return { ok: false, code: 'produccion_bloqueada', faltan };
    return { ok: true };
  }

  function publicCatalog(cfg) {
    const profs = (cfg.profesionales || []).filter((p) => p.activo !== false);
    return {
      ok: true,
      modo: cfg.entorno.modo,
      aviso: cfg.entorno.modo === 'produccion' ? null : 'Entorno de pruebas: no genera reservas reales en Siena',
      zonaHoraria: tz(cfg),
      datosDePrueba: true,
      horizonteDias: cfg.reglas.horizonteDias,
      diasPorConsulta: cfg.reglas.diasPorConsulta,
      servicios: (cfg.servicios || []).map((s) => ({
        id: s.id, nombre: s.nombre, duracionMin: s.duracionMin,
        profesionales: (s.profesionales || []).filter((id) => profs.some((p) => p.id === id)),
      })),
      profesionales: profs.map((p) => ({ id: p.id, nombre: p.nombre })),
      notificaciones: {
        whatsapp: false,
        email: !!(cfg.notificaciones.enviosExternosHabilitados && cfg.notificaciones.email.habilitado),
        demostrativas: !cfg.notificaciones.enviosExternosHabilitados,
      },
    };
  }

  /* ------------------------------------------------------------------ horario y zona horaria */
  function localDt(cfg, fecha, hhmm) {
    const dt = DateTime.fromISO(`${fecha}T${hhmm}`, { zone: tz(cfg) });
    // Luxon corre hacia adelante las horas que no existen (cambio de hora): se descartan.
    if (!dt.isValid || dt.toFormat('yyyy-MM-dd HH:mm') !== `${fecha} ${hhmm}`) return null;
    return dt;
  }
  function tramosToMs(cfg, fecha, tramos) {
    const out = [];
    for (const [a, b] of tramos || []) {
      const s = localDt(cfg, fecha, a), e = localDt(cfg, fecha, b);
      if (s && e && e > s) out.push([s.toMillis(), e.toMillis()]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  }
  function subtract(intervals, cuts) {
    let res = intervals.slice();
    for (const [cs, ce] of cuts) {
      const next = [];
      for (const [s, e] of res) {
        if (ce <= s || cs >= e) { next.push([s, e]); continue; }
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
      res = next;
    }
    return res;
  }
  /** Jornada del día (antes de descansos) y tramos efectivos (después de descansos), en ms UTC. */
  function workingDay(cfg, prof, fecha) {
    if (!dateRe.test(fecha)) return { jornada: [], tramos: [] };
    const base = DateTime.fromISO(fecha, { zone: tz(cfg) });
    if (!base.isValid) return { jornada: [], tramos: [] };
    const dia = DIAS[base.weekday];
    const h = (prof && prof.horario) || {};
    const global = cfg.horario || {};
    const ex = (global.excepciones || []).find((x) => x.fecha === fecha && (!x.profesional || x.profesional === (prof && prof.id)));
    if (ex && ex.cerrado) return { jornada: [], tramos: [], excepcion: ex.motivo || 'cerrado' };
    const semana = (h.semana || global.semana || {});
    const jornadaLocal = ex && ex.tramos ? ex.tramos : (semana[dia] || []);
    const descansosLocal = ex && ex.tramos ? (ex.descansos || []) : ((h.descansos || global.descansos || {})[dia] || []);
    const jornada = tramosToMs(cfg, fecha, jornadaLocal);
    const tramos = subtract(jornada, tramosToMs(cfg, fecha, descansosLocal));
    return { jornada, tramos };
  }

  /** Convierte la respuesta de events.list en intervalos ocupados. Nunca expone títulos ni personas. */
  function busyFromEvents(cfg, items, excludeEventId) {
    const busy = [];
    for (const e of items || []) {
      if (!e || e.status === 'cancelled' || e.transparency === 'transparent') continue;
      if (excludeEventId && e.id === excludeEventId) continue;
      const s = e.start || {}, en = e.end || {};
      let a, b;
      if (s.dateTime) a = Date.parse(s.dateTime);
      else if (s.date) a = DateTime.fromISO(s.date, { zone: tz(cfg) }).toMillis();
      if (en.dateTime) b = Date.parse(en.dateTime);
      else if (en.date) b = DateTime.fromISO(en.date, { zone: tz(cfg) }).toMillis();
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('evento_ilegible');
      busy.push([a, b]);
    }
    return busy.sort((x, y) => x[0] - y[0]);
  }

  function rules(cfg) {
    const r = cfg.reglas || {};
    return {
      step: (r.intervaloInicioMin || 15) * MIN,
      buffer: (r.tiempoEntreCitasMin || 0) * MIN,
      minAnt: (r.anticipacionMinimaMin || 0) * MIN,
      horizon: (r.horizonteDias || 30) * 24 * 60 * MIN,
    };
  }
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
  function isBusy(start, end, busy, buffer) {
    // La cita ocupa [inicio, fin + tiempo entre citas); cada evento existente también deja ese margen.
    return busy.some(([bs, be]) => overlaps(start, end + buffer, bs, be + buffer));
  }

  /** Horarios libres de una profesional para un servicio y una fecha local (YYYY-MM-DD). */
  function slotsForDay(cfg, { profId, serviceId, fecha, busy, nowMs }) {
    const prof = findProf(cfg, profId), svc = findSvc(cfg, serviceId);
    if (!prof || !svc || !(svc.profesionales || []).includes(profId)) return [];
    const { tramos } = workingDay(cfg, prof, fecha);
    const R = rules(cfg), dur = svc.duracionMin * MIN, out = [];
    for (const [ts, te] of tramos) {
      for (let s = ts; s + dur <= te; s += R.step) {
        if (s < nowMs + R.minAnt || s > nowMs + R.horizon) continue;
        if (isBusy(s, s + dur, busy || [], R.buffer)) continue;
        out.push({ inicio: new Date(s).toISOString(), hora: DateTime.fromMillis(s, { zone: tz(cfg) }).toFormat('HH:mm') });
      }
    }
    return out;
  }

  /** Valida un inicio concreto con todas las reglas y devuelve el motivo exacto si no sirve. */
  function checkSlot(cfg, { profId, serviceId, startMs, busy, nowMs }) {
    const prof = findProf(cfg, profId), svc = findSvc(cfg, serviceId);
    if (!prof || !svc || !(svc.profesionales || []).includes(profId)) return { ok: false, code: 'servicio_no_disponible' };
    if (!Number.isFinite(startMs)) return { ok: false, code: 'solicitud_invalida' };
    const R = rules(cfg), dur = svc.duracionMin * MIN, end = startMs + dur;
    if (startMs <= nowMs) return { ok: false, code: 'hora_pasada' };
    if (startMs < nowMs + R.minAnt) return { ok: false, code: 'muy_pronto' };
    if (startMs > nowMs + R.horizon) return { ok: false, code: 'fuera_de_horizonte' };
    const fecha = DateTime.fromMillis(startMs, { zone: tz(cfg) }).toFormat('yyyy-MM-dd');
    const { jornada, tramos } = workingDay(cfg, prof, fecha);
    const inTramo = tramos.find(([ts, te]) => startMs >= ts && end <= te);
    if (!inTramo) {
      const inJornada = jornada.some(([js, je]) => startMs >= js && end <= je);
      return { ok: false, code: inJornada ? 'cruza_descanso' : 'fuera_de_horario' };
    }
    if ((startMs - inTramo[0]) % R.step !== 0) return { ok: false, code: 'fuera_de_horario' };
    if (isBusy(startMs, end, busy || [], R.buffer)) return { ok: false, code: 'hora_tomada' };
    return { ok: true, startMs, endMs: end, fecha, hora: DateTime.fromMillis(startMs, { zone: tz(cfg) }).toFormat('HH:mm') };
  }

  /* ------------------------------------------------------------------ validación de entradas */
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max + 1) : '');
  function normalizePhone(raw) {
    const d = String(raw || '').replace(/[^\d+]/g, '');
    let digits = d.replace(/^\+/, '');
    if (digits.startsWith('56')) digits = digits.slice(2);
    if (/^9\d{8}$/.test(digits)) return '+56' + digits;
    return null;
  }
  function normalizeName(raw) {
    const n = s(raw, 80).replace(/\s+/g, ' ');
    if (n.length < 2 || n.length > 60) return null;
    if (!/^[\p{L}][\p{L} .'’-]*$/u.test(n)) return null;
    return n;
  }
  function normalizeEmail(raw) {
    const e = s(raw, 130).toLowerCase();
    if (!e) return '';
    if (e.length > 120 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
    return e;
  }
  const keyRe = /^[A-Za-z0-9-]{16,64}$/;
  const tokenRe = /^[a-f0-9]{64}$/;

  function bodySizeOk(cfg, body) {
    try { return JSON.stringify(body || {}).length <= ((cfg.limites && cfg.limites.tamanoMaximoCuerpo) || 4000); } catch { return false; }
  }

  function validateAvailabilityQuery(cfg, body, nowMs) {
    if (!isObj(body) || !bodySizeOk(cfg, body)) return { ok: false, res: fail(400, 'solicitud_invalida') };
    const accion = body.accion;
    if (accion === 'catalogo') return { ok: true, accion };
    if (accion !== 'horarios') return { ok: false, res: fail(400, 'solicitud_invalida') };
    const svc = findSvc(cfg, body.servicioId);
    if (!svc) return { ok: false, res: fail(400, 'solicitud_invalida') };
    const pid = body.profesionalId || 'cualquiera';
    const candidatos = pid === 'cualquiera'
      ? (svc.profesionales || []).map((id) => findProf(cfg, id)).filter(Boolean)
      : (findProf(cfg, pid) && (svc.profesionales || []).includes(pid) ? [findProf(cfg, pid)] : []);
    if (!candidatos.length) return { ok: false, res: fail(400, 'servicio_no_disponible') };
    const hoy = DateTime.fromMillis(nowMs, { zone: tz(cfg) }).startOf('day');
    const desde = dateRe.test(body.desde || '') ? DateTime.fromISO(body.desde, { zone: tz(cfg) }) : hoy;
    const maxDias = cfg.reglas.diasPorConsulta || 14;
    const dias = Math.max(1, Math.min(maxDias, parseInt(body.dias, 10) || maxDias));
    if (!desde.isValid || desde < hoy || desde > hoy.plus({ days: cfg.reglas.horizonteDias })) return { ok: false, res: fail(400, 'fuera_de_horizonte') };
    const fechas = [];
    for (let i = 0; i < dias; i++) {
      const f = desde.plus({ days: i });
      if (f > hoy.plus({ days: cfg.reglas.horizonteDias })) break;
      fechas.push(f.toFormat('yyyy-MM-dd'));
    }
    const timeMin = DateTime.fromISO(fechas[0], { zone: tz(cfg) }).minus({ days: 1 }).toUTC().toISO();
    const timeMax = DateTime.fromISO(fechas[fechas.length - 1], { zone: tz(cfg) }).plus({ days: 2 }).toUTC().toISO();
    return { ok: true, accion, servicioId: svc.id, profesionalId: pid, candidatos: candidatos.map((p) => p.id), fechas, timeMin, timeMax };
  }

  function computeAvailability(cfg, q, busyByProf, nowMs) {
    const dias = q.fechas.map((fecha) => {
      const porHora = new Map();
      for (const pid of q.candidatos) {
        for (const slot of slotsForDay(cfg, { profId: pid, serviceId: q.servicioId, fecha, busy: busyByProf[pid] || [], nowMs })) {
          if (!porHora.has(slot.inicio)) porHora.set(slot.inicio, slot);
        }
      }
      const horarios = [...porHora.values()].sort((a, b) => a.inicio.localeCompare(b.inicio));
      const anyWork = q.candidatos.some((pid) => workingDay(cfg, findProf(cfg, pid), fecha).tramos.length > 0);
      return { fecha, abierto: anyWork, horarios };
    });
    return { ok: true, servicioId: q.servicioId, profesionalId: q.profesionalId, zonaHoraria: tz(cfg), dias };
  }

  function validateBooking(cfg, body, nowMs) {
    if (!isObj(body) || !bodySizeOk(cfg, body)) return { ok: false, res: fail(400, 'solicitud_invalida') };
    if (body.sitioWeb) return { ok: false, res: fail(400, 'solicitud_invalida') }; // trampa para bots
    const errores = [];
    const svc = findSvc(cfg, body.servicioId);
    if (!svc) errores.push('servicioId');
    const pid = body.profesionalId || 'cualquiera';
    if (pid !== 'cualquiera' && !findProf(cfg, pid)) errores.push('profesionalId');
    const startMs = typeof body.inicio === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body.inicio) ? Date.parse(body.inicio) : NaN;
    if (!Number.isFinite(startMs)) errores.push('inicio');
    const nombre = normalizeName(body.nombre);
    if (!nombre) errores.push('nombre');
    const telefono = normalizePhone(body.telefono);
    if (!telefono) errores.push('telefono');
    const email = normalizeEmail(body.email);
    if (email === null) errores.push('email');
    if (body.consentimiento !== true) errores.push('consentimiento');
    if (!keyRe.test(body.claveIdempotencia || '')) errores.push('claveIdempotencia');
    if (!tokenRe.test(body.claveGestion || '')) errores.push('claveGestion');
    if (errores.length) return { ok: false, res: fail(400, 'solicitud_invalida', { campos: errores }) };
    const candidatos = pid === 'cualquiera'
      ? (svc.profesionales || []).filter((id) => findProf(cfg, id))
      : ((svc.profesionales || []).includes(pid) ? [pid] : []);
    if (!candidatos.length) return { ok: false, res: fail(409, 'servicio_no_disponible') };
    const reserva = 'r' + sha256Hex('reserva|' + body.claveIdempotencia).slice(0, 23);
    const data = {
      reserva,
      evento: eventIdFor(reserva),
      servicioId: svc.id,
      profesionalSolicitado: pid,
      candidatos,
      startMs,
      endMs: startMs + svc.duracionMin * MIN,
      nombre, telefono, email,
      consentimiento: true,
      tokenHash: tokenHash(body.claveGestion),
      telefonoHash: sha256Hex('tel|' + telefono).slice(0, 32),
    };
    data.huella = sha256Hex(JSON.stringify([data.servicioId, pid, startMs, nombre, telefono, email]));
    return { ok: true, data };
  }

  const eventIdFor = (reserva) => 'sp' + sha256Hex('evento|' + reserva).slice(0, 30); // solo [a-v0-9]
  const tokenHash = (token) => sha256Hex('gestion|' + token);

  function validateManage(cfg, body) {
    if (!isObj(body) || !bodySizeOk(cfg, body)) return { ok: false, res: fail(400, 'solicitud_invalida') };
    const accion = body.accion;
    if (!['consultar', 'cancelar', 'reagendar'].includes(accion)) return { ok: false, res: fail(400, 'solicitud_invalida') };
    if (!/^r[a-f0-9]{23}$/.test(body.reserva || '') || !tokenRe.test(body.clave || '')) return { ok: false, res: fail(404, 'enlace_invalido') };
    let nuevoInicioMs = null;
    if (accion === 'reagendar') {
      nuevoInicioMs = typeof body.nuevoInicio === 'string' ? Date.parse(body.nuevoInicio) : NaN;
      if (!Number.isFinite(nuevoInicioMs)) return { ok: false, res: fail(400, 'solicitud_invalida') };
    }
    return { ok: true, accion, reserva: body.reserva, clave: body.clave, nuevoInicioMs };
  }

  function verifyToken(row, clave) {
    if (!row || !row.reserva || !row.tokenHash) return false;
    return safeEqualHex(row.tokenHash, tokenHash(clave));
  }

  /* ------------------------------------------------------------------ Google Calendar */
  function calendarUrl(cfg, calendarId, suffix) {
    const base = String(cfg.google.apiBase || '').replace(/\/+$/, '');
    return `${base}/calendars/${encodeURIComponent(calendarId)}/events${suffix || ''}`;
  }
  function listUrl(cfg, calendarId, timeMinIso, timeMaxIso) {
    const q = [
      ['timeMin', timeMinIso], ['timeMax', timeMaxIso], ['singleEvents', 'true'], ['showDeleted', 'false'],
      ['maxResults', '2500'], ['fields', 'items(id,status,start,end,transparency),nextPageToken'],
    ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return calendarUrl(cfg, calendarId, '?' + q);
  }
  function eventUrl(cfg, calendarId, eventId, query) {
    return calendarUrl(cfg, calendarId, '/' + encodeURIComponent(eventId) + (query ? '?' + query : ''));
  }
  /** Interpreta la salida del nodo HTTP Request (respuesta completa, sin fallar en 4xx/5xx, con "continuar" en errores). */
  function httpResult(item) {
    const j = (item && item.json) || item || {};
    if (j.error && !j.statusCode) return { ok: false, status: 0, timeout: /timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up/i.test(JSON.stringify(j.error)), body: null };
    const status = Number(j.statusCode) || 0;
    let body = j.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* texto */ } }
    return { ok: status >= 200 && status < 300, status, body };
  }
  function busyFromListResult(cfg, item, excludeEventId) {
    const r = httpResult(item);
    if (!r.ok) return { ok: false, code: 'calendario_no_disponible', status: r.status };
    if (r.body && r.body.nextPageToken) return { ok: false, code: 'demasiados_eventos' };
    try {
      return { ok: true, busy: busyFromEvents(cfg, (r.body && r.body.items) || [], excludeEventId), items: (r.body && r.body.items) || [] };
    } catch {
      return { ok: false, code: 'calendario_no_disponible' };
    }
  }

  function buildEvent(cfg, d, profId) {
    const svc = findSvc(cfg, d.servicioId), prof = findProf(cfg, profId), zone = tz(cfg);
    const primerNombre = d.nombre.split(' ')[0];
    const tag = cfg.entorno.modo === 'produccion' ? '' : '[PRUEBA] ';
    return {
      id: d.evento,
      summary: `${tag}${svc.nombre} · ${primerNombre}`,
      description: [
        cfg.entorno.modo === 'produccion' ? 'Reserva creada desde la web.' : 'RESERVA DE PRUEBA creada desde la web. No es una cita real de Siena.',
        `Código: ${d.reserva}`,
        `Servicio: ${svc.nombre}`,
        `Profesional: ${prof.nombre}`,
        `Nombre: ${d.nombre}`,
        `WhatsApp: ${d.telefono}`,
        `Email: ${d.email || '—'}`,
      ].join('\n'),
      start: { dateTime: DateTime.fromMillis(d.startMs, { zone }).toISO({ suppressMilliseconds: true }), timeZone: zone },
      end: { dateTime: DateTime.fromMillis(d.endMs, { zone }).toISO({ suppressMilliseconds: true }), timeZone: zone },
      transparency: 'opaque',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: {
        private: {
          sienaReserva: d.reserva, sienaEntorno: cfg.entorno.modo, sienaServicio: d.servicioId,
          sienaProfesional: profId, sienaNombre: d.nombre, sienaTelefono: d.telefono, sienaEmail: d.email || '',
        },
      },
    };
  }
  function eventStartMs(ev) {
    return ev && ev.start && ev.start.dateTime ? Date.parse(ev.start.dateTime) : NaN;
  }

  /* ------------------------------------------------------------------ registros (Data tables) */
  function bookingRow(cfg, d, profId, estado, extra) {
    const prof = findProf(cfg, profId);
    return Object.assign({
      reserva: d.reserva, estado, huella: d.huella, tokenHash: d.tokenHash,
      servicio: d.servicioId, profesional: profId, calendario: prof.calendarId, evento: d.evento,
      inicio: new Date(d.startMs).toISOString(), fin: new Date(d.endMs).toISOString(),
      telefonoHash: d.telefonoHash, version: 1, ultimoError: '', consentimiento: true, entorno: cfg.entorno.modo,
    }, extra || {});
  }
  function notificationRows(cfg, reserva, startMs, nowMs) {
    const n = cfg.notificaciones, rows = [];
    for (const destinatario of ['cliente', 'salon']) {
      rows.push(avisoRow(reserva, 'confirmacion', destinatario, nowMs, startMs));
      const rec = startMs - (n.recordatorioHorasAntes || 24) * 60 * MIN;
      if (rec > nowMs + 5 * MIN) rows.push(avisoRow(reserva, 'recordatorio', destinatario, rec, startMs));
    }
    return rows;
  }
  function reminderRows(cfg, reserva, startMs, nowMs) {
    return notificationRows(cfg, reserva, startMs, nowMs).filter((r) => r.tipo === 'recordatorio');
  }
  function avisoRow(reserva, tipo, destinatario, programadaPara, startMs) {
    return {
      reserva, tipo, destinatario, canal: 'auto', estado: 'pendiente', programadaPara,
      inicioRef: new Date(startMs).toISOString(), intentos: 0, reclamo: '', reclamadaEn: 0, resultado: '', vistaPrevia: '',
    };
  }

  /* ------------------------------------------------------------------ avisos */
  const mask = (v) => (v ? String(v).slice(0, 1) + '•••' : '');
  function renderMessage(cfg, tipo, destinatario, info) {
    const demo = cfg.entorno.modo !== 'produccion' ? '[PRUEBA – mensaje demostrativo, no es una cita real] ' : '';
    const cuando = `${info.fechaLarga} a las ${info.hora}`;
    if (destinatario === 'salon') {
      const t = { confirmacion: 'Nueva reserva', recordatorio: 'Recordatorio de cita', cancelacion: 'Reserva cancelada' }[tipo];
      return { asunto: `${demo}${t}: ${info.servicio}`, texto: `${demo}${t}: ${info.servicio} con ${info.profesional}, ${cuando}. Clienta/e: ${info.nombre}. Código ${info.reserva}.` };
    }
    const t = {
      confirmacion: `Hola ${info.nombre}, tu hora quedó reservada: ${info.servicio}, ${cuando}.`,
      recordatorio: `Hola ${info.nombre}, te recordamos tu hora: ${info.servicio}, ${cuando}.`,
      cancelacion: `Hola ${info.nombre}, tu hora de ${info.servicio} del ${cuando} quedó cancelada.`,
    }[tipo];
    return { asunto: `${demo}Siena · ${tipo === 'recordatorio' ? 'Recordatorio' : tipo === 'cancelacion' ? 'Cancelación' : 'Confirmación'}`, texto: `${demo}${t} Código ${info.reserva}.` };
  }
  function eventInfo(cfg, row, ev, booking) {
    const p = (ev && ev.extendedProperties && ev.extendedProperties.private) || {};
    let startMs = eventStartMs(ev);
    if (!Number.isFinite(startMs) && booking) startMs = Date.parse(booking.inicio);
    const dt = DateTime.fromMillis(startMs, { zone: tz(cfg) }).setLocale('es');
    const svc = findSvc(cfg, p.sienaServicio || (booking && booking.servicio)) || { nombre: 'Servicio' };
    const prof = findProf(cfg, p.sienaProfesional || (booking && booking.profesional)) || { nombre: 'Profesional' };
    return {
      reserva: row.reserva, servicio: svc.nombre, profesional: prof.nombre,
      fechaLarga: dt.toFormat("cccc d 'de' LLLL"), hora: dt.toFormat('HH:mm'),
      nombre: (p.sienaNombre || '').split(' ')[0], email: p.sienaEmail || '', telefono: p.sienaTelefono || '',
    };
  }
  /**
   * Decide qué hacer con un aviso reclamado, consultando el estado VIGENTE de la reserva y del evento.
   * evento: objeto del evento o null; eventoStatus: código HTTP de la lectura (404/410 = no existe).
   */
  function decideNotification(cfg, row, booking, evento, eventoStatus, nowMs) {
    const n = cfg.notificaciones;
    const out = (estado, extra) => Object.assign({ accion: 'guardar', update: { estado, reclamo: '', resultado: estado } }, extra || {});
    if (!booking || !booking.reserva) return out('omitido_sin_reserva');
    if (eventoStatus && eventoStatus !== 200 && eventoStatus !== 404 && eventoStatus !== 410) {
      return reintentar(cfg, row, nowMs, `calendario_${eventoStatus || 'sin_respuesta'}`);
    }
    if (booking.estado === 'creando' || booking.estado === 'error_calendario') {
      // La reserva aún se está confirmando (o espera un reintento): se pospone, sin contar intento, hasta 24 h.
      if (nowMs - (Number(row.programadaPara) || 0) < 24 * 60 * MIN) {
        return { accion: 'guardar', update: { estado: 'pendiente', reclamo: '', resultado: 'esperando_confirmacion', programadaPara: nowMs + 5 * MIN } };
      }
      return out('omitido_no_confirmada');
    }
    const cancelada = booking.estado === 'cancelada' || !evento || evento.status === 'cancelled' || eventoStatus === 404 || eventoStatus === 410;
    if (cancelada && row.tipo !== 'cancelacion') return out('omitido_cancelada');
    if (!cancelada && booking.estado !== 'confirmada') return out('omitido_no_confirmada');
    const startMs = eventStartMs(evento);
    if (row.tipo === 'recordatorio') {
      if (!(startMs === Date.parse(row.inicioRef))) {
        const r = { accion: 'guardar', update: { estado: 'omitido_horario_cambiado', reclamo: '', resultado: 'omitido_horario_cambiado' } };
        const prog = startMs - (n.recordatorioHorasAntes || 24) * 60 * MIN;
        if (Number.isFinite(startMs) && prog > nowMs) r.nuevoAviso = avisoRow(row.reserva, 'recordatorio', row.destinatario, prog, startMs);
        return r;
      }
      if (startMs <= nowMs) return out('omitido_vencido');
    }
    const info = eventInfo(cfg, row, evento, booking);
    const msg = renderMessage(cfg, row.tipo, row.destinatario, info);
    const to = row.destinatario === 'salon' ? (n.salon && n.salon.email) || '' : info.email;
    const autorizados = ((n.email && n.email.destinatariosAutorizados) || []).map((x) => String(x).toLowerCase());
    const puedeEmail = n.enviosExternosHabilitados === true && n.email && n.email.habilitado === true && to && autorizados.includes(String(to).toLowerCase());
    const preview = renderMessage(cfg, row.tipo, row.destinatario, Object.assign({}, info, { nombre: mask(info.nombre) })).texto;
    if (puedeEmail) return { accion: 'enviar_email', email: { para: to, asunto: msg.asunto, texto: msg.texto }, vistaPrevia: preview };
    const motivo = n.enviosExternosHabilitados !== true ? 'envios_externos_apagados' : !to ? 'sin_destinatario' : 'destinatario_no_autorizado';
    return { accion: 'guardar', update: { estado: 'vista_previa', canal: 'vista_previa', reclamo: '', resultado: motivo, vistaPrevia: preview } };
  }
  function reintentar(cfg, row, nowMs, motivo) {
    const intentos = (Number(row.intentos) || 0) + 1;
    const max = cfg.notificaciones.maxIntentos || 3;
    if (intentos >= max) return { accion: 'guardar', update: { estado: 'fallido', intentos, reclamo: '', resultado: motivo } };
    return { accion: 'guardar', update: { estado: 'pendiente', intentos, reclamo: '', resultado: motivo, programadaPara: nowMs + intentos * 5 * MIN } };
  }
  function emailResult(cfg, row, gmailOutput, nowMs) {
    const id = gmailOutput && (gmailOutput.id || gmailOutput.messageId);
    if (id) return { estado: 'enviado', canal: 'email', reclamo: '', resultado: 'gmail:' + String(id).slice(0, 40) };
    return reintentar(cfg, row, nowMs, gmailOutput && gmailOutput.error ? 'gmail_error' : 'gmail_sin_confirmacion').update;
  }

  /* ------------------------------------------------------------------ límites de uso */
  /**
   * IP del cliente según X-Forwarded-For contando "saltos" desde la derecha (lo agrega el proxy de confianza).
   * El valor de la izquierda lo controla el cliente, por eso no se usa. Debe verificarse en la instancia real.
   */
  function clientIp(headers, saltos) {
    const h = headers || {};
    const parts = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const n = Math.max(1, Number(saltos) || 1);
    return parts.length ? parts[Math.max(0, parts.length - n)] : (String(h['x-real-ip'] || '') || 'desconocida');
  }
  /** Ventana fija en memoria persistente del workflow (best effort: ver README). Muta store. */
  function rateLimit(store, scope, key, limit, windowMs, nowMs) {
    if (!store.rl || typeof store.rl !== 'object') store.rl = {};
    const k = scope + ':' + sha256Hex('ip|' + key).slice(0, 16);
    const cur = store.rl[k];
    if (!cur || cur.reset <= nowMs) store.rl[k] = { n: 1, reset: nowMs + windowMs };
    else cur.n += 1;
    const keys = Object.keys(store.rl);
    if (keys.length > 2000) for (const kk of keys) if (store.rl[kk].reset <= nowMs) delete store.rl[kk];
    return store.rl[k].n <= limit;
  }

  /* ------------------------------------------------------------------ respuestas públicas */
  function bookingSummary(cfg, row) {
    const zone = tz(cfg);
    const dt = DateTime.fromISO(row.inicio, { zone }).setLocale('es');
    const svc = findSvc(cfg, row.servicio) || {}, prof = findProf(cfg, row.profesional) || {};
    return {
      reserva: row.reserva, estado: row.estado, servicio: svc.nombre || row.servicio, profesional: prof.nombre || '',
      inicio: row.inicio, fecha: dt.toFormat('yyyy-MM-dd'), fechaLarga: dt.toFormat("cccc d 'de' LLLL"), hora: dt.toFormat('HH:mm'),
      servicioId: row.servicio, profesionalId: row.profesional,
      entornoDePruebas: cfg.entorno.modo !== 'produccion',
      avisos: cfg.notificaciones.enviosExternosHabilitados ? 'segun_configuracion' : 'demostrativos_no_enviados',
    };
  }
  function changeDeadlineOk(cfg, row, nowMs) {
    const h = (cfg.reglas && cfg.reglas.cambiosHastaHorasAntes) || 0;
    return Date.parse(row.inicio) - nowMs >= h * 60 * MIN;
  }

  return {
    sha256Hex, safeEqualHex, validateConfig, productionGate, publicCatalog,
    workingDay, busyFromEvents, slotsForDay, checkSlot, computeAvailability,
    validateAvailabilityQuery, validateBooking, validateManage, verifyToken, eventIdFor, tokenHash,
    normalizePhone, normalizeName, normalizeEmail,
    listUrl, eventUrl, calendarUrl, httpResult, busyFromListResult, buildEvent, eventStartMs,
    bookingRow, notificationRows, reminderRows, decideNotification, emailResult, renderMessage,
    clientIp, rateLimit, bookingSummary, changeDeadlineOk, fail, MENSAJES,
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createSienaCore };
