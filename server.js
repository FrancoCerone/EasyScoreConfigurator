/**
 * EasyScore Configurator: YouTube, metronomo e tab Songsterr che scorre.
 * Songsterr risponde con X-Frame-Options: Deny, quindi il browser rifiuta
 * l'iframe diretto. Qui la stessa pagina viene richiesta dal server e
 * rimandata senza quell'header, così l'iframe può mostrarla e scorrerla.
 *
 * Solo 127.0.0.1. Inoltra soltanto verso songsterr.com.
 */
const express = require('express');
const https = require('https');
const path = require('path');

const PORT = Number(process.env.PRACTICE_PORT) || 3044;
const ALLOWED_HOSTS = new Set([
  'www.songsterr.com',
  'songsterr.com',
  'static3.songsterr.com',
]);

const DROP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'connection',
  'keep-alive',
  'strict-transport-security',
  'set-cookie',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

const BRIDGE = `<script>
(function () {
  if (window.__hrcastBridge) return;
  window.__hrcastBridge = true;
  var css = document.createElement('style');
  css.textContent = '[role="alert"]{display:none !important}';
  (document.head || document.documentElement).appendChild(css);
  (function () {
    var nativeWorker = window.Worker;
    if (!nativeWorker) return;
    var current = nativeWorker;
    function rewriteWorkerUrl(url) {
      var value = String(url);
      var mark = 'https://static3.songsterr.dev/stage-';
      if (value.indexOf(mark) !== 0) return value;
      var slash = value.indexOf('/', mark.length);
      if (slash < 0) return value;
      return 'https://static3.songsterr.com/production-main/' + value.slice(slash + 1);
    }
    try {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (Next) {
          function Wrapped(url, opts) {
            var raw = String(url);
            var fixed = rewriteWorkerUrl(raw);
            return new Next(fixed === raw ? url : fixed, opts);
          }
          Wrapped.prototype = Next.prototype;
          current = Wrapped;
        }
      });
    } catch (e) {}
  })();
  try {
    if (window.ServiceWorkerContainer) {
      ServiceWorkerContainer.prototype.register = function () {
        return Promise.reject(new Error('service worker disattivato nel prototipo'));
      };
    }
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (reg) { reg.unregister(); });
      });
    }
  } catch (e) {}

  function rewrite(url) {
    try {
      var u = new URL(String(url), location.href);
      if (u.hostname === 'www.songsterr.com' || u.hostname === 'songsterr.com') {
        return u.pathname + u.search + u.hash;
      }
    } catch (e) {}
    return url;
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) input = rewrite(input);
        else if (input && typeof input.url === 'string') {
          var next = rewrite(input.url);
          if (next !== input.url) input = new Request(next, input);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[1] === 'string') args[1] = rewrite(args[1]);
    return origOpen.apply(this, args);
  };

  var consentTries = 0;
  var consentTimer = setInterval(function () {
    consentTries += 1;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (label === 'rifiuta tutto' || label === 'reject all') {
        buttons[i].click();
        clearInterval(consentTimer);
        return;
      }
    }
    if (consentTries > 25) clearInterval(consentTimer);
  }, 400);

  window.__hrcastErrors = [];
  window.addEventListener('error', function (ev) {
    window.__hrcastErrors.push(String(ev.message || 'error') + ' @ ' + String(ev.filename || '') + ':' + String(ev.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    var text = reason && (reason.stack || reason.message) || String(reason);
    window.__hrcastErrors.push(String(text).slice(0, 500));
  });

  var goal = null;
  var followUntil = 0;
  var followRaf = 0;
  var lastReport = '';
  var PARK = 18;

  function scroller() {
    return document.scrollingElement || document.documentElement;
  }

  function post(extra) {
    try {
      parent.postMessage(Object.assign({ source: 'hrcast-tab' }, extra), '*');
    } catch (e) {}
  }

  function uniq(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || seen[n]) continue;
      seen[n] = 1;
      out.push(n);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function readLines() {
    var tab = document.getElementById('tablature');
    if (!tab) return [];
    var scroll = scroller().scrollTop;
    var nodes = tab.querySelectorAll('[data-line-unit-index]');
    var lines = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.height < 24) continue;
      var measures = [];
      var marks = el.querySelectorAll('[data-notes-measure]');
      for (var j = 0; j < marks.length; j++) {
        var m = Number(marks[j].getAttribute('data-notes-measure'));
        if (m > 0) measures.push(m);
      }
      lines.push({
        el: el,
        index: Number(el.getAttribute('data-line-unit-index')),
        top: rect.top + scroll,
        measures: uniq(measures)
      });
    }
    lines.sort(function (a, b) { return a.index - b.index; });
    return lines;
  }

  function lineByIndex(lines, index) {
    var best = null;
    var bestDist = 1e9;
    for (var i = 0; i < lines.length; i++) {
      var d = Math.abs(lines[i].index - index);
      if (d < bestDist) {
        best = lines[i];
        bestDist = d;
      }
    }
    return best;
  }

  function locate(lines, bar) {
    var lower = null;
    var upper = null;
    for (var i = 0; i < lines.length; i++) {
      var ms = lines[i].measures;
      if (!ms.length) continue;
      if (bar >= ms[0] && bar <= ms[ms.length - 1]) return { line: lines[i], exact: true };
      var last = ms[ms.length - 1];
      var first = ms[0];
      if (last < bar && (!lower || last > lower.measures[lower.measures.length - 1])) lower = lines[i];
      if (first > bar && (!upper || first < upper.measures[0])) upper = lines[i];
    }
    var guess = null;
    if (lower && upper && upper.index !== lower.index) {
      var per = (upper.measures[0] - lower.measures[lower.measures.length - 1]) / (upper.index - lower.index);
      if (per > 0) guess = lower.index + (bar - lower.measures[lower.measures.length - 1]) / per;
    } else if (lower) {
      var perLine = Math.max(1, lower.measures.length);
      guess = lower.index + (bar - lower.measures[lower.measures.length - 1]) / perLine;
    } else if (upper) {
      var perLineU = Math.max(1, upper.measures.length);
      guess = upper.index - (upper.measures[0] - bar) / perLineU;
    }
    if (guess == null) return null;
    var line = lineByIndex(lines, guess);
    return line ? { line: line, exact: false } : null;
  }

  function ensureBox(id, css) {
    var box = document.getElementById(id);
    if (box) return box;
    box = document.createElement('div');
    box.id = id;
    box.style.cssText = css;
    return box;
  }

  function clearMark() {
    var wash = document.getElementById('hrcast-bar');
    var cursor = document.getElementById('hrcast-beat');
    if (wash && wash.parentNode) wash.parentNode.removeChild(wash);
    if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
  }

  function paint(lineEl, bar, beat, beats) {
    var path = null;
    var marks = lineEl.querySelectorAll('[data-notes-measure]');
    for (var i = 0; i < marks.length; i++) {
      if (Number(marks[i].getAttribute('data-notes-measure')) === bar) {
        path = marks[i];
        break;
      }
    }
    if (!path) return;
    if (getComputedStyle(lineEl).position === 'static') lineEl.style.position = 'relative';
    var wash = ensureBox('hrcast-bar', 'position:absolute;pointer-events:none;z-index:20;background:rgba(245,208,0,0.16);box-shadow:inset 3px 0 0 #f5d000;border-radius:2px;');
    var cursor = ensureBox('hrcast-beat', 'position:absolute;pointer-events:none;z-index:21;width:3px;margin-left:-1px;background:#f5d000;box-shadow:0 0 10px rgba(245,208,0,0.9);border-radius:2px;');
    var lr = lineEl.getBoundingClientRect();
    var pr = path.getBoundingClientRect();
    var left = pr.left - lr.left;
    var width = Math.max(8, pr.width);
    var top = Math.max(0, pr.top - lr.top);
    var height = Math.max(12, pr.height);
    wash.style.left = left + 'px';
    wash.style.top = top + 'px';
    wash.style.width = width + 'px';
    wash.style.height = height + 'px';
    var frac = beats > 0 ? Math.max(0, Math.min(0.98, beat / beats)) : 0;
    cursor.style.left = (left + frac * width) + 'px';
    cursor.style.top = top + 'px';
    cursor.style.height = height + 'px';
    if (wash.parentNode !== lineEl) lineEl.appendChild(wash);
    if (cursor.parentNode !== lineEl) lineEl.appendChild(cursor);
  }

  function report(bar, exact, measures) {
    var key = String(bar) + ':' + (exact ? '1' : '0') + ':' + measures.join(',');
    if (key === lastReport) return;
    lastReport = key;
    post({
      follow: true,
      bar: bar,
      exact: exact,
      measures: measures,
      pos: Math.round(scroller().scrollTop)
    });
  }

  function followTick() {
    followRaf = 0;
    if (!goal) return;
    var lines = readLines();
    var place = locate(lines, goal.bar);
    var settled = false;
    if (place) {
      if (place.exact) paint(place.line.el, goal.bar, goal.beat, goal.beats);
      var diff = place.line.el.getBoundingClientRect().top - PARK;
      var node = scroller();
      if (Math.abs(diff) < 3) {
        if (diff) node.scrollTop += diff;
        settled = place.exact;
      } else {
        node.scrollTop += diff * 0.42;
      }
      report(goal.bar, place.exact, place.line.measures);
    }
    if (!settled && performance.now() < followUntil) {
      followRaf = requestAnimationFrame(followTick);
    }
  }

  function follow(bar, beat, beats) {
    goal = { bar: bar, beat: beat || 0, beats: beats || 1 };
    followUntil = performance.now() + 1600;
    if (!followRaf) followRaf = requestAnimationFrame(followTick);
  }

  function haltFollow() {
    goal = null;
    followUntil = 0;
    if (followRaf) cancelAnimationFrame(followRaf);
    followRaf = 0;
    clearMark();
  }

  function measureAt(x, y) {
    var tab = document.getElementById('tablature');
    if (!tab) return 0;
    var lines = tab.querySelectorAll('[data-line-unit-index]');
    var line = null;
    for (var i = 0; i < lines.length; i++) {
      var rect = lines[i].getBoundingClientRect();
      if (rect.height < 24 || rect.width < 40) continue;
      if (x < rect.left || x > rect.right) continue;
      if (y < rect.top || y > rect.bottom) continue;
      line = lines[i];
      break;
    }
    if (!line) return 0;
    var marks = line.querySelectorAll('[data-notes-measure]');
    var found = 0;
    var foundDist = 1e9;
    var seen = Object.create(null);
    var j;
    for (j = 0; j < marks.length; j++) {
      var m = Number(marks[j].getAttribute('data-notes-measure'));
      if (!m || seen[m]) continue;
      seen[m] = 1;
      var r = marks[j].getBoundingClientRect();
      if (x < r.left - 16 || x > r.right + 16) continue;
      var dist = Math.abs(x - (r.left + r.width / 2));
      if (dist < foundDist) {
        found = m;
        foundDist = dist;
      }
    }
    if (found) return found;
    var near = 0;
    var nearDist = 1e9;
    seen = Object.create(null);
    for (j = 0; j < marks.length; j++) {
      var m2 = Number(marks[j].getAttribute('data-notes-measure'));
      if (!m2 || seen[m2]) continue;
      seen[m2] = 1;
      var r2 = marks[j].getBoundingClientRect();
      var d2 = Math.abs(x - (r2.left + r2.width / 2));
      if (d2 < nearDist) {
        near = m2;
        nearDist = d2;
      }
    }
    return near;
  }

  document.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    var tab = document.getElementById('tablature');
    if (!tab || !tab.contains(ev.target)) return;
    var bar = measureAt(ev.clientX, ev.clientY);
    if (!bar) return;
    ev.preventDefault();
    ev.stopPropagation();
    post({ pick: bar });
  }, true);

  var pickArm = setInterval(function () {
    var tab = document.getElementById('tablature');
    if (!tab) return;
    tab.style.cursor = 'pointer';
    clearInterval(pickArm);
  }, 400);

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || data.source !== 'hrcast-practice') return;
    if (data.cmd === 'ping') {
      post({
        ready: true,
        href: location.href,
        title: document.title,
        lines: readLines().length,
        errors: window.__hrcastErrors.slice(-6)
      });
      return;
    }
    if (data.cmd === 'follow') {
      var bar = Math.max(1, Math.round(Number(data.bar) || 1));
      var beats = Math.max(1, Math.round(Number(data.beats) || 1));
      var beat = Math.max(0, Math.min(beats - 1, Math.round(Number(data.beat) || 0)));
      follow(bar, beat, beats);
      return;
    }
    if (data.cmd === 'stop') {
      haltFollow();
      post({ running: false });
      return;
    }
    if (data.cmd === 'reset') {
      haltFollow();
      lastReport = '';
      scroller().scrollTop = 0;
      post({ running: false, pos: 0 });
    }
  });

  post({ ready: true, boot: true });
})();
//# sourceURL=practice-bridge.js
</script>`;

