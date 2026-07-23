/* sw.js — Service Worker mínimo do clockin.
 * Existe para: (1) habilitar registration.showNotification (lembrete de
 * fim de intervalo) e (2) tornar o app instalável (manifest + SW).
 * Estratégia de cache: NETWORK-FIRST — sempre tenta a rede primeiro,
 * o cache só serve como fallback offline. Nunca segura JS antigo.
 */
'use strict';

var CACHE = 'clockin-v2';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys().then(function (chaves) {
      return Promise.all(chaves.filter(function (c) {
        return c !== CACHE;
      }).map(function (c) {
        return caches.delete(c);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (evento) {
  var req = evento.request;
  if (req.method !== 'GET') return;
  // Nunca intercepta a API do GitHub: o app já tem fila offline própria.
  if (req.url.indexOf('api.github.com') !== -1) return;

  evento.respondWith(
    fetch(req).then(function (resp) {
      // Rede OK: atualiza o cache (só same-origin) e devolve a resposta fresca.
      if (resp && resp.ok && req.url.indexOf(self.location.origin) === 0) {
        var copia = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copia); }).catch(function () {});
      }
      return resp;
    }).catch(function () {
      // Offline: serve a última versão em cache, se houver.
      return caches.match(req).then(function (hit) {
        return hit || Response.error();
      });
    })
  );
});

/* Toque na notificação do lembrete: foca (ou abre) o app. */
self.addEventListener('notificationclick', function (evento) {
  evento.notification.close();
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if ('focus' in lista[i]) return lista[i].focus();
      }
      return self.clients.openWindow('.');
    })
  );
});
