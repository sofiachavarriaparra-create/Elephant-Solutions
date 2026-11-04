#!/usr/bin/env node
// Revisa que la entrega no contenga secretos ni datos personales y que quede en modo seguro.
// Uso: node scripts/check-secrets.mjs   (sale con código 1 si encuentra algo)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (['node_modules', '.git'].includes(f)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|json|html|md|txt|env|yml|yaml)$/.test(f)) files.push(p);
  }
})(ROOT);

const problems = [];
const SECRET = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, 'client secret de Google'],
  [/AIza[0-9A-Za-z_-]{35}/, 'API key de Google'],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, 'access token de Google'],
  [/\b1\/\/0[0-9A-Za-z_-]{20,}/, 'refresh token de Google'],
  [/\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, 'token de GitHub'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/"(access_token|refresh_token|client_secret|clientSecret|apiKey|api_key|password|n8nApiKey)"\s*:\s*"(?!mock|token-del-mock)[^"]{6,}"/i, 'campo secreto con valor'],
  [/oauthTokenData/, 'datos OAuth'],
];
const EMAIL_OK = /@(example\.(com|org)|mock\.local|group\.calendar\.google\.com|anthropic\.com)$/i;
const PHONE_OK = new Set(['+56945821631', '56945821631', '+56912345678', '+56911112222', '+56987654321', '+56912123434', '+56988887777']); // WhatsApp público de Siena + números de prueba
for (const f of files) {
  const rel = relative(ROOT, f);
  const txt = readFileSync(f, 'utf8');
  for (const [re, what] of SECRET) {
    if ((rel.startsWith('tests/') || rel === 'scripts/check-secrets.mjs') && what === 'datos OAuth') continue; // credencial FALSA del mock, solo en la prueba local
    if (re.test(txt)) problems.push(`${rel}: posible ${what}`);
  }
  for (const m of txt.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!EMAIL_OK.test(m[0]) && !/^(noreply|git)@/.test(m[0]) && !/\.(png|jpg|svg)$/.test(m[0])) problems.push(`${rel}: email no autorizado ${m[0]}`);
  }
  for (const m of txt.matchAll(/\+?56\s?9[\s.-]?\d{4}[\s.-]?\d{4}/g)) {
    const n = m[0].replace(/[\s.-]/g, '');
    if (!PHONE_OK.has(n) && !PHONE_OK.has('+' + n.replace(/^\+/, ''))) problems.push(`${rel}: teléfono no autorizado ${m[0]}`);
  }
}

// Modo seguro de la entrega
const wfDir = join(ROOT, 'n8n', 'workflows');
for (const f of readdirSync(wfDir).filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(join(wfDir, f), 'utf8'));
  if (j.active !== false) problems.push(`${f}: el workflow no está inactivo`);
  if (j.id) problems.push(`${f}: trae id (podría sobrescribir un workflow existente al importar)`);
  for (const n of j.nodes) {
    for (const c of Object.values(n.credentials || {})) if (c.id) problems.push(`${f} › ${n.name}: credencial con id fijo`);
    if (n.type === 'n8n-nodes-base.gmail' && n.disabled !== true) problems.push(`${f} › ${n.name}: nodo Gmail activo`);
    if (/whatsapp/i.test(n.type)) problems.push(`${f} › ${n.name}: nodo de WhatsApp`);
  }
}
const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'siena.config.example.json'), 'utf8'));
if (cfg.notificaciones.enviosExternosHabilitados !== false) problems.push('config: envíos externos encendidos');
if (cfg.notificaciones.whatsapp.habilitado !== false) problems.push('config: WhatsApp encendido');
if (cfg.produccion.habilitada !== false) problems.push('config: producción habilitada');
const web = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
if (!web.includes('Entorno de pruebas: no genera reservas reales en Siena')) problems.push('web: falta el aviso de pruebas');
if (/Bearer|client_secret|googleapis\.com\/calendar/i.test(web)) problems.push('web: referencia a credenciales o a Google desde el navegador');

if (problems.length) { console.error('✘ Problemas encontrados:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✔ ${files.length} archivos revisados: sin secretos, sin datos personales no autorizados; workflows inactivos, Gmail desactivado, WhatsApp apagado, producción bloqueada.`);
