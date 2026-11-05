# Prompt para Hermes: flujo de prospección en n8n → GoHighLevel

Copia todo lo que está bajo la línea y pégaselo a Hermes.

---

Necesito que construyas hoy, en mi n8n, un flujo de prospección para Elephant Solutions. Abajo tienes el contexto, las reglas, el diseño del flujo, los prompts y cómo probarlo. Si algo de esto no calza con lo que ves en n8n o en GoHighLevel, avísame antes de inventar una solución.

## Contexto

- Elephant Solutions SpA (Santiago, Chile) crea páginas web con asistente de IA, chatbots y automatizaciones para pequeños negocios: laboratorios, clínicas y consultas, centros de estética, servicios técnicos y comercios.
- Mi n8n: https://eeeeeeesofia.app.n8n.cloud
- GoHighLevel (API v2):
  - Base: `https://services.leadconnectorhq.com`, header `Version: 2021-07-28`.
  - Credencial en n8n: "Header Auth account" (id `7XsolxJp8EUSKYYA`), la misma que usa el flujo "GHL - Lead nuevo".
  - locationId: `9HNu59ArYMnkKK0eZfX1`
  - Marketing Pipeline: `7NBJWfcB2Qtyqn91Hf3r`, etapa New Lead: `4d15e678-74f3-4df9-b8fd-ee755e26c20a`
  - Usuario asignado: `ngY4Hz2ChVGcYHDyZHVT`
- Flujos que ya existen y NO debes romper:
  - "GHL - Lead nuevo" (publicado): se dispara con un webhook de GHL cada vez que se crea un contacto. Crea una oportunidad, pone la etiqueta `lead-nuevo`, me avisa por Gmail y le envía al contacto un correo de bienvenida que dice "Gracias por contactar a Elephant Solutions".
  - Los flujos "Comercial · …" y "Siena …": no los toques.

## Reglas

1. El flujo NO envía nada a los prospectos: ni correos ni WhatsApp. Solo crea borradores en Gmail y deja todo listo en GHL para que yo revise y envíe.
2. Crea el flujo nuevo como borrador. No lo publiques sin preguntarme.
3. Primero el candado (paso 0 de abajo), después todo lo demás. Ningún contacto de prospección puede entrar a GHL mientras "GHL - Lead nuevo" pueda mandarle la bienvenida.
4. Nunca pegues API keys en nodos ni en expresiones: usa credenciales de n8n.
5. No inventes IDs de GHL. Si necesitas uno que no está aquí, consúltalo por la API o pregúntame.

## Credenciales que necesito crear (pídemelas si no existen)

- Apify: API token, como credencial Header Auth (`Authorization: Bearer …`), con el nombre "Apify".
- Hunter: credencial Hunter API.
- Gmail OAuth2 de sofiaadmin@elephantsolutions.cl, con el nombre "Gmail sofiaadmin". Si todavía no existe, arma el nodo igual, déjalo sin credencial y avísame.
- OpenAI y Firecrawl: usa los créditos incluidos de n8n.

## Paso 0: candado en "GHL - Lead nuevo" (estás autorizado a hacer este cambio)

Justo después del nodo "Datos del lead", agrega un If "¿Es prospección?". Si el contacto tiene la etiqueta `prospeccion-maps`, o su fuente es "Prospección Google Maps", el flujo termina ahí: no crea oportunidad, no me avisa y no manda bienvenida.

- Revisa en una ejecución real si el webhook trae `tags` y `contact_source`. Si no los trae, agrega antes del If un GET `/contacts/{contactId}` para leer las etiquetas.
- Pruébalo con un contacto falso ("Prueba Hermes", email sofiaadmin@elephantsolutions.cl, etiqueta `prospeccion-maps`). Comprueba en la ejecución que se detuvo en el candado, borra el contacto y vuelve a publicar el flujo.
- Muéstrame el resultado antes de seguir.

## Paso 1 en adelante: el flujo nuevo

Nombre: "Comercial · Prospección Google Maps → GHL".

1. **Inicio:** Manual Trigger + un nodo Set "Parámetros" con `rubro` (ej. "centro de estética"), `ciudad` (ej. "Santiago, Chile") y `cantidad` (por defecto 10, máximo 20).
2. **Apify:** HTTP Request POST `https://api.apify.com/v2/acts/compass~google-maps-extractor/run-sync-get-dataset-items` con el body:
   `{"searchStringsArray":[rubro],"locationQuery":ciudad,"countryCode":"cl","language":"es","maxCrawledPlacesPerSearch":cantidad,"skipClosedPlaces":true}`.
   Devuelve una lista de negocios. Usa `title`, `categoryName`, `address`, `street`, `city`, `neighborhood`, `phone`, `website`, `totalScore` y `reviewsCount`.
