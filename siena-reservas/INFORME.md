# Informe · MVP de pruebas de reservas Siena

Fecha: 4 de noviembre de 2026. Rama `claude/pensive-faraday-u55hr6`. La maqueta pública (`/siena`) no se modificó y nada se publicó.

## 1. Qué se implementó

- **Configuración central** con datos de prueba ficticios (2 profesionales, 3 servicios de 30/60/90 min, jornada con colación, sábado corto, feriado y día especial, reglas, candado, límites, avisos) y sin secretos.
- **Núcleo de lógica** (`core/siena-core.js`): horarios con zona `America/Santiago`, descansos, grilla, tiempo entre citas, anticipación y horizonte; validación de entradas; identificadores e idempotencia; hash del token de gestión; decisión de avisos según el estado vigente; límites por IP.
- **5 workflows de n8n** (00 tablas, 01 disponibilidad, 02 reservar, 03 gestionar, 04 avisos), inactivos, con Gmail desactivado y WhatsApp sin camino de envío.
- **Control de concurrencia persistente** por profesional: candado con actualización condicional en una Data table de n8n, más revalidación y cerca de tiempo.
- **Frontend** (`web/index.html`): mismo diseño, catálogo y horarios desde el backend, estados de carga, sin horas, conflicto, error recuperable con reintento idempotente y confirmación solo con respuesta del servidor; aviso visible "Entorno de pruebas: no genera reservas reales en Siena"; gestión por enlace (consultar, cancelar, cambiar hora); asistente que lleva a la agenda; simulación local rotulada cuando no hay backend.
- **Pruebas**: unitarias, MOCK de Google Calendar con fallas inyectables, integración con n8n real local, E2E en navegador, control negativo y revisión de secretos.

## 2. Qué se ejecutó y qué pasó

| Prueba | Entorno | Resultado |
|---|---|---|
| Unitarias del núcleo | Node 22 + Luxon 3.7.2 | **17/17** |
| Integración: 26 escenarios | n8n 2.46.6 local (SQLite) + **MOCK** de Google | **26/26** |
| E2E en navegador | Chromium + n8n local + MOCK | **18/18** |
| Control negativo (candado anulado) | n8n local + MOCK | Falla como corresponde: 2 simultáneas → **2 eventos**; 8 simultáneas → **6 eventos** |
| Revisión de secretos y modo seguro | Repositorio | Sin hallazgos |
| Sonda de candado | **n8n Cloud** | 1 de 6 obtuvo el candado; las demás lo rechazaron |
| Sonda de entorno | **n8n Cloud** | Todo OK: Luxon, cambio de hora de Santiago, formato en español, TextEncoder, regex Unicode |
| Contrato con **Google Calendar real** (calendario secundario "Siena pruebas") | **n8n Cloud** | 11/11: crear con id propio, id repetido → 409, listar con campos mínimos, leer, mover, borrar → 204, leer borrado → `cancelled`, borrar otra vez → 410. Idéntico al MOCK |
| Envío de email real | **n8n Cloud + Gmail** | 1 correo [PRUEBA] a la casilla de Elephant (autorizada): Gmail devolvió id → `enviado` |

Los 26 escenarios de integración cubren las pruebas pedidas:
- **Reservas válidas**: reserva válida con un único evento y avisos creados; profesional "cualquiera".
- **Reglas de agenda**: horario ocupado por un evento existente y por otra reserva (incluido el tiempo entre citas), hora pasada, fuera de jornada, domingo y servicio que atraviesa el descanso.
- **Entradas inválidas**: entrada inválida y campo trampa.
- **Concurrencia e idempotencia**: 2 y 8 solicitudes simultáneas (siempre 1 reserva), doble clic y reintento con la misma clave, y misma clave con otros datos.
- **Fallas de Google**: falla al crear (sin evento, y el reintento crea uno), respuesta perdida (aplica y corta la conexión; el reintento adopta el mismo evento), tiempo de espera, candado ocupado y candado vencido.
- **Gestión y avisos**: consultar y cancelar, token inválido, reserva ajena e inexistente (las tres responden igual), cancelar dos veces, reagendar con falla de Google conservando la original, reagendar a una hora ocupada, reagendar con éxito, vista previa de avisos, aviso fallido sin duplicar la reserva (pendiente → pendiente → fallido), recordatorio omitido por cancelación o por cambio hecho a mano en el calendario.
- **Protecciones y privacidad**: límite por IP, CORS, ausencia de secretos y datos personales en más de 100 respuestas, y candados liberados al final.

