(function () {
  'use strict';

  var F = window.Floods;
  var esc = F.esc, css = F.css, dist = F.dist;

  // server.mjs proxies both; the public services also send CORS headers, so direct calls are the fallback.
  var ROUTE_URLS = ['/api/route', 'https://valhalla1.openstreetmap.de/route'];
  var GEO_URLS = ['/api/geocode?q=', 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q='];
  var HIT_KM = 0.15;      // a report this close to the line counts as on the route
  var AVOID_KM = 0.15;    // radius of the area the planner steers around
  var END_KM = 0.4;       // reports this close to A or B can't be avoided
  var MAX_AVOID = 10;     // the public router caps excluded areas at 10 km of perimeter (~0.9 km each)
  var RISK_MIN = 3;       // minutes of extra driving worth one unit of passable-water risk

  var RELOAD_MS = 5 * 60 * 1000; // re-fetch reports before a check if they are older than this

  var R = { items: [], loaded: null, loadedAt: 0, a: null, b: null, veh: 'small', routes: [], sel: 0, busy: false };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- map ----------
  var map = L.map('map', { zoomControl: true }).setView([13.4, 101.0], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var hitLayer = L.layerGroup().addTo(map);
  var pins = { a: null, b: null };

  function pin(which, p) {
    if (pins[which]) map.removeLayer(pins[which]);
    pins[which] = p ? L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: '<span class="rt-pin rt-pin--' + which + '">' + which.toUpperCase() + '</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
      zIndexOffset: 1000, keyboard: false
    }).bindTooltip(esc(p.label)).addTo(map) : null;
  }

  // ---------- geometry ----------
  function decode(enc) { // Valhalla polyline, precision 6
    var idx = 0, lat = 0, lng = 0, out = [];
    while (idx < enc.length) {
      for (var k = 0; k < 2; k++) {
        var res = 0, sh = 0, b;
        do { b = enc.charCodeAt(idx++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        var d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e6, lng / 1e6]);
    }
    return out;
  }

  // Distance from p to the route, and how far along the route that closest point is (km).
  function nearest(pts, cum, p) {
    var best = { d: Infinity, along: 0 };
    var kx = Math.cos(p.lat * Math.PI / 180) * 111.32, ky = 110.57;
    for (var i = 1; i < pts.length; i++) {
      var ax = (pts[i - 1][1] - p.lng) * kx, ay = (pts[i - 1][0] - p.lat) * ky;
      var bx = (pts[i][1] - p.lng) * kx, by = (pts[i][0] - p.lat) * ky;
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      var cx = ax + t * dx, cy = ay + t * dy, d = Math.sqrt(cx * cx + cy * cy);
      if (d < best.d) best = { d: d, along: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
    }
    return best;
  }

  function analyse(trip, kind) {
    var pts = decode(trip.legs[0].shape);
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + F.km({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] }));
    var lats = pts.map(function (p) { return p[0]; }), lngs = pts.map(function (p) { return p[1]; });
    var box = { s: Math.min.apply(null, lats) - 0.01, n: Math.max.apply(null, lats) + 0.01, w: Math.min.apply(null, lngs) - 0.01, e: Math.max.apply(null, lngs) + 0.01 };
    // One entry per report, at its closest approach, even where the route passes it twice.
    var hits = [];
    R.items.forEach(function (it) {
      if (it.stale) return; // not re-checked in a day; listed on the report page, not used to judge a route
      if (!(it.lat > box.s && it.lat < box.n && it.lng > box.w && it.lng < box.e)) return;
      var n = nearest(pts, cum, it);
      if (n.d <= HIT_KM) hits.push({ it: it, along: n.along });
    });
    hits.sort(function (a, b) { return a.along - b.along; });
    var blocked = hits.filter(function (h) { return h.it.sev.block[R.veh]; });
    return {
      kind: kind, pts: pts, hits: hits, blocked: blocked,
      km: trip.summary.length, min: trip.summary.time / 60,
      risk: hits.reduce(function (s, h) { return s + h.it.sev.rank; }, 0)
    };
  }

  function hexagon(p, r) {
    var out = [];
    for (var i = 0; i <= 6; i++) {
      var a = (i % 6) * Math.PI / 3;
      out.push([p.lng + r * Math.cos(a) / (111.32 * Math.cos(p.lat * Math.PI / 180)), p.lat + r * Math.sin(a) / 110.57]);
    }
    return out;
  }

  // ---------- services ----------
  function postRoute(body, i) {
    i = i || 0;
    return fetch(ROUTE_URLS[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok && d.trip) return d;
          // A routing answer (no path, bad area) is final; only a missing proxy falls through to the next URL.
          var err = new Error(d.error || ('route ' + r.status));
          err.final = r.status === 400 || !!d.error_code;
          throw err;
        });
      })
      .catch(function (err) {
        if (!err.final && i + 1 < ROUTE_URLS.length) return postRoute(body, i + 1);
        throw err;
      });
  }

  function route(a, b, avoid) {
    var body = {
      locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }],
      costing: 'auto', units: 'kilometers', directions_type: 'none'
    };
    if (avoid && avoid.length) body.exclude_polygons = avoid.map(function (it) { return hexagon(it, AVOID_KM); });
    else body.alternates = 2;
    return postRoute(body);
  }

  function geocode(q, i) {
    i = i || 0;
    return F.getJSON(GEO_URLS[i] + encodeURIComponent(q)).then(function (d) {
      return (d.features || []).map(function (f) {
        var p = f.properties || {};
        var where = [p.district, p.city || p.county, p.state].filter(function (x, k, arr) { return x && x !== p.name && arr.indexOf(x) === k; });
        return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: p.name || where[0] || q, sub: where.join(' · ') };
      });
    }, function (err) {
      if (i + 1 < GEO_URLS.length) return geocode(q, i + 1);
      throw err;
    });
  }

  // ---------- plan ----------
  function plan() {
    if (!R.a || !R.b) { say('เลือกต้นทางและปลายทางก่อน'); return; }
    if (F.km(R.a, R.b) < 0.2) { say('ต้นทางกับปลายทางใกล้กันเกินไป'); return; }
    R.busy = true;
    var go = $('go');
    go.disabled = true;
    go.textContent = 'กำลังตรวจเส้นทาง…';
    $('result').innerHTML = '<div class="panel rt-wait"><span class="sk sk--row"></span><span class="sk sk--row"></span></div>';
    shareURL();

    if (Date.now() - R.loadedAt > RELOAD_MS) R.loaded = loadReports();
    R.loaded.then(function () { return route(R.a, R.b); }).then(function (d) {
      var list = [analyse(d.trip, 'normal')].concat((d.alternates || []).map(function (x) { return analyse(x.trip, 'alt'); }));
      if (list.every(function (r) { return r.blocked.length; })) return withDetour(list);
      return list;
    }).then(function (list) {
      R.routes = rank(list);
      R.sel = 0;
      render();
    }).catch(function (err) {
      console.error(err);
      $('result').innerHTML = '<div class="rt-verdict rt-verdict--crit"><b>หาเส้นทางไม่สำเร็จ</b><span>' +
        (/no path|no suitable/i.test(err.message) ? 'ไม่พบเส้นทางรถยนต์ระหว่าง 2 จุดนี้' : 'บริการหาเส้นทางไม่ตอบ ลองใหม่อีกครั้ง') + '</span></div>';
    }).then(function () {
      R.busy = false;
      go.disabled = false;
      go.textContent = 'ตรวจเส้นทาง';
    });
  }

  // Ask for a route that steers around every report this vehicle shouldn't drive through.
  function withDetour(list) {
    var seen = {}, avoid = [];
    list.forEach(function (r) {
      r.blocked.forEach(function (h) {
        var it = h.it;
        if (seen[it.id] || F.km(it, R.a) < END_KM || F.km(it, R.b) < END_KM) return;
        seen[it.id] = true;
        avoid.push(it);
      });
    });
    if (!avoid.length) return list;
    avoid.sort(function (x, y) { return y.sev.rank - x.sev.rank; });
    avoid = avoid.slice(0, MAX_AVOID);
    return route(R.a, R.b, avoid).then(function (d) {
      return list.concat([analyse(d.trip, 'detour')]);
    }, function (err) {
      console.warn('detour failed', err);
      return list; // no way round: the verdict says so
    });
  }

  function rank(list) {
    var fastest = list.reduce(function (m, r) { return r.min < m.min ? r : m; }, list[0]);
    fastest.fastest = true;
    // Drop near-identical alternatives.
    var out = [];
    list.forEach(function (r) {
      if (!out.some(function (o) { return Math.abs(o.km - r.km) < 0.3 && Math.abs(o.min - r.min) < 1 && o.blocked.length === r.blocked.length; })) out.push(r);
    });
    // Fewest points this vehicle shouldn't cross comes first; after that each unit of risk
    // (1 = light water or unconfirmed, 2 = passable with care) is worth RISK_MIN minutes of driving.
    var cost = function (r) { return r.min + r.risk * RISK_MIN; };
    out.sort(function (x, y) { return (x.blocked.length - y.blocked.length) || (cost(x) - cost(y)); });
    out[0].best = true;
    return out.slice(0, 3);
  }

  // ---------- render ----------
  function dur(min) {
    var m = Math.round(min);
    return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม. ' + (m % 60 ? (m % 60) + ' นาที' : '');
  }

  function asOf() {
    var last = F.latest(R.items);
    return last ? '<span class="rt-asof">ตรวจกับรายงานน้ำท่วม ณ ' + F.stamp(last) + ' (หน่วยงานยืนยันล่าสุด ' + F.ago(last) + ')</span>' : '';
  }

  function verdict() {
    return verdictBody().replace(/<\/div>$/, asOf() + '</div>');
  }

  function verdictBody() {
    var best = R.routes[0];
    var fastest = R.routes.filter(function (r) { return r.fastest; })[0] || best;
    var extra = best !== fastest && fastest.blocked.length && !best.blocked.length
      ? '<span>เส้นที่เร็วที่สุดผ่านจุดที่' + (R.veh === 'small' ? 'รถของคุณ' : '') + 'ไม่ควรผ่าน ' + fastest.blocked.length + ' จุด เส้นเลี่ยงไกลขึ้น <b>' +
        (best.km - fastest.km).toFixed(1) + ' กม.</b> (+' + Math.max(1, Math.round(best.min - fastest.min)) + ' นาที)</span>' : '';
    if (!best.hits.length) {
      return '<div class="rt-verdict rt-verdict--ok"><b>✅ ไม่พบรายงานน้ำท่วมบนเส้นทางที่แนะนำ</b>' + extra +
        '<span class="small">ถนนที่ไม่มีรายงานอาจยังมีน้ำ ขับด้วยความระวัง</span></div>';
    }
    if (!best.blocked.length) {
      return '<div class="rt-verdict rt-verdict--warn"><b>⚠️ ไปได้ แต่มีน้ำบนเส้นทาง ' + best.hits.length + ' จุด</b>' + extra +
        '<span>ขับช้า เว้นระยะ และหลีกเลี่ยงการเบรกกลางน้ำ</span></div>';
    }
    var closed = best.blocked.filter(function (h) { return h.it.sev.key === 'closed'; }).length;
    var smallOnly = best.blocked.length - closed;
    var lines = [];
    if (closed) lines.push('มีจุดที่<b>ผ่านไม่ได้</b> ' + closed + ' จุด ควรเลื่อนการเดินทาง หรือโทรสอบถาม <a href="tel:1586">1586</a>');
    if (smallOnly) lines.push('<b>รถเล็กไม่ควรผ่าน</b> ' + smallOnly + ' จุด ถ้าจำเป็นต้องไป ควรใช้รถสูง');
    return '<div class="rt-verdict rt-verdict--crit"><b>⛔ เลี่ยงไม่ได้</b><span>หาเส้นทางที่ไม่ผ่านจุดเหล่านี้ไม่ได้</span>' +
      lines.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div>';
  }

  function hitRow(h) {
    var s = h.it.sev;
    return '<li class="rt-hit" data-lat="' + h.it.lat + '" data-lng="' + h.it.lng + '">' +
      '<span class="rt-hit__km">กม. ' + Math.max(0, h.along).toFixed(h.along < 10 ? 1 : 0) + '</span>' +
      '<span class="rt-hit__main"><span class="rt-chip rt-chip--' + s.color + '">' + esc(s.label) + '</span>' +
        '<span class="rt-hit__title">' + esc(h.it.title) + '</span>' +
        (h.it.place ? '<span class="rt-hit__place">' + esc(h.it.place) + '</span>' : '') +
        '<span class="rt-hit__adv' + (s.block[R.veh] ? ' is-block' : '') + '">' + esc(s.advice) + '</span>' +
        '<span class="rt-hit__time">' + esc(F.freshness(h.it)) + '</span></span>' +
    '</li>';
  }

  function card(r, i) {
    var tags = [];
    if (r.best) tags.push('<span class="rt-tag rt-tag--best">แนะนำ</span>');
    if (r.fastest) tags.push('<span class="rt-tag">เร็วที่สุด</span>');
    if (r.kind === 'detour') tags.push('<span class="rt-tag">เส้นเลี่ยงน้ำท่วม</span>');
    var worst = r.hits.reduce(function (m, h) { return h.it.sev.rank > m.rank ? h.it.sev : m; }, { rank: 0, color: 'ok' });
    var state = !r.hits.length ? '<span class="rt-chip rt-chip--ok">ไม่พบน้ำท่วม</span>'
      : r.blocked.length ? '<span class="rt-chip rt-chip--crit">ไม่ควรผ่าน ' + r.blocked.length + ' จุด</span>'
      : '<span class="rt-chip rt-chip--' + worst.color + '">มีน้ำ ' + r.hits.length + ' จุด</span>';
    return '<article class="rt-card' + (i === R.sel ? ' is-sel' : '') + '" data-i="' + i + '" tabindex="0" role="button" aria-pressed="' + (i === R.sel) + '">' +
      '<div class="rt-card__head"><span class="rt-card__swatch" style="background:' + routeColor(i) + '"></span>' + tags.join('') + '</div>' +
      '<div class="rt-card__nums"><b>' + dur(r.min) + '</b><span>' + r.km.toFixed(1) + ' กม.</span>' + state + '</div>' +
      (r.hits.length ? '<ol class="rt-hits">' + r.hits.map(hitRow).join('') + '</ol>' : '') +
      (i === R.sel ? '<a class="btn rt-nav" href="' + gmaps(r) + '" target="_blank" rel="noopener">นำทางด้วย Google Maps</a>' : '') +
    '</article>';
  }

  function routeColor(i) { return [css('accent'), '#7b61ff', '#8a97a3'][i] || '#8a97a3'; }

  function render() {
    $('result').innerHTML = verdict() + R.routes.map(card).join('');
    draw();
  }

  function draw() {
    routeLayer.clearLayers();
    hitLayer.clearLayers();
    // Unselected routes first so the selected one sits on top.
    R.routes.map(function (r, i) { return i; }).sort(function (x, y) { return (x === R.sel) - (y === R.sel); }).forEach(function (i) {
      var r = R.routes[i], sel = i === R.sel;
      if (sel) L.polyline(r.pts, { color: '#fff', weight: 10, opacity: 0.9, interactive: false }).addTo(routeLayer);
      L.polyline(r.pts, { color: routeColor(i), weight: sel ? 6 : 5, opacity: sel ? 1 : 0.55, dashArray: sel ? null : '8 8' })
        .on('click', function () { select(i); }).addTo(routeLayer);
    });
    var r = R.routes[R.sel];
    r.hits.forEach(function (h) {
      var s = h.it.sev;
      L.circleMarker([h.it.lat, h.it.lng], { radius: s.rank >= 3 ? 10 : 8, color: '#fff', weight: 2.5, fillColor: css(s.color === 'low' ? 'low' : s.color), fillOpacity: 1 })
        .bindTooltip('<b>' + esc(s.label) + '</b><br>' + esc(h.it.title) + '<br>' + esc(s.advice), { direction: 'top', offset: [0, -8] })
        .addTo(hitLayer);
    });
    map.fitBounds(L.latLngBounds(R.routes.reduce(function (a, x) { return a.concat(x.pts); }, [])), { padding: [30, 30] });
  }

  function select(i) {
    if (i === R.sel) return;
    R.sel = i;
    $('result').innerHTML = verdict() + R.routes.map(card).join('');
    draw();
  }

  // Google recalculates its own route, so pin a few points from ours to keep it on the same roads.
  function gmaps(r) {
    var ll = function (p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); };
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + R.a.lat + ',' + R.a.lng + '&destination=' + R.b.lat + ',' + R.b.lng;
    if (r.kind !== 'normal') {
      var n = r.pts.length;
      url += '&waypoints=' + encodeURIComponent([0.25, 0.5, 0.75].map(function (f) { return ll(r.pts[Math.floor(n * f)]); }).join('|'));
    }
    return url;
  }

  function say(msg) {
    $('result').innerHTML = '<div class="rt-verdict rt-verdict--info"><span>' + esc(msg) + '</span></div>';
  }

  // ---------- inputs ----------
  function setPoint(which, p) {
    R[which] = p;
    $(which === 'a' ? 'from' : 'to').value = p ? p.label : '';
    pin(which, p);
    if (p && !(R.a && R.b)) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 11));
  }

  function suggest(input, list, which) {
    var timer, last = '';
    input.addEventListener('input', function () {
      R[which] = null;
      pin(which, null);
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(function () {
        last = q;
        geocode(q).then(function (res) {
          if (q !== last) return;
          list._res = res;
          list.innerHTML = res.length ? res.map(function (p, i) {
            return '<li role="option" data-i="' + i + '"><b>' + esc(p.label) + '</b>' + (p.sub ? '<span>' + esc(p.sub) + '</span>' : '') + '</li>';
          }).join('') : '<li class="rt-sug__none">ไม่พบสถานที่ ลองพิมพ์ชื่อเขต อำเภอ หรือแตะบนแผนที่</li>';
          list.hidden = false;
        }).catch(function () { list.hidden = true; });
      }, 350);
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-i]');
      if (!li) return;
      e.preventDefault();
      setPoint(which, list._res[+li.dataset.i]);
      list.hidden = true;
      if (which === 'a') $('to').focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !list.hidden && list._res && list._res.length) {
        e.preventDefault();
        setPoint(which, list._res[0]);
        list.hidden = true;
        if (which === 'a') $('to').focus(); else if (R.a) plan();
      }
      if (e.key === 'Escape') list.hidden = true;
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
  }

  function gps() {
    var btn = $('from-gps');
    if (!navigator.geolocation) { say('เครื่องนี้หาตำแหน่งไม่ได้'); return; }
    btn.classList.add('is-loading');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-loading');
      setPoint('a', { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'ตำแหน่งของฉัน' });
      $('to').focus();
    }, function (err) {
      btn.classList.remove('is-loading');
      say(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง พิมพ์ต้นทางหรือแตะบนแผนที่แทน' : 'หาตำแหน่งไม่สำเร็จ');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function shareURL() {
    try {
      var q = new URLSearchParams({
        from: R.a.lat.toFixed(5) + ',' + R.a.lng.toFixed(5), fn: R.a.label,
        to: R.b.lat.toFixed(5) + ',' + R.b.lng.toFixed(5), tn: R.b.label, veh: R.veh
      });
      history.replaceState(null, '', '?' + q);
    } catch (e) {}
  }

  function fromURL() {
    var q = new URLSearchParams(location.search);
    var parse = function (v, label) {
      var m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v || '');
      return m ? { lat: +m[1], lng: +m[2], label: label || 'จุดที่เลือก' } : null;
    };
    var a = parse(q.get('from'), q.get('fn')), b = parse(q.get('to'), q.get('tn'));
    if (q.get('veh') === 'tall') { R.veh = 'tall'; document.querySelector('input[name="veh"][value="tall"]').checked = true; }
    if (a) setPoint('a', a);
    if (b) setPoint('b', b);
    if (a && b) plan();
  }

  // ---------- events ----------
  suggest($('from'), $('from-sug'), 'a');
  suggest($('to'), $('to-sug'), 'b');
  $('from-gps').addEventListener('click', gps);
  $('swap').addEventListener('click', function () {
    var a = R.a, b = R.b;
    setPoint('a', b);
    setPoint('b', a);
    if (R.a && R.b && R.routes.length) plan();
  });
  $('form').addEventListener('submit', function (e) { e.preventDefault(); if (!R.busy) plan(); });
  document.querySelectorAll('input[name="veh"]').forEach(function (el) {
    el.addEventListener('change', function () { R.veh = el.value; if (R.routes.length && !R.busy) plan(); });
  });
  map.on('click', function (e) {
    var p = { lat: e.latlng.lat, lng: e.latlng.lng, label: 'จุดที่เลือก (' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4) + ')' };
    setPoint(!R.a ? 'a' : 'b', p);
    if (R.a && R.b && !R.busy) plan();
  });
  $('result').addEventListener('click', function (e) {
    var c = e.target.closest('.rt-card');
    if (!c || e.target.closest('a')) return;
    select(+c.dataset.i);
    var hit = e.target.closest('.rt-hit');
    if (hit) map.setView([+hit.dataset.lat, +hit.dataset.lng], 15);
  });
  $('result').addEventListener('keydown', function (e) {
    var c = e.target.closest('.rt-card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(+c.dataset.i); }
  });
  $('theme').addEventListener('click', function () { F.toggleTheme(function () { if (R.routes.length) draw(); }); });

  function loadReports() {
    return F.load().then(function (items) {
      R.items = items;
      R.loadedAt = Date.now();
      var last = F.latest(items);
      var closed = items.filter(function (it) { return !it.stale && (it.sev.key === 'closed' || it.sev.key === 'small'); }).length;
      $('updated').textContent = 'ผ่านไม่ได้ ' + closed + ' จุด · ข้อมูลล่าสุด ' + (last ? F.stamp(last) : '–');
      $('live').className = 'live is-fresh';
      $('notice').hidden = true;
    }, function (err) {
      console.error(err);
      $('notice').hidden = false;
      $('notice').textContent = 'โหลดรายงานน้ำท่วมไม่สำเร็จ เส้นทางที่แสดงจะยังไม่ได้ตรวจน้ำท่วม';
      $('live').className = 'live is-stale';
      $('updated').textContent = 'โหลดรายงานไม่สำเร็จ';
    });
  }
  R.loaded = loadReports();

  fromURL();
})();
