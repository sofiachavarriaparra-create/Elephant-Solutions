// Elephant Solutions — interacciones del sitio
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasIO = 'IntersectionObserver' in window;

  // ---------- Video del hero ----------
  var video = document.querySelector('.hero__video');
  if (video) {
    video.muted = true;
    if (reduce) {
      video.pause();
    } else {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
  }

  // ---------- Intro: escribe "ELEPHANT" y luego sube ----------
  var intro = document.querySelector('.intro');
  var heroMain = document.querySelector('.hero__main');

  function introDone() {
    if (intro) intro.classList.add('is-done');
    if (heroMain) heroMain.classList.add('is-in');
  }

  if (!intro || reduce) {
    introDone();
    startChat(true);
  } else {
    var WORD = 'ELEPHANT', CHAR = 60, START = 120;
    var LIFT = START + WORD.length * CHAR + 200;
    var typed = intro.querySelector('[data-typed]');
    var cursor = intro.querySelector('.intro__cursor');
    for (var i = 1; i <= WORD.length; i++) {
      (function (n) {
        setTimeout(function () { typed.textContent = WORD.slice(0, n); }, START + (n - 1) * CHAR);
      })(i);
    }
    setTimeout(function () { cursor.hidden = true; }, LIFT - 150);
    setTimeout(function () { intro.classList.add('is-lifting'); }, LIFT);
    setTimeout(function () { heroMain.classList.add('is-in'); }, LIFT + 250);
    setTimeout(function () { intro.classList.add('is-done'); startChat(false); }, LIFT + 650);
  }

  // ---------- Conversación de ejemplo en la tarjeta del asistente ----------
  function startChat(isStatic) {
    var log = document.querySelector('[data-chat]');
    if (!log) return;
    var user = log.querySelector('[data-chat-step="user"]');
    var typing = log.querySelector('[data-chat-step="typing"]');
    var bot = log.querySelector('[data-chat-step="bot"]');

    function show(el, on) {
      if (on && el.hidden) {
        el.hidden = false;
        el.classList.remove('pop');
        void el.offsetWidth; // reinicia la animación
        el.classList.add('pop');
      } else if (!on) {
        el.hidden = true;
      }
    }

    function render(step) {
      show(user, step >= 1);
      show(typing, step === 2);
      show(bot, step >= 3);
    }

    if (isStatic) { render(3); return; }

    // [paso, duración en ms]
    var seq = [[1, 600], [2, 1500], [3, 5200], [0, 900]];
    var idx = 0;
    render(0);
    (function tick() {
      var s = seq[idx];
      render(s[0]);
      idx = (idx + 1) % seq.length;
      setTimeout(tick, s[1]);
    })();
  }

  // ---------- Revelado al hacer scroll ----------
  var revealEls = document.querySelectorAll('.rv, [data-pixel-logo]');
  if (!hasIO || reduce) {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var rvObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-visible');
          rvObs.unobserve(en.target);
        }
      });
    }, { threshold: 0.2 });
    revealEls.forEach(function (el) { rvObs.observe(el); });
  }

  // ---------- Contador de días hábiles ----------
  var stats = document.querySelector('[data-stats]');
  var counter = stats && stats.querySelector('[data-count]');
  if (counter && hasIO && !reduce) {
    var target = +counter.getAttribute('data-count');
    counter.textContent = '0';
    var statsObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        statsObs.disconnect();
        var t0 = 0;
        requestAnimationFrame(function step(ts) {
          if (!t0) t0 = ts;
          var t = Math.min(1, (ts - t0) / 2000);
          counter.textContent = Math.round((1 - Math.pow(1 - t, 3)) * target);
          if (t < 1) requestAnimationFrame(step);
        });
      });
    }, { threshold: 0.3 });
    statsObs.observe(stats);
  }

  // ---------- Preguntas frecuentes (una abierta a la vez) ----------
  var faq = document.querySelector('[data-faq]');
  if (faq) {
    var buttons = faq.querySelectorAll('.faq__q');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        buttons.forEach(function (b) {
          b.setAttribute('aria-expanded', 'false');
          document.getElementById(b.getAttribute('aria-controls')).hidden = true;
        });
        if (!open) {
          btn.setAttribute('aria-expanded', 'true');
          document.getElementById(btn.getAttribute('aria-controls')).hidden = false;
        }
      });
    });
  }

  // ---------- Logo pixelado del footer ----------
  var logo = document.querySelector('[data-pixel-logo]');
  if (logo) {
    var CELLS = '6,0;7,0;8,0;9,0;10,0;11,0;12,0;4,1;5,1;10,1;13,1;14,1;3,2;10,2;15,2;2,3;9,3;13,3;16,3;2,4;9,4;16,4;1,5;9,5;16,5;1,6;10,6;16,6;1,7;11,7;12,7;14,7;16,7;1,8;14,8;16,8;1,9;5,9;6,9;7,9;8,9;9,9;14,9;16,9;1,10;4,10;10,10;14,10;16,10;1,11;4,11;10,11;14,11;16,11;1,12;4,12;10,12;14,12;16,12;1,13;4,13;10,13;14,13;15,13';
    var pixels = CELLS.split(';').map(function (c, i) {
      var xy = c.split(',');
      return { x: +xy[0], y: +xy[1], c: '#FFFFFF', d: i * 22 };
    });
    for (var gx = -1; gx < 19; gx++) pixels.push({ x: gx, y: 14, c: '#5BB38E', d: 64 * 22 + (gx + 1) * 18 });

    var frag = document.createDocumentFragment();
    pixels.forEach(function (q) {
      var s = document.createElement('span');
      s.style.left = ((q.x + 1) / 20 * 100) + '%';
      s.style.top = ((q.y + 1) / 16 * 100) + '%';
      s.style.background = q.c;
      s.style.transitionDelay = q.d + 'ms';
      frag.appendChild(s);
    });
    logo.appendChild(frag);
  }
})();
