// PRUEBA E2E EN NAVEGADOR (Chromium/Playwright) de web/index.html contra la n8n local + MOCK.
// Requiere que corra: node tests/integracion/run-local-n8n.mjs --n8n=... --solo-servidor
// y un servidor estático en la raíz del repo: python3 -m http.server 8000
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const OUT = process.argv[2] || '.';
const PAGE = 'http://localhost:8000/siena-reservas/web/';
const API = 'http://127.0.0.1:5678/webhook';
const MOCK = 'http://127.0.0.1:8787';
const res = []; const ok = (n, c, d = '') => { res.push({ n, ok: !!c, d }); console.log(`  ${c ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };
const mock = (p, b) => fetch(MOCK + p, b ? { method: 'POST', body: JSON.stringify(b) } : {}).then((r) => r.json());
const eventos = async () => ((await mock('/__mock/estado')).eventos['cal-prueba-1@mock.local'] || []).filter((e) => e.status !== 'cancelled');

const browser = await chromium.launch();
// El webhook tiene "ignorar bots": el User-Agent HeadlessChrome se rechaza (403). Se usa uno de Chrome normal.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function flow(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, userAgent: UA, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(fonts|onlinewebfonts|jsdelivr|google)/.test(m.text()) && !/net::ERR/.test(m.text()) && !/status of (409|503)/.test(m.text())) errores.push(m.text()); }); // 409/503 se provocan a propósito
  await page.goto(`${PAGE}?api=${encodeURIComponent(API)}#agenda`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  ok(`[${tag}] aviso de pruebas visible`, await page.locator('.test-banner').isVisible() && (await page.locator('#agEnvText').innerText()).includes('Entorno de pruebas: no genera reservas reales en Siena'));
  await page.locator('#agSvc button', { hasText: 'Servicio de prueba A' }).click();
  await page.locator('#agProf button', { hasText: 'Profesional de prueba 1' }).click();
  await page.waitForSelector('#agTimes button', { timeout: 15000 });
  const dias = await page.locator('#agDays button').count();
  ok(`[${tag}] días y horarios cargados desde n8n`, dias >= 7, `${dias} días`);
  // Un día con margen (la gestión exige 3 h de anticipación): el 3.º día con horas libres
  await page.locator('#agDays button:not(.is-empty)').nth(tag === 'móvil' ? 4 : 2).click();
  await page.waitForSelector('#agTimes button');
  // Conflicto: otra persona toma la hora elegida justo antes de enviar
  const first = page.locator('#agTimes button').first();
  const hora = await first.innerText();
  await first.click();
  await page.fill('#agName', 'Ana Navegador'); await page.fill('#agPhone', '+56 9 8765 4321'); await page.check('#agConsent');
  const inicio = await page.evaluate(() => { const b = [...document.querySelectorAll('#agTimes button')].find((x) => x.getAttribute('aria-pressed') === 'true'); return b && b.textContent; });
  return { ctx, page, errores, hora, inicio };
}

const D = await flow({ width: 1366, height: 900 }, 'escritorio');
// otra reserva para la misma hora, directo al backend
const dia = await D.page.locator('#agDays button[aria-pressed="true"]').getAttribute('aria-label');
const slot = { inicio: await D.page.locator('#agTimes button[aria-pressed="true"]').getAttribute('data-inicio') };
await fetch(`${API}/siena-pruebas/reservar`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ servicioId: 'srv-prueba-a', profesionalId: 'prof-prueba-1', inicio: slot.inicio, nombre: 'Otra Persona', telefono: '+56 9 1212 3434', email: '', consentimiento: true, claveIdempotencia: crypto.randomUUID(), claveGestion: 'f'.repeat(64) }) });
await D.page.click('#agSubmit');
await D.page.waitForSelector('#agMsg .ag-alert', { timeout: 20000 });
ok('[escritorio] hora tomada por otra persona → aviso de conflicto, sin confirmación', (await D.page.locator('#agMsg').innerText()).includes('ocupar') && await D.page.locator('#agDone').isHidden(), `${D.hora} (${dia})`);
await D.page.waitForSelector('#agTimes button', { timeout: 15000 });
const inicios = await D.page.locator('#agTimes button').evaluateAll((bs) => bs.map((b) => b.dataset.inicio));
ok('[escritorio] horarios recargados y la hora tomada ya no aparece', !inicios.includes(slot.inicio), `${inicios.length} horas libres`);
// Error recuperable: Google falla en todos los intentos → error con "Reintentar"; luego se recupera
await mock('/__mock/fallas', [{ metodo: 'POST', contiene: '/events', modo: 'status', status: 503, veces: 5 }]);
await D.page.locator('#agTimes button').first().click();
await D.page.click('#agSubmit');
await D.page.waitForFunction(() => /Reintentando/.test(document.querySelector('#agSubmitText').textContent), null, { timeout: 15000 });
ok('[escritorio] muestra "Reintentando…" mientras repite con la misma clave', true);
await D.page.waitForSelector('#agMsg .ag-alert--error button', { timeout: 30000 });
ok('[escritorio] tras fallar Google: error recuperable, sin confirmación', (await D.page.locator('#agMsg').innerText()).includes('Todavía no está reservada') && await D.page.locator('#agDone').isHidden());
await D.page.screenshot({ path: `${OUT}/e2e-error-recuperable.png` });
const antes = (await eventos()).length;
await D.page.click('#agMsg .ag-alert--error button');
await D.page.waitForSelector('#agDone:not([hidden])', { timeout: 30000 });
const despues = (await eventos()).length;
ok('[escritorio] "Reintentar" confirma solo cuando existe el evento (uno)', despues === antes + 1, `eventos ${antes}→${despues}`);
ok('[escritorio] confirmación indica que los avisos son demostrativos', (await D.page.locator('#agDoneNote').innerText()).includes('demostrativos'));
await D.page.screenshot({ path: `${OUT}/e2e-confirmacion-escritorio.png` });
const link = await D.page.locator('#agLink').inputValue();
ok('[escritorio] enlace de gestión con token en el fragmento (#)', /#gestionar=r[a-f0-9]{23}\.[a-f0-9]{64}$/.test(link));
// Gestión por enlace: abrir, ver, cancelar
const M = await D.ctx.newPage();
await M.goto(link);
await M.waitForFunction(() => /Código r/.test(document.querySelector('#agMgText').textContent), null, { timeout: 15000 });
ok('[gestión] la clave desaparece de la barra de direcciones', !M.url().includes('gestionar='));
await M.click('#agMgCancel'); await M.click('#agMgCancelYes');
await M.waitForFunction(() => /Cancelada/.test(document.querySelector('#agMgText').textContent), null, { timeout: 20000 });
ok('[gestión] cancelación confirmada por el servidor', true);
await M.screenshot({ path: `${OUT}/e2e-gestion-cancelada.png` });
const bad = await D.ctx.newPage();
await bad.goto(link.replace(/[a-f0-9]{4}$/, '0000'));
await bad.waitForFunction(() => /no es válido/.test(document.querySelector('#agMgText').textContent), null, { timeout: 15000 });
ok('[gestión] enlace alterado → "no es válido"', true);
ok('[escritorio] sin errores de JavaScript', D.errores.length === 0, D.errores.join(' | '));

// Móvil: diseño sin desbordes y flujo completo
const Mo = await flow({ width: 390, height: 844 }, 'móvil');
await Mo.page.click('#agSubmit');
await Mo.page.waitForSelector('#agDone:not([hidden])', { timeout: 30000 });
const overflow = await Mo.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('[móvil] reserva confirmada y sin desplazamiento horizontal', overflow <= 0, `desborde ${overflow}px`);
await Mo.page.screenshot({ path: `${OUT}/e2e-confirmacion-movil.png`, fullPage: false });
ok('[móvil] sin errores de JavaScript', Mo.errores.length === 0, Mo.errores.join(' | '));

// Sin backend: simulación local claramente marcada
const S = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA })).newPage();
await S.goto(PAGE + '#agenda'); await S.waitForSelector('#agSvc button', { timeout: 10000 });
ok('[sin backend] la agenda se presenta como simulación local', (await S.locator('#agEnvText').innerText()).includes('simulación local'));
await S.screenshot({ path: `${OUT}/e2e-agenda-escritorio.png` });
await browser.close();
const pass = res.filter((r) => r.ok).length;
console.log(`\n== E2E navegador: ${pass}/${res.length} OK ==`);
writeFileSync(new URL('./ultimo-resultado-e2e.json', import.meta.url), JSON.stringify({ fecha: new Date().toISOString(), entorno: 'Chromium + n8n local + MOCK', resultados: res }, null, 2) + '\n');
process.exit(pass === res.length ? 0 : 1);
