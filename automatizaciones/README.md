# Automatización: busca leads y crea borradores de email

Escenario de Make (`busca-leads-elephant.blueprint.json`) que:

1. Busca negocios en Google Maps con Apify (por defecto, centros de estética en Santiago).
2. Si el negocio tiene sitio web, busca su email con Hunter.
3. Si encuentra email, GPT analiza el negocio con los datos de Google Maps.
4. GPT redacta un correo personalizado ofreciendo los servicios de Elephant Solutions.
5. Guarda el lead en Google Sheets.
6. Crea un **borrador** en Gmail (no envía nada: tú revisas y envías).

## Cómo importarlo

1. En Make: *Create a new scenario* → menú `···` → *Import Blueprint* → sube el JSON.
2. Elige tus conexiones en cada módulo: Apify, Hunter, OpenAI, Google Sheets y Gmail.
3. Crea una planilla "Leads Elephant Solutions" con estos encabezados en la fila 1:
   `Empresa | Dirección | Email | Teléfono | WEB | Mensaje | Rubro | Fecha | Estado`
   y selecciónala en el módulo de Google Sheets.
4. Corre el escenario una vez con 5 negocios y revisa los borradores antes de subir el número.

## Qué cambiar en cada búsqueda

En el módulo de Apify, dentro de *Input JSON*:

- `searchStringsArray`: el rubro. Ejemplos del público de la landing: `"laboratorio clínico"`,
  `"clínica dental"`, `"centro de estética"`, `"servicio técnico"`, `"ferretería"`.
- `locationQuery` y `city`: la ciudad, por ejemplo `"Valparaíso, Chile"` / `"Valparaíso"`.
- `maxCrawledPlacesPerSearch`: cuántos negocios traer. Parte con 5; cada negocio gasta
  créditos de Apify, Hunter y OpenAI.

## Antes de enviar los correos

- La firma y el texto para darse de baja se agregan solos en el módulo de Gmail. La ley chilena
  (Ley 19.496, art. 28 B) exige que los correos promocionales identifiquen al remitente, indiquen
  el asunto y den una forma de pedir que no te escriban más. Si alguien responde BAJA, anótalo en
  la columna Estado y no le vuelvas a escribir.
- Lee cada borrador: el modelo no navega por internet, así que solo conoce el nombre, rubro,
  dirección y calificación del negocio.
