# Siena · Reservas — MVP de PRUEBAS

Web → n8n → Google Calendar → avisos. **Entorno de pruebas: no genera reservas reales en Siena.**
Servicios, profesionales, horarios, calendarios y destinatarios de este paquete son **DATOS DE PRUEBA** ficticios.

- La maqueta pública (`/siena`) **no se modificó**. La versión con agenda conectada está en `siena-reservas/web/`.
- Los workflows se entregan **inactivos (sin publicar)**, con el nodo de Gmail **desactivado**, los envíos externos **apagados**, WhatsApp **deshabilitado** y el modo producción **bloqueado**.
- Resultado de lo ejecutado y lo que falta verificar: [INFORME.md](INFORME.md). Datos que debe entregar Siena: [PENDIENTES-SIENA.md](PENDIENTES-SIENA.md).

## Contenido

```
config/siena.config.example.json   Configuración central de ejemplo (sin secretos)
core/siena-core.js                 Lógica pura: horarios, reglas, validación, hashes, avisos (probada en tests/unit)
n8n/workflows/*.json               Workflows importables, uno por función (generados, inactivos)
n8n/sdk/*.js                       Los mismos workflows en formato Workflow SDK (para el MCP de n8n)
scripts/build-workflows.mjs        Genera n8n/workflows desde core/ + config/
scripts/build-sdk.mjs              Genera n8n/sdk desde n8n/workflows
scripts/check-secrets.mjs          Verifica: sin secretos ni datos personales, modo seguro
web/index.html                     Maqueta con agenda conectada, estados y gestión por enlace
tests/unit/                        Pruebas unitarias del núcleo (17)
tests/mock/                        MOCK de Google Calendar con inyección de fallas (no es Google)
tests/integracion/                 n8n local real + MOCK (26 escenarios) y E2E en navegador (18)
```

## Arquitectura

| Workflow | Disparador | Función |
|---|---|---|
| 00 Preparar tablas | Manual | Crea las 3 Data tables y un candado por profesional (idempotente) |
| 01 Disponibilidad | `POST /webhook/siena-pruebas/disponibilidad` | Catálogo público y horarios libres (sin datos de terceros) |
| 02 Reservar | `POST /webhook/siena-pruebas/reservar` | Valida, toma el candado, revalida, crea el evento, registra la reserva y sus avisos |
| 03 Gestionar cita | `POST /webhook/siena-pruebas/gestionar` | Consultar, cancelar y reagendar con enlace + token |
| 04 Avisos y recordatorios | Cada 5 min + manual | Reclama avisos vencidos, consulta el estado vigente y genera vista previa (o email si se habilita) |

Los nodos **Code** solo calculan (el sandbox de n8n no tiene red); las llamadas a Google van por nodos **HTTP Request** con la credencial OAuth2 de n8n, y el estado vive en **Data tables** de n8n. Cada nodo Code lleva incrustado el núcleo (`core/`) y la configuración: no se editan a mano, se regeneran.

### Reserva paso a paso (02)

1. **Validación en el servidor**: tipos, largo, teléfono chileno, email opcional, consentimiento, campo trampa, tamaño máximo, límite por IP. El navegador **no** decide duraciones: el servidor toma la duración del servicio desde la configuración y comprueba que la hora pertenezca a la grilla, a la jornada, que no cruce un descanso, que respete anticipación mínima y horizonte.
2. **Idempotencia**: el navegador envía `claveIdempotencia` (UUID) y `claveGestion` (64 hex, `crypto.getRandomValues`). `reserva = "r" + sha256(clave)[0..23]`; el id del evento se deriva de la reserva. Mismo envío → misma reserva; misma clave con otros datos → `409 clave_reutilizada`.
3. **Candado persistente por profesional**: `UPDATE candados SET titular, bloqueadoHasta WHERE recurso = X AND bloqueadoHasta < ahora`, y luego se relee la fila: solo continúa quien quedó como titular. Es un *compare-and-swap* sobre la base de datos de n8n (verificado en el código fuente de n8n 2.46.6: un único `UPDATE … WHERE`). El candado tiene una duración de 60 s; la ejecución del workflow tiene tope de 40 s y antes de crear el evento se comprueba que queden al menos 20 s de candado.
4. **Revalidación con candado**: se vuelve a leer la ocupación en Google (solo `id,status,start,end,transparency`) y se aplican todas las reglas otra vez.
5. **Recuperación de respuestas perdidas**: antes de crear, se busca el evento por su id. Si ya existe y es de esta reserva, se adopta (no se crea otro).
6. Se registra la reserva como `creando`, se crea el evento (`sendUpdates=none`, sin invitados), se crean los avisos y se marca `confirmada`. **Solo entonces** se responde `201`.
7. Se libera el candado y se responde. Errores de Google o tiempos de espera → `503 reintentable`, la reserva queda `error_calendario` y el reintento con la misma clave la completa.

