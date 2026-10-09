// Shared by the report list (roads.js) and the route planner (route.js):
// loads flood reports, normalises them, and grades how risky each one is to drive through.
(function () {
  'use strict';

  // Longdo Traffic sends CORS headers, so the pages still work on a static host without server.mjs.
  var EVENT_SOURCES = ['/api/thai-roads', 'https://event.longdo.com/feed/json'];
  var BKK_SENSORS = '/api/roads';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); }

  // Feed times are Thai local time without a zone.
  function parseTH(s) { return s ? new Date(String(s).replace(' ', 'T') + '+07:00') : null; }
  function ago(d) {
    if (!d) return '';
    var m = Math.max(0, (Date.now() - d) / 60000);
    if (m < 60) return Math.round(m) + ' นาทีก่อน';
    if (m < 1440) return Math.floor(m / 60) + ' ชม. ก่อน';
    return Math.floor(m / 1440) + ' วันก่อน';
  }
  function when(d) {
    return d ? d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.' : '–';
  }
  function km(a, b) {
    var x = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111.32, y = (b.lat - a.lat) * 110.57;
    return Math.sqrt(x * x + y * y);
  }
  function dist(d) { return d < 1 ? Math.round(d * 100) * 10 + ' ม.' : d < 10 ? d.toFixed(1) + ' กม.' : Math.round(d) + ' กม.'; }

  // ---------- parse ----------
  function fromEvent(e) {
    var title = e.title || '';
    var desc = e.description || '';
    var all = title + ' ' + desc;
    var status = /ผ่านไม่ได้|ไม่สามารถผ่านได้|ปิดการจราจร/.test(all) ? 'closed'
      : /ผ่านได้/.test(title) ? 'open' : 'report';
    var prov = (desc.match(/จ\.\s*([^\s,()]+)/) || title.match(/จ\.\s*([^\s,()]+)/) || [])[1] || '';
    var amp = (desc.match(/อ\.\s*([^\s,()]+)/) || [])[1];
    var kmPost = (desc.match(/กม\.\s*ที่\s*([\d+]+\s*-\s*[\d+]+|[\d+]+)/) || [])[1];
    var place = [kmPost ? 'กม. ' + kmPost.replace(/\s+/g, '') : '', amp ? 'อ.' + amp : '', prov ? 'จ.' + prov : ''].filter(Boolean).join(' · ');
    // Highway reports rarely give a depth; use one only when the text states it in centimetres.
    var depth = (all.match(/(?:ลึก|ระดับน้ำ|สูง)\D{0,12}(\d{1,3})\s*(?:ซม|ซ\.ม|เซนติเมตร|cm)/i) || [])[1];
    return {
      id: 'e' + e.eid,
      status: status,
      title: title.replace(/\s*\((ผ่านได้|ผ่านไม่ได้)\)\s*$/, ''),
      place: place || desc.split('\n')[0].slice(0, 90),
      detail: desc,
      small: /รถเล็ก/.test(all) && status === 'closed' ? 'รถเล็กผ่านไม่ได้' : '',
      depthCm: depth ? +depth : null,
      prov: prov,
      lat: +e.latitude, lng: +e.longitude,
      start: parseTH(e.start),
      source: e.contributor === 'DOH Admin' ? 'กรมทางหลวง' : 'ผู้ใช้ Longdo Traffic'
    };
  }

  function fromSensor(r) {
    return {
      id: 's' + r.code,
      status: 'sensor',
      title: r.name,
      place: [r.kind === 2 ? 'อุโมงค์' : '', r.district ? 'เขต' + r.district : '', 'จ.กรุงเทพมหานคร'].filter(Boolean).join(' · '),
      detail: '',
      depth: r.grp === 2 && r.depth >= 20 ? '≥20' : r.depth,
      depthCm: r.depth,
      wet: r.level,
      prov: 'กรุงเทพมหานคร',
      lat: r.lat, lng: r.lng,
      start: parseTH(r.since || r.measured_at),
      source: 'เซ็นเซอร์ สำนักการระบายน้ำ กทม.'
    };
  }

  // ---------- risk ----------
  // color: crit = do not pass / 20 cm+, warn = 10-20 cm or passable with care, low = under 10 cm, unk = unconfirmed.
  // block says which vehicles the route planner should steer around this point.
  function severity(it) {
    var d = it.depthCm;
    if (it.status === 'closed' && !it.small) {
      return { key: 'closed', color: 'crit', rank: 4, label: 'ผ่านไม่ได้', advice: 'ห้ามผ่าน ควรใช้เส้นทางอื่น', block: { small: true, tall: true } };
    }
    if (it.status === 'closed') {
      return { key: 'small', color: 'crit', rank: 3, label: 'รถเล็กผ่านไม่ได้', advice: 'รถเล็กไม่ควรผ่าน · รถสูงผ่านได้ด้วยความระวัง', block: { small: true, tall: false } };
    }
    if (d != null && d >= 20) {
      return { key: 'deep', color: 'crit', rank: 3, label: 'น้ำลึก ' + (it.status === 'sensor' && it.depth === '≥20' ? '≥20' : d) + ' ซม.', advice: 'รถเล็กไม่ควรผ่าน · รถสูงขับช้ามาก', block: { small: true, tall: false } };
    }
    if (d != null && d >= 10) {
      return { key: 'mid', color: 'warn', rank: 2, label: 'น้ำลึก ' + d + ' ซม.', advice: 'ขับช้า รถเล็กระวังน้ำเข้าเครื่อง', block: { small: false, tall: false } };
    }
    if (d != null && d > 0) {
      return { key: 'low', color: 'low', rank: 1, label: 'น้ำ ' + d + ' ซม.', advice: 'ผ่านได้ ขับช้า', block: { small: false, tall: false } };
    }
    if (it.status === 'open' || it.status === 'sensor') {
      return { key: 'open', color: 'warn', rank: 2, label: 'ผ่านได้ ระวัง', advice: 'มีน้ำบนถนน ขับช้า เว้นระยะ', block: { small: false, tall: false } };
    }
    return { key: 'report', color: 'unk', rank: 1, label: 'ยังไม่ยืนยัน', advice: 'มีรายงานจากผู้ใช้ เผื่อเวลาเดินทาง', block: { small: false, tall: false } };
  }

  // ---------- load ----------
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function loadEvents(i) {
    i = i || 0;
    return getJSON(EVENT_SOURCES[i]).then(function (d) {
      if (!Array.isArray(d)) throw new Error('bad payload');
      return d;
    }, function (err) {
      if (i + 1 < EVENT_SOURCES.length) return loadEvents(i + 1);
      throw err;
    });
  }

  function load() {
    var events = loadEvents().then(function (d) {
      return d.filter(function (e) { return e.icon === 'flood' || String(e.type) === '6'; }).map(fromEvent);
    });
    // Bangkok road sensors are a bonus; the pages work without them.
    var sensors = getJSON(BKK_SENSORS).then(function (d) {
      return (d.roads || []).filter(function (r) { return r.level === 'flood' || r.level === 'slight'; }).map(fromSensor);
    }, function () { return []; });
    return Promise.all([events, sensors]).then(function (res) {
      var items = res[0].concat(res[1]);
      items.forEach(function (it) { it.sev = severity(it); });
      return items;
    });
  }

  function toggleTheme(after) {
    var t = document.documentElement.dataset.theme;
    var dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    if (after) after();
  }

  window.Floods = {
    load: load, severity: severity, getJSON: getJSON, toggleTheme: toggleTheme,
    esc: esc, css: css, parseTH: parseTH, ago: ago, when: when, km: km, dist: dist
  };
})();
