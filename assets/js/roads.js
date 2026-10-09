(function () {
  'use strict';

  var F = window.Floods;
  var REFRESH_MS = 2 * 60 * 1000;
  var PAGE = 20;

  var STATUS = {
    closed: { label: 'ผ่านไม่ได้', order: 0 },
    open: { label: 'ผ่านได้ ระวัง', order: 1 },
    sensor: { label: 'เซ็นเซอร์วัดน้ำ', order: 2 },
    report: { label: 'ยังไม่ยืนยัน', order: 3 }
  };

  var S = { items: [], tab: 'all', q: '', prov: '', shown: PAGE, me: null, open: null, markers: {}, fitted: false };
  var $ = function (id) { return document.getElementById(id); };

  var esc = F.esc, css = F.css, ago = F.ago, when = F.when, km = F.km, dist = F.dist;
  function norm(s) { return String(s || '').toLowerCase().replace(/ถนน/g, 'ถ.').replace(/ทางหลวงหมายเลข/g, 'ทล.').replace(/\s+/g, ''); }

  // ---------- filter ----------
  function base() {
    var terms = S.q.split(/[\s,]+/).map(norm).filter(Boolean);
    return S.items.filter(function (it) {
      if (S.prov && it.prov !== S.prov) return false;
      if (!terms.length) return true;
      var text = it._text || (it._text = norm(it.title + ' ' + it.place + ' ' + it.detail));
      return terms.every(function (t) { return text.indexOf(t) !== -1; });
    });
  }

  function visible() {
    var list = base().filter(function (it) { return S.tab === 'all' || it.status === S.tab; });
    if (S.me) {
      list.forEach(function (it) { it._km = km(S.me, it); });
      return list.sort(function (a, b) { return a._km - b._km; });
    }
    return list.sort(function (a, b) {
      return (STATUS[a.status].order - STATUS[b.status].order) || ((b.start || 0) - (a.start || 0));
    });
  }

  // ---------- map ----------
  var map = L.map('map', { zoomControl: true }).setView([13.4, 101.0], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);
  var meMarker = null;

  function color(it) {
    if (it.status === 'closed') return css('crit');
    if (it.status === 'open') return css('warn');
    if (it.status === 'sensor') return it.wet === 'flood' ? css('crit') : css('warn');
    return css('unk');
  }

  function drawMap(list) {
    layer.clearLayers();
    S.markers = {};
    // Draw the most serious last so they sit on top.
    list.slice().reverse().forEach(function (it) {
      if (!isFinite(it.lat) || !isFinite(it.lng)) return;
      var m = it.status === 'sensor'
        ? L.marker([it.lat, it.lng], { icon: L.divIcon({ className: '', html: '<i class="rr-sq" style="background:' + color(it) + '"></i>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
        : L.circleMarker([it.lat, it.lng], { radius: it.status === 'closed' ? 9 : 7, color: css('surface'), weight: 2, fillColor: color(it), fillOpacity: 0.95 });
      m.bindTooltip(esc(it.title), { direction: 'top', offset: [0, -6] });
      m.on('click', function () { openItem(it.id, true); });
      m.addTo(layer);
      S.markers[it.id] = m;
    });
  }

  function fit(list) {
    var pts = list.filter(function (it) { return isFinite(it.lat); }).map(function (it) { return [it.lat, it.lng]; });
    if (S.me) pts.push([S.me.lat, S.me.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
  }

  // ---------- list ----------
  function pill(it) {
    if (it.status === 'sensor') {
      return '<span class="rr-pill rr-pill--' + (it.wet === 'flood' ? 'closed' : 'open') + '">น้ำ ' + esc(it.depth) + ' ซม.</span>';
    }
    return '<span class="rr-pill rr-pill--' + it.status + '">' + STATUS[it.status].label + '</span>';
  }

  function row(it) {
    var isOpen = S.open === it.id;
    var gmaps = 'https://www.google.com/maps/search/?api=1&query=' + it.lat + ',' + it.lng;
    return '<li class="rr-item rr-item--' + it.status + (isOpen ? ' is-open' : '') + '" data-id="' + it.id + '">' +
      '<button type="button" class="rr-item__head" aria-expanded="' + isOpen + '">' +
        '<span class="rr-item__top">' + pill(it) +
          (it.small ? '<span class="rr-small">' + it.small + '</span>' : '') +
          (S.me && it._km != null ? '<span class="rr-dist">ห่าง ' + dist(it._km) + '</span>' : '') +
        '</span>' +
        '<span class="rr-item__title">' + esc(it.title) + '</span>' +
        '<span class="rr-item__place">' + esc(it.place) + '</span>' +
        '<span class="rr-item__time">' + (it.status === 'sensor' ? 'มีน้ำ' : 'รายงาน') + 'ตั้งแต่ ' + when(it.start) + ' · ' + ago(it.start) + '</span>' +
      '</button>' +
      (isOpen ? '<div class="rr-item__more">' +
        (it.detail ? '<p class="rr-item__desc">' + esc(it.detail).replace(/\n+/g, '<br>') + '</p>' : '') +
        '<p class="muted small">ที่มา: ' + esc(it.source) + '</p>' +
        '<a class="btn rr-nav" href="' + gmaps + '" target="_blank" rel="noopener">เปิดใน Google Maps</a>' +
      '</div>' : '') +
    '</li>';
  }

  function renderList(list) {
    var shown = list.slice(0, S.shown);
    $('list').innerHTML = shown.length ? shown.map(row).join('')
      : '<li class="rr-empty">' + (S.items.length ? 'ไม่พบรายงานที่ตรงกับเงื่อนไข' : 'ตอนนี้ไม่มีรายงานน้ำท่วมถนน') +
        '<br><span class="small">ไม่มีรายงานไม่ได้แปลว่าถนนแห้งเสมอไป</span></li>';
    $('count').textContent = list.length ? 'แสดง ' + shown.length + ' จาก ' + list.length + ' จุด' + (S.me ? ' เรียงจากใกล้ไปไกล' : ' เรียงจากผ่านไม่ได้ก่อน') : '';
    $('more').hidden = shown.length >= list.length;
    $('more').textContent = 'แสดงเพิ่ม (อีก ' + (list.length - shown.length) + ')';
  }

  function renderSummary() {
    var n = { closed: 0, open: 0, report: 0, sensor: 0 };
    var provs = {};
    S.items.forEach(function (it) { n[it.status]++; if (it.prov) provs[it.prov] = (provs[it.prov] || 0) + 1; });
    var np = Object.keys(provs).length;
    $('sum-title').innerHTML = S.items.length
      ? 'มีรายงานน้ำท่วมถนน <b>' + S.items.length + ' จุด</b> ใน ' + np + ' จังหวัด'
      : 'ตอนนี้ไม่มีรายงานน้ำท่วมถนน';
    $('n-closed').textContent = n.closed;
    $('n-open').textContent = n.open;
    $('n-prov').textContent = np;
    $('t-all').textContent = S.items.length;
    $('t-closed').textContent = n.closed;
    $('t-open').textContent = n.open;
    $('t-report').textContent = n.report;

    // Province picker, most reports first; keep the current choice.
    var sel = $('prov');
    var cur = sel.value;
    sel.innerHTML = '<option value="">ทุกจังหวัด (' + np + ')</option>' + Object.keys(provs)
      .sort(function (a, b) { return provs[b] - provs[a] || a.localeCompare(b, 'th'); })
      .map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + ' (' + provs[p] + ')</option>'; }).join('');
    sel.value = provs[cur] ? cur : '';
    if (!provs[cur]) S.prov = '';
  }

  function render(refit) {
    var list = visible();
    drawMap(list);
    renderList(list);
    if (refit) fit(list);
  }

  function openItem(id, fromMap) {
    S.open = S.open === id && !fromMap ? null : id;
    var list = visible();
    var i = list.findIndex(function (it) { return it.id === id; });
    if (i >= S.shown) S.shown = i + 1;
    renderList(list);
    var it = list[i];
    if (!it) return;
    if (fromMap) {
      var el = document.querySelector('.rr-item[data-id="' + id + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (S.open && isFinite(it.lat)) {
      map.setView([it.lat, it.lng], Math.max(map.getZoom(), 12));
      if (window.matchMedia('(max-width: 900px)').matches) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---------- data ----------
  function refresh() {
    var btn = $('refresh');
    btn.classList.add('is-loading');
    return F.load().then(function (items) {
      var first = !S.items.length;
      S.items = items;
      renderSummary();
      render(first);
      $('notice').hidden = true;
      $('updated').textContent = 'อัปเดต ' + new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.';
      $('live').className = 'live is-fresh';
    }).catch(function (err) {
      console.error(err);
      $('notice').hidden = false;
      $('notice').textContent = 'โหลดรายงานไม่สำเร็จ ลองกดปุ่มโหลดใหม่อีกครั้ง';
      $('live').className = 'live is-stale';
      if (!S.items.length) { $('sum-title').textContent = 'โหลดรายงานไม่สำเร็จ'; $('list').innerHTML = ''; }
    }).then(function () { btn.classList.remove('is-loading'); });
  }

  // ---------- near me ----------
  function nearMe() {
    var btn = $('near'), span = btn.querySelector('span');
    if (S.me) { // second tap turns it off
      S.me = null;
      btn.classList.remove('is-on');
      span.textContent = 'ใกล้ฉัน';
      if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
      S.shown = PAGE;
      render(true);
      return;
    }
    var say = function (msg) { span.textContent = msg; setTimeout(function () { span.textContent = S.me ? 'ใกล้ฉัน ✓' : 'ใกล้ฉัน'; }, 3000); };
    if (!navigator.geolocation) { say('หาตำแหน่งไม่ได้'); return; }
    btn.classList.add('is-loading');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-loading');
      S.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      btn.classList.add('is-on');
      span.textContent = 'ใกล้ฉัน ✓';
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.marker([S.me.lat, S.me.lng], {
        icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        interactive: false, zIndexOffset: 1000
      }).addTo(map);
      S.shown = PAGE;
      var list = visible();
      drawMap(list);
      renderList(list);
      // Frame the user with the nearest few reports.
      var near = list.slice(0, 5).map(function (it) { return [it.lat, it.lng]; }).concat([[S.me.lat, S.me.lng]]);
      map.fitBounds(near, { padding: [40, 40], maxZoom: 12 });
    }, function (err) {
      btn.classList.remove('is-loading');
      say(err.code === 1 ? 'ไม่ได้รับอนุญาต' : 'หาตำแหน่งไม่สำเร็จ');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ---------- events ----------
  var typing;
  $('q').addEventListener('input', function (e) {
    clearTimeout(typing);
    typing = setTimeout(function () { S.q = e.target.value.trim(); S.shown = PAGE; S.open = null; render(true); }, 200);
  });
  $('prov').addEventListener('change', function (e) { S.prov = e.target.value; S.shown = PAGE; S.open = null; render(true); });
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    S.shown = PAGE;
    S.open = null;
    document.querySelectorAll('#tabs [data-tab]').forEach(function (x) {
      x.classList.toggle('is-on', x === b);
      x.setAttribute('aria-selected', x === b);
    });
    render(true);
  });
  $('list').addEventListener('click', function (e) {
    var head = e.target.closest('.rr-item__head');
    if (head) openItem(head.parentNode.dataset.id, false);
  });
  $('more').addEventListener('click', function () { S.shown += PAGE; renderList(visible()); });
  $('near').addEventListener('click', nearMe);
  $('refresh').addEventListener('click', refresh);
  $('theme').addEventListener('click', function () { F.toggleTheme(function () { drawMap(visible()); }); });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  refresh();
})();