**No es una operación atómica entre la consulta y la creación en Google.** Lo que garantiza que dos reservas no ocupen el mismo intervalo es que *todas* las escrituras del sistema para una profesional pasan por su candado. Un evento que alguien agregue **a mano** en Google entre la revalidación y la creación (≈1 s) puede quedar superpuesto: el sistema no puede bloquear ediciones manuales.

> ¿Por qué no usar el id del evento de Google como candado? El documento oficial de la API dice: *"we cannot guarantee that ID collisions will be detected at event creation time"*. Por eso el id determinista solo sirve para recuperar respuestas perdidas, no para excluir concurrencia.

### Estados

- Reserva: `creando` → `confirmada` → `cancelada`; `error_calendario` (recuperable, se completa con el reintento).
- Aviso: `pendiente` → `procesando` (reclamo atómico) → `vista_previa` | `enviado` | `fallido` | `omitido_cancelada` | `omitido_horario_cambiado` | `omitido_reagendada` | `omitido_vencido`. Un reclamo que quede colgado más de 10 min vuelve a `pendiente`.

### Cancelación, reagendamiento y recordatorios

- El enlace de gestión es `…/web/#gestionar=<reserva>.<clave>`. El fragmento `#` no se envía a ningún servidor; la página lo lee y lo borra de la barra. El servidor guarda solo `sha256("gestion|" + clave)` y compara en tiempo constante. Token inválido, reserva ajena e inexistente responden **idéntico** (`404 enlace_invalido`).
- Reagendar: primero se valida el nuevo horario con candado y ocupación vigente; si Google falla al mover, **la cita original queda intacta** (`503`, "tu hora original se mantiene"). Si funciona, se actualiza la reserva, se omiten los recordatorios viejos y se crean los nuevos.
- Antes de cada aviso se consulta el evento **vigente** en Google: si la cita se canceló (aunque sea a mano en el calendario) se omite; si cambió de hora, se omite el recordatorio viejo y se crea uno para la hora nueva.
- Si falla un aviso, **la reserva no se toca**: el aviso se reintenta (hasta 3 veces, con espera creciente) sin crear otra cita.

## Configuración

Copia `config/siena.config.example.json` a `config/siena.config.json` (no se sube al repositorio) y ajusta:

| Clave | Para qué |
|---|---|
| `entorno.modo` | `demo` (solo navegador) · `pruebas` · `produccion` (bloqueado hasta cumplir `produccion.requisitos`) |
| `entorno.zonaHoraria` | `America/Santiago` |
| `profesionales[].calendarId` | Calendario de Google **de pruebas** de cada profesional |
| `servicios[]` | Duración (min) y profesionales habilitados |
| `horario.semana / descansos / excepciones` | Jornadas, descansos, feriados y días especiales (por profesional con `horario` propio) |
| `reglas` | Grilla de inicio, tiempo entre citas, anticipación mínima, horizonte, plazo para cambios, máximo por teléfono |
| `candado` | Duración del candado y margen mínimo |
| `limites` | Límites por IP, tamaño máximo y `saltosProxy` |
| `backend` | URL base y rutas de los webhooks, orígenes permitidos (CORS) |
| `notificaciones` | Envíos externos (apagados), email con lista de destinatarios autorizados, WhatsApp (deshabilitado) |
| `web.urlGestion` | Página donde se abre el enlace de gestión |

Luego:

```bash
cd siena-reservas
```

```bash
npm install
```

```bash
npm run build
```

```bash
npm run test:secretos
```

En la web, edita el bloque `window.SIENA_RESERVAS` de `web/index.html`: con `api: ""` la agenda funciona como **simulación local** (rotulada así); con la URL del backend (`https://TU-INSTANCIA.app.n8n.cloud/webhook`) usa los workflows. No hay ninguna clave en el navegador.

## Importar en n8n

1. **Tablas.** En la instancia de Elephant ya existen, creadas en esta sesión dentro del proyecto personal: `siena_pruebas_reservas`, `siena_pruebas_avisos`, `siena_pruebas_candados` (con un candado por profesional de prueba). En otra instancia, importa y ejecuta a mano `00-preparar-tablas.json` (es idempotente).
2. **Workflows.** Crea un workflow nuevo → menú ⋯ → *Import from File* (o *Import from URL* con el enlace "raw" de GitHub) → uno por cada archivo de `n8n/workflows/`. Quedan sin publicar. No se reutiliza ni sobrescribe ningún workflow existente (los JSON no traen `id`).
3. **Credenciales** (n8n → Credentials; nunca en archivos):
   - **Google Calendar OAuth2 API**, nombre `Google Calendar PRUEBAS Siena`, de una cuenta de Google que **solo** tenga acceso a los calendarios de prueba. En cada nodo HTTP Request "(Google Calendar)" selecciona esa credencial.
   - **Gmail OAuth2** (opcional), nombre `Gmail PRUEBAS Siena`, de una cuenta autorizada para pruebas. El nodo de Gmail queda desactivado hasta que se decida usarlo.
4. Revisa en cada workflow → *Settings*: zona horaria `America/Santiago`, **Save successful production executions: No** (ya viene así) y el tiempo máximo de ejecución.