3. **Limpiar datos (Code o Set):**
   - `dominio`: el website sin `http(s)://`, sin `www.` y sin la ruta.
   - `tieneWebPropia`: falso si no hay website o si el dominio es una red social o un enlazador (facebook.com, instagram.com, linktr.ee, wa.me, tiktok.com, google.com, etc.).
   - `telefonoWa`: solo dígitos. Úsalo solo si es un celular chileno (empieza en `569` y tiene 11 dígitos). Si no, queda vacío.
4. **Si tiene web propia:**
   - **Firecrawl → Scrape** del website: formato markdown, solo contenido principal, "continue on fail". Recorta el texto a 6000 caracteres.
   - **Emails de la web:** sácalos del markdown con una regex. Descarta los que terminen en .png/.jpg y prefiere los del mismo dominio.
   - **Hunter → Domain Search** con `dominio`, "continue on fail". Elige primero un email genérico (contacto@, info@, hola@…) con confianza ≥ 70; si no hay, el de mayor confianza.
   - `email` final: el de Hunter; si Hunter no encuentra, el de la web; si ninguno, vacío.
5. **Análisis (OpenAI, texto):** usa el prompt A de abajo.
6. **Mensajes (OpenAI, salida JSON):** usa el prompt B. Devuelve `asunto`, `email_html` y `whatsapp`.
7. **GHL, crear o actualizar contacto:** POST `/contacts/upsert` con locationId, `name` y `companyName` (= title), `email` (si hay), `phone`, `website`, `address1`, `city`, `country: "CL"`, `source: "Prospección Google Maps"` y `tags: ["prospeccion-maps", <rubro en minúsculas con guiones>]`. Agrega `sin-email` si no hay email y `sin-web` si no tiene web propia. Si no hay ni email ni teléfono, sáltate el negocio.
   - Si la respuesta dice que el contacto ya existía (`new: false`), no crees ni oportunidad ni borrador: así no le escribo dos veces al mismo negocio.
8. **GHL, nota:** POST `/contacts/{id}/notes` con: el análisis, el texto de WhatsApp, el link `https://wa.me/<telefonoWa>?text=<whatsapp codificado>` (si hay celular) y si se creó o no el borrador en Gmail.
9. **GHL, oportunidad:** POST `/opportunities/` con el pipeline de arriba, status open y el mismo usuario asignado. Antes, consulta GET `/opportunities/pipelines?locationId=…`. Si existe una etapa de prospección (ej. "Prospección" o "Por contactar"), úsala; si no, usa New Lead y avísame para que yo cree la etapa.
10. **Gmail (solo si hay email):** crea un borrador (no lo envíes) con la credencial "Gmail sofiaadmin", el asunto `asunto` y este cuerpo HTML: `email_html` + la firma fija de abajo.
11. **Errores:** reintentos (3 intentos, 2 s) en los HTTP de GHL, como en "GHL - Lead nuevo". Un negocio que falla no debe detener a los demás.

### Firma fija (se agrega en el nodo de Gmail, no la escribe la IA)

```html
<p>Saludos,<br>Sofía Chavarría<br>Elephant Solutions SpA<br>WhatsApp: +56 9 8407 7467<br>sofiaadmin@elephantsolutions.cl</p>
<p style="font-size:12px;color:#888888">Te escribo porque encontré los datos de contacto públicos de tu negocio en Google Maps y en su sitio web. Si no quieres recibir más correos de Elephant Solutions, responde con la palabra BAJA y no te volveremos a escribir.</p>
```

### Prompt A: análisis