function injectBridge(html) {
  if (html.includes('__hrcastBridge')) return html;
  const marker = '<meta charSet="utf-8">';
  if (html.includes(marker)) return html.replace(marker, marker + BRIDGE);
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + BRIDGE);
  return BRIDGE + html;
}

function proxySongsterr(clientReq, clientRes, targetUrl, redirects = 0) {
  let url;
  try {
    url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  } catch {
    clientRes.status(400).send('URL non valido');
    return;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    clientRes.status(400).send('Host non consentito');
    return;
  }

  const upstream = https.request(
    {
      protocol: 'https:',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: clientReq.method || 'GET',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: clientReq.headers.accept || '*/*',
        'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
        'accept-encoding': 'identity',
        ...(clientReq.headers['content-type']
          ? { 'content-type': clientReq.headers['content-type'] }
          : {}),
      },
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && upstreamRes.headers.location) {
        if (redirects >= 5) {
          upstreamRes.resume();
          clientRes.status(502).send('Troppi redirect');
          return;
        }
        const next = new URL(upstreamRes.headers.location, url);
        upstreamRes.resume();
        proxySongsterr(clientReq, clientRes, next, redirects + 1);
        return;
      }

      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isHtml = contentType.includes('text/html');
      console.log(`[easyscore] ${status} ${url.hostname}${url.pathname}`);

      if (isHtml) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          if (clientRes.headersSent) return;
          const html = injectBridge(Buffer.concat(chunks).toString('utf8'));
          clientRes.status(status || 200);
          clientRes.set('content-type', 'text/html; charset=utf-8');
          clientRes.set('cache-control', 'no-store');
          clientRes.send(html);
        });
        return;
      }

      clientRes.status(status || 200);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (DROP_HEADERS.has(key.toLowerCase())) continue;
        if (value !== undefined) clientRes.setHeader(key, value);
      }
      upstreamRes.pipe(clientRes);
    }
  );

  upstream.on('error', (err) => {
    if (!clientRes.headersSent) clientRes.status(502).send(err.message);
  });
  upstream.setTimeout(20000, () => upstream.destroy(new Error('timeout Songsterr')));
  clientRes.on('close', () => {
    if (!clientRes.writableEnded) upstream.destroy();
  });
  if (clientReq.method === 'POST' || clientReq.method === 'PUT') clientReq.pipe(upstream);
  else upstream.end();
}

const app = express();
const page = path.join(__dirname, 'public', 'index.html');

app.get('/', (_req, res) => {
  res.sendFile(page);
});

app.use((req, res) => {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.status(405).type('text/plain').send('Metodo non inoltrato');
    return;
  }
  const target = new URL(req.originalUrl, 'https://www.songsterr.com');
  proxySongsterr(req, res, target);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[easyscore] http://127.0.0.1:${PORT}/`);
});
