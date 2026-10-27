# Elephant Solutions — Landing

Sitio estático de Elephant Solutions SpA: páginas web con asistente de IA para negocios.

## Estructura

```
index.html          Landing principal
privacidad.html     Política de privacidad
css/styles.css      Estilos (colores y fuentes como variables en :root)
js/main.js          Intro animada, chat de ejemplo, revelado al scroll, contador, FAQ y logo pixelado
assets/             Video del hero, imágenes de servicios y favicon
```

No requiere build ni dependencias.

## Ver en local

```bash
python3 -m http.server 8000
```

Luego abre http://localhost:8000.

## Publicar

Funciona tal cual en GitHub Pages (Settings → Pages → rama `main`, carpeta `/`), Netlify o Vercel.