```
Eres analista comercial de Elephant Solutions, una agencia chilena que crea páginas web con asistente de inteligencia artificial, chatbots y automatizaciones para pequeños negocios.

Analiza este negocio usando SOLO los datos de abajo. No inventes servicios, precios, nombres de personas ni correos. Si un dato falta, dilo y sigue con lo que hay.

Datos de Google Maps:
- Nombre: {{title}}
- Rubro: {{categoryName}}
- Dirección: {{address}}
- Sector: {{neighborhood}}
- Sitio web: {{website}} (tiene web propia: {{tieneWebPropia}})
- Teléfono: {{phone}}
- Calificación: {{totalScore}} ({{reviewsCount}} reseñas)

Contenido de su sitio web (puede venir vacío):
{{contenidoWeb}}

Entrega un análisis breve, en texto simple y sin markdown:
1. Qué hace el negocio, qué servicios ofrece y a qué cliente atiende, según su web. Marca como suposición lo que no salga de los datos.
2. Cómo lo contactan hoy los clientes (WhatsApp, formulario, teléfono, reserva en línea, nada) y qué le falta.
3. Qué consultas repetitivas probablemente recibe (horarios, precios, disponibilidad, agenda, cotizaciones).
4. Cuál de nuestros servicios le calza mejor y por qué: página web, asistente con IA 24/7 o automatizaciones (registro de solicitudes, respuestas, recordatorios, reportes). Si ya tiene web propia, prioriza el asistente y las automatizaciones.
5. Un gancho de una frase para abrir el mensaje, basado en algo concreto de su web o de sus datos.
```

### Prompt B: correo y WhatsApp (respuesta en JSON)

```
Eres Sofía, de Elephant Solutions SpA (Santiago, Chile). Creamos páginas web con un asistente de inteligencia artificial que responde consultas, guía a los clientes y recibe solicitudes de cotización a cualquier hora, y automatizaciones para que las tareas repetitivas se hagan solas.

Negocio:
Nombre: {{title}}
Rubro: {{categoryName}}
Sitio web: {{website}}
Análisis previo: {{analisis}}

Objetivo: que acepte una conversación corta (15 a 20 minutos, por videollamada o WhatsApp) para conocer su negocio y enviarle una propuesta a su medida.

Lo que puedes ofrecer (solo esto, son datos reales):
- Página web profesional adaptada a celular, con botón de WhatsApp.
- Asistente con IA que responde las preguntas frecuentes las 24 horas y recibe solicitudes.
- Automatizaciones: registro de solicitudes, respuestas, recordatorios y reportes.
- Página lista en 7 días hábiles desde que recibimos su contenido. Incluye dominio .cl y hosting el primer año, una ronda de ajustes y mantención mensual.

Cómo escribir:
- Abre con algo concreto de su negocio (el gancho del análisis), no con una presentación nuestra.
- Nombra uno o dos problemas que probablemente tiene y cómo lo resolvemos. Si ya tiene web propia, no le vendas otra página: enfócate en el asistente con IA y las automatizaciones.
- Tono cercano y directo, como se escriben dos profesionales en Chile: tutea, frases cortas, sin tecnicismos ni frases de vendedor. Usa bien los signos de apertura y cierre (¿? y ¡!).
- Termina con una pregunta fácil de responder.

No hagas esto:
- No inventes clientes, testimonios, cifras, resultados, descuentos ni ofertas con plazo. Elephant Solutions es una empresa nueva: no digas que otros negocios de la zona ya trabajan con nosotros.
- No menciones datos que no estén arriba ni adjuntos o catálogos.
- No uses asteriscos, markdown, corchetes ni campos para rellenar.
- No pongas firma: se agrega automáticamente.
- Si no sabes el nombre de la persona, saluda con "Hola, equipo de {{title}}:".

Responde SOLO con un JSON válido con estas tres claves:
- "asunto": máximo 60 caracteres, claro sobre de qué se trata, sin emojis.
- "email_html": el cuerpo del correo, máximo 130 palabras, un <p> por párrafo, sin <html> ni <body>.
- "whatsapp": un mensaje de máximo 60 palabras en texto plano para enviar a mano. Preséntate como Sofía de Elephant Solutions en la primera línea, di en una frase por qué le escribes y pregunta si le puedes contar más.
```

## Pruebas

1. Corre el flujo con `cantidad = 3` y un rubro real.
2. Revisa y muéstrame:
   - qué negocios llegaron, cuáles tenían web propia y de dónde salió cada email;
   - los contactos en GHL con sus etiquetas, la nota y la oportunidad;
   - los borradores en Gmail (asunto y cuerpo), o dónde quedó el borrador si la credencial no estaba;
   - que "GHL - Lead nuevo" se detuvo en el candado con cada uno de esos contactos y no mandó bienvenida.
3. Vuelve a correrlo con los mismos parámetros y confirma que no se duplican contactos, oportunidades ni borradores.

## Entrega

Cuando termines, dime:
- el link del flujo;
- qué quedó funcionando y qué no;
- qué credenciales o etapas tengo que crear yo;
- cuánto costó la prueba en créditos (Apify, Hunter, Firecrawl y OpenAI), si lo puedes ver.

No lo publiques: yo te digo cuándo.