El cambio de hora de America/Santiago (septiembre de 2026 y abril de 2027) se probó en las unitarias y en la sonda de Cloud. No se probó en integración porque esas fechas caen fuera del horizonte de 30 días.

Problemas encontrados y corregidos en el camino:
- El filtro "ignorar bots" de n8n rechaza los User-Agent de Node y de Chromium sin interfaz. En las pruebas se usa uno de navegador; a los usuarios reales no les afecta.
- Un nodo Code sin preludio usaba `NOW`.
- El comando `execute` de n8n no carga las Data tables, así que la prueba local prepara las tablas con un webhook que solo existe en la variante de prueba.
- Fechas de prueba que coincidían en el mismo día.

## 3. Qué es verificado, qué es simulado y qué falta

**Verificado (real)**
- Los workflows importan, se publican y corren en n8n 2.46.6 real, con nodos y Data tables reales.
- El candado impide dobles reservas con solicitudes realmente simultáneas sobre SQLite, y el control negativo muestra que sin él se duplican.
- El *compare-and-swap* de Data tables funciona sobre la base de datos de n8n Cloud. Las ejecuciones fueron secuenciales.
- El sandbox de Cloud ofrece todo lo que usa el núcleo.

**Probado solo con proveedores simulados (MOCK)**
- Toda la interacción con Google Calendar: listar, crear con id propio, leer, mover, borrar, errores 5xx, tiempos de espera y respuestas perdidas. El MOCK imita las reglas del documento de descubrimiento oficial (revisión 20261030), pero **no es Google**.
- La ruta de email dentro del flujo completo: en la integración local el nodo Gmail estaba desactivado, así que se probó que la falla se registra y se reintenta sin tocar la reserva.

**Verificado con Gmail real (aparte)**: el workflow de prueba `97 Prueba de email` en Cloud usa el mismo nodo Gmail v2.1 con la credencial Gmail de Elephant, y envió **un** correo [PRUEBA] a la propia casilla de Elephant. Gmail devolvió un id de mensaje, que es justo lo que el sistema exige para marcar un aviso como `enviado`. En la entrega, el nodo Gmail sigue desactivado y los envíos externos apagados.

**No verificado / pendiente de credenciales o datos**
- **Flujo completo con Google Calendar real**: las operaciones de Google que usa el sistema ya se verificaron contra el calendario de pruebas (prueba de contrato 11/11), pero los workflows 01–03 aún no se ejecutaron completos contra él.
- **Concurrencia real en Cloud** con webhooks publicados (la sonda corrió en serie).
- **Workflows 00–04 en Cloud**: no los creé por la API. Cada uno lleva ~28 000 caracteres de código generado y transcribirlos arriesga una copia distinta a la probada sin poder comprobarlo. Se importan desde `n8n/workflows/*.json` (2 minutos, ver README). Sí creé en Cloud las tablas con sus candados y las dos sondas.
- **WhatsApp** (no existe camino de envío) y la cantidad de proxies de n8n Cloud en `X-Forwarded-For` (afecta el límite por IP).
- **Tope de reservas activas por teléfono**: configurado, pero no implementado.

## 4. Qué bloquea producción

El modo `produccion` está bloqueado en el código (`503 produccion_bloqueada`) hasta que `produccion.habilitada` y todos los `requisitos` sean `true`. Falta:

1. Prueba de integración con **Google Calendar real** (calendario de prueba): reserva, doble reserva simultánea con los webhooks publicados en Cloud, cancelación, reagendamiento y recordatorios.
2. Calendarios reales confirmados por Siena y sus datos operativos (ver PENDIENTES-SIENA.md).
3. Protección anti-abuso real delante del webhook (desafío anti-bots verificado en el servidor o proxy con límites). El límite actual por IP es *best effort*.
4. Canal de avisos oficial verificado: email autorizado y, si se quiere WhatsApp, WhatsApp Business Platform con plantillas y consentimiento.
5. Política de privacidad actualizada y retención corta de ejecuciones fallidas en n8n.
6. Riesgo residual conocido: un evento agregado **a mano** en Google en el segundo entre la revalidación y la creación puede superponerse. Si el salón edita la agenda a mano, conviene que las profesionales bloqueen horas con eventos creados con anticipación.