## Activar para pruebas (solo con calendarios de prueba)

1. Cambia `calendarId` en la config por los calendarios de prueba, `backend.origenesPermitidos` por el dominio de la web de pruebas, y regenera con `npm run build`. Reimporta.
2. Publica 01, 02 y 03, y opcionalmente 04. Las URLs de producción quedan en `https://<instancia>/webhook/siena-pruebas/...`.
3. Pon esa URL base en `web/index.html` → `window.SIENA_RESERVAS.api`.
4. Haz la prueba de integración real (pendiente, ver INFORME): reserva, doble reserva simultánea, cancelación y reagendamiento contra el calendario de prueba.

Para encender el email: `notificaciones.enviosExternosHabilitados = true`, `email.habilitado = true`, destinatarios en `email.destinatariosAutorizados`, credencial asignada y nodo Gmail activado. **WhatsApp no tiene camino de envío**: requiere WhatsApp Business Platform (API oficial de Meta), consentimiento y plantillas aprobadas. No se usa WhatsApp Web ni sesiones no oficiales.

## Reversión

- **Backend**: despublica 01–04 (menú del workflow → *Unpublish*) y, si se quiere, archívalos. Despublicar desactiva los webhooks de inmediato.
- **Datos de prueba**: borra las filas o las tablas `siena_pruebas_*` (Data tables). Los eventos de prueba se borran del calendario de prueba.
- **Web**: `api: ""` vuelve a la simulación local; la maqueta pública `/siena` nunca se modificó y esta rama no se fusionó.
- **Cloud (esta sesión)**: carpeta `Siena PRUEBAS · Reservas` con tres workflows de prueba sin publicar (97 email, 98 entorno, 99 candado), y las tablas `siena_pruebas_*` (incluida `siena_pruebas_sonda_resultados`). Se pueden archivar o borrar sin afectar nada más.

## Protecciones del webhook público

Un webhook de n8n es público por diseño. Lo que lo protege:

- **Validación estricta en el servidor** (tipos, largos, formatos, tamaño ≤ 4 KB, servicio y profesional existentes, reglas de agenda) y mensajes de error genéricos, sin detalles internos.
- **Idempotencia y candado**: repetir o lanzar en paralelo no duplica citas.
- **Límite de uso por IP** (disponibilidad 30/min, reservas 6/10 min, gestión 20/10 min). Es *best effort*: vive en los datos estáticos del workflow, que n8n solo guarda en ejecuciones de producción, y las ejecuciones simultáneas pueden pisarse. La IP sale de `X-Forwarded-For` contando `saltosProxy` desde la derecha: **hay que verificar** cuántos proxies pone n8n Cloud.
- **Campo trampa** contra bots simples e *ignore bots* del Webhook (filtra por User-Agent; se evade fácil).
- **No implementado aún**: el tope `reglas.maxReservasActivasPorTelefono` existe en la configuración y la tabla guarda `telefonoHash`, pero ningún workflow lo aplica todavía.
- **Token de gestión** de 256 bits, guardado como hash, comparado en tiempo constante, con respuestas idénticas ante token inválido.
- **CORS** restringido a los orígenes de la web. **No es una protección**: solo afecta a navegadores; un script puede llamar igual.
- **No hay clave en el frontend**: cualquier clave en JavaScript sería pública. Para producción se recomienda un desafío anti-bots en el servidor (p. ej. Cloudflare Turnstile verificado en n8n) o un proxy con límites reales; queda pendiente porque implica contratar o configurar un servicio.

## Privacidad

- La disponibilidad devuelve solo `inicio` y `hora` de los horarios libres: nunca títulos, nombres, teléfonos ni detalles de eventos.
- Las respuestas públicas no repiten datos personales (la prueba revisa más de 100 respuestas).
- Nombre, WhatsApp y email quedan solo en el evento del calendario de la profesional (descripción y propiedades privadas). Las tablas guardan hashes (`tokenHash`, `telefonoHash`, `huella`), no datos de contacto.
- Las vistas previas de avisos enmascaran el nombre (`P•••`).
- Ejecuciones exitosas no se guardan; las fallidas sí (para diagnosticar) y pueden contener datos: define una retención corta en n8n.

## Pruebas

```bash
npm test
```

```bash
npm run test:secretos
```

```bash
node tests/integracion/run-local-n8n.mjs --n8n=/ruta/node_modules/n8n/bin/n8n
```

La integración necesita n8n 2.46.x instalado localmente (Node ≥ 24). Levanta una n8n temporal con SQLite, importa una **variante de prueba** de los workflows que apunta al MOCK, los publica solo en esa instancia temporal y ejecuta 26 escenarios. Con `--solo-servidor` deja todo corriendo para la E2E:

```bash
python3 -m http.server 8000
```

```bash
node tests/integracion/e2e-navegador.mjs ./capturas
```

`--sin-candado --solo=simultáneas` corre el **control negativo** (candado anulado), que debe fallar.
