/* Our Spending — PWA logic (Supabase-backed, offline-tolerant) */
(function () {
  'use strict';

  var CATS = [
    { id: 'food',    name: 'Food & Dining', em: '\uD83C\uDF5C' },
    { id: 'grocery', name: 'Groceries',     em: '\uD83D\uDED2' },
    { id: 'fuel',    name: 'Fuel / Car',    em: '\u26FD' },
    { id: 'transit', name: 'Transport',     em: '\uD83D\uDE87' },
    { id: 'bills',   name: 'Bills',         em: '\uD83E\uDDFE' },
    { id: 'shop',    name: 'Shopping',      em: '\uD83D\uDECD\uFE0F' },
    { id: 'health',  name: 'Health',        em: '\uD83D\uDC8A' },
    { id: 'fun',     name: 'Fun',           em: '\uD83C\uDF89' },
    { id: 'home',    name: 'Home',          em: '\uD83C\uDFE0' },
    { id: 'other',   name: 'Other',         em: '\uD83D\uDCA1' }
  ];
  var catById = function (id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i];
    return CATS[CATS.length - 1];
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  };

  var sb = null;
  var expenses = [];                 // rows from server (+ optimistic temps)
  var period = 'month';
  var cursor = new Date();
  var pick = { cat: 'food', who: 'you' };
  var settings = loadSettings();
  var online = navigator.onLine;
  var syncing = false;

  function loadSettings() {
    var def = { cur: 'S$', you: 'Name 1', partner: 'Name 2', pin: '' };
    try {
      var s = JSON.parse(localStorage.getItem('os_settings') || '{}');
      return Object.assign(def, s);
    } catch (e) { return def; }
  }
  function persistSettings() {
    try { localStorage.setItem('os_settings', JSON.stringify(settings)); } catch (e) {}
  }
  function queueGet() {
    try { return JSON.parse(localStorage.getItem('os_queue') || '[]'); } catch (e) { return []; }
  }
  function queueSet(q) {
    try { localStorage.setItem('os_queue', JSON.stringify(q)); } catch (e) {}
  }

  var fmt = function (n) {
    return settings.cur + Number(n || 0).toLocaleString(undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ---------- config / boot ---------- */
  function configured() {
    var c = window.APP_CONFIG || {};
    return c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
           c.SUPABASE_URL.indexOf('PASTE_') === -1 &&
           c.SUPABASE_ANON_KEY.indexOf('PASTE_') === -1;
  }

  function showSetupNeeded() {
    $('app').innerHTML =
      '<header><div><div class="title">Our Spending</div>' +
      '<div class="subtitle">Almost there</div></div></header>' +
      '<div class="setup"><h3>One-time setup needed</h3>' +
      '<p>This app needs your free Supabase database. Open <code>SETUP.md</code> and follow ' +
      'Steps 1&ndash;3, then paste your two keys into <code>config.js</code> and reload.</p>' +
      '<p style="margin-top:12px;color:var(--ink-soft)">It takes about 5 minutes and is completely free.</p></div>';
  }

  function gateThenStart() {
    if (settings.pin) {
      $('app').insertAdjacentHTML('afterend',
        '<div class="lock" id="lock"><h2>Enter PIN</h2>' +
        '<input id="pinIn" inputmode="numeric" maxlength="4" type="password" autocomplete="off"></div>');
      var inp = $('pinIn');
      inp.focus();
      inp.addEventListener('input', function () {
        if (inp.value.length === 4) {
          if (inp.value === settings.pin) {
            var l = $('lock'); if (l) l.remove();
            start();
          } else { inp.value = ''; inp.placeholder = 'wrong'; }
        }
      });
    } else {
      start();
    }
  }

  function start() {
    try {
      sb = window.supabase.createClient(
        window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
    } catch (e) {
      $('app').innerHTML = '<div class="setup"><h3>Connection problem</h3><p>' +
        esc(e.message) + '</p></div>';
      return;
    }
    fetchAll(true);
    subscribeRealtime();
    setInterval(function () { if (online) fetchAll(false); }, 60000);
    window.addEventListener('online', function () { online = true; flushQueue(); fetchAll(false); render(); });
    window.addEventListener('offline', function () { online = false; render(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && online) { flushQueue(); fetchAll(false); }
    });
    flushQueue();
  }

  /* ---------- data ---------- */
  function fetchAll(showSpinner) {
    if (showSpinner && expenses.length === 0) {
      $('app').innerHTML = '<div class="loading"><div class="spin"></div>Loading your spending\u2026</div>';
    }
    syncing = true; render();
    sb.from('expenses').select('*').order('spent_on', { ascending: false })
      .order('created_at', { ascending: false })
      .then(function (res) {
        syncing = false;
        if (res.error) {
          online = navigator.onLine;
          if (expenses.length === 0)
            $('app').innerHTML = '<div class="setup"><h3>Could not load data</h3><p>' +
              esc(res.error.message) +
              '</p><p style="margin-top:10px;color:var(--ink-soft)">Check the SQL step in SETUP.md (the <code>expenses</code> table and its policy).</p></div>';
          render();
          return;
        }
        online = true;
        var server = res.data || [];
        var q = queueGet();
        // keep any not-yet-synced local rows visible on top
        expenses = q.map(function (item) {
          return { id: item._tmp, amount: item.amount, category: item.category,
                   paid_by: item.paid_by, note: item.note, spent_on: item.spent_on, _pending: true };
        }).concat(server);
        render();
      });
  }

  function subscribeRealtime() {
    try {
      sb.channel('expenses-rt')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' },
            function () { if (online) fetchAll(false); })
        .subscribe();
    } catch (e) { /* polling fallback already running */ }
  }

  function flushQueue() {
    if (!sb || !online) return;
    var q = queueGet();
    if (q.length === 0) return;
    var item = q[0];
    sb.from('expenses').insert({
      amount: item.amount, category: item.category, paid_by: item.paid_by,
      note: item.note, spent_on: item.spent_on
    }).then(function (res) {
      if (!res.error) {
        var rest = queueGet(); rest.shift(); queueSet(rest);
        if (rest.length) flushQueue(); else fetchAll(false);
      }
    });
  }

  /* ---------- period helpers ---------- */
  function inPeriod(dateStr) {
    if (period === 'all') return true;
    var d = new Date(dateStr + 'T00:00:00');
    if (period === 'day') return ymd(d) === ymd(cursor);
    if (period === 'month') return d.getFullYear() === cursor.getFullYear() && d.getMonth() === cursor.getMonth();
    return d.getFullYear() === cursor.getFullYear();
  }
  function periodLabel() {
    if (period === 'day') return ymd(cursor) === ymd(new Date()) ? 'Today'
      : cursor.getDate() + ' ' + MON[cursor.getMonth()] + ' ' + cursor.getFullYear();
    if (period === 'month') return MON[cursor.getMonth()] + ' ' + cursor.getFullYear();
    if (period === 'all') return 'All time';
    return String(cursor.getFullYear());
  }
  window.shift = function (dir) {
    var c = new Date(cursor);
    if (period === 'day') c.setDate(c.getDate() + dir);
    if (period === 'month') c.setMonth(c.getMonth() + dir);
    if (period === 'year') c.setFullYear(c.getFullYear() + dir);
    cursor = c; render();
  };
  window.setPeriod = function (p) { period = p; cursor = new Date(); render(); };

  /* ---------- render ---------- */
  function render() {
    if (!sb) return;
    var list = expenses.filter(function (e) { return inPeriod(e.spent_on); })
      .sort(function (a, b) {
        if (a.spent_on !== b.spent_on) return a.spent_on < b.spent_on ? 1 : -1;
        return (b.created_at || '') < (a.created_at || '') ? -1 : 1;
      });
    var total = list.reduce(function (s, e) { return s + Number(e.amount); }, 0);
    var youSum = list.filter(function (e) { return e.paid_by === settings.you; })
      .reduce(function (s, e) { return s + Number(e.amount); }, 0);
    var parSum = list.filter(function (e) { return e.paid_by === settings.partner; })
      .reduce(function (s, e) { return s + Number(e.amount); }, 0);

    var byCat = {};
    list.forEach(function (e) { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount); });
    var catRows = Object.keys(byCat).map(function (k) { return [k, byCat[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });

    var catHtml = catRows.map(function (r) {
      var c = catById(r[0]), pct = total ? Math.round(r[1] / total * 100) : 0;
      return '<div class="cat"><div class="cat-top">' +
        '<span class="cat-name"><span class="em">' + c.em + '</span>' + c.name + '</span>' +
        '<span><span class="cat-amt">' + fmt(r[1]) + '</span><span class="cat-pct">' + pct + '%</span></span>' +
        '</div><div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');

    var listHtml = '', lastDate = '';
    list.forEach(function (e) {
      if (e.spent_on !== lastDate) {
        var d = new Date(e.spent_on + 'T00:00:00');
        listHtml += '<div class="day-head">' +
          (ymd(new Date()) === e.spent_on ? 'Today'
            : d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear()) + '</div>';
        lastDate = e.spent_on;
      }
      var c = catById(e.category);
      var sub = (e.note ? esc(e.note) + ' \u00B7 ' : '') + 'paid by ' + esc(e.paid_by) +
        (e._pending ? ' \u00B7 syncing\u2026' : '');
      listHtml += '<div class="entry' + (e._pending ? ' pending' : '') + '">' +
        '<div class="ico">' + c.em + '</div>' +
        '<div class="mid"><div class="e-cat">' + c.name + '</div>' +
        '<div class="e-sub">' + sub + '</div></div>' +
        '<div class="e-amt">' + fmt(e.amount) + '</div>' +
        (e._pending ? '<button class="del" style="visibility:hidden">\u2715</button>'
          : '<button class="del" onclick="delExp(\'' + e.id + '\')">\u2715</button>') +
        '</div>';
    });

    var body = list.length === 0
      ? '<div class="empty"><div class="big">\uD83E\uDE99</div><p>No expenses for ' +
        periodLabel().toLowerCase() + ' yet.<br>Tap <b>Add expense</b> to start.</p></div>'
      : '<div class="sec-h">Where it went</div>' + catHtml +
        '<div class="sec-h">All expenses</div>' + listHtml;

    var statusDot = !online ? '<span class="dot off"></span> offline'
      : (syncing ? '<span class="dot sync"></span> syncing' : '<span class="dot"></span> live');

    $('app').innerHTML =
      '<header><div><div class="title">Our Spending</div>' +
      '<div class="subtitle">' + esc(settings.you) + ' &amp; ' + esc(settings.partner) +
      ' &nbsp;&middot;&nbsp; ' + statusDot + '</div></div>' +
      '<button class="gear" onclick="openSettings()">\u2699</button></header>' +

      '<div class="periods">' +
      '<button class="' + (period === 'day' ? 'on' : '') + '" onclick="setPeriod(\'day\')">Day</button>' +
      '<button class="' + (period === 'month' ? 'on' : '') + '" onclick="setPeriod(\'month\')">Month</button>' +
      '<button class="' + (period === 'year' ? 'on' : '') + '" onclick="setPeriod(\'year\')">Year</button>' +
      '<button class="' + (period === 'all' ? 'on' : '') + '" onclick="setPeriod(\'all\')">All</button></div>' +

      '<div class="total-card"><div class="nav-row">' +
      (period === 'all' ? '<span></span>' : '<button onclick="shift(-1)">\u2039</button>') +
      '<span class="nav-label">' + periodLabel() + '</span>' +
      (period === 'all' ? '<span></span>' : '<button onclick="shift(1)">\u203A</button>') +
      '</div><div class="total-amt">' + fmt(total) + '</div>' +
      '<div class="total-meta">' + list.length + ' ' + (list.length === 1 ? 'expense' : 'expenses') +
      (period === 'all' ? ' in total' : ' this ' + period) + '</div></div>' +

      '<div class="split">' +
      '<div class="who"><div class="lbl">' + esc(settings.you) + ' paid</div><div class="val">' + fmt(youSum) + '</div></div>' +
      '<div class="who"><div class="lbl">' + esc(settings.partner) + ' paid</div><div class="val">' + fmt(parSum) + '</div></div>' +
      '</div>' + body;

    $('fab').style.display = 'flex';
  }

  /* ---------- add / delete ---------- */
  function buildChips() {
    $('catChips').innerHTML = CATS.map(function (c) {
      return '<button class="chip ' + (pick.cat === c.id ? 'on' : '') +
        '" onclick="pickCat(\'' + c.id + '\')">' + c.em + ' ' + c.name + '</button>';
    }).join('');
    $('whoToggle').innerHTML =
      '<button class="' + (pick.who === 'you' ? 'on' : '') + '" onclick="pickWho(\'you\')">' + esc(settings.you) + '</button>' +
      '<button class="' + (pick.who === 'partner' ? 'on' : '') + '" onclick="pickWho(\'partner\')">' + esc(settings.partner) + '</button>';
  }
  window.pickCat = function (id) { pick.cat = id; buildChips(); };
  window.pickWho = function (w) { pick.who = w; buildChips(); };

  window.openSheet = function () {
    $('curSign').innerHTML = settings.cur;
    $('dt').value = ymd(new Date());
    $('amt').value = ''; $('note').value = '';
    pick = { cat: 'food', who: 'you' };
    buildChips();
    $('scrim').classList.add('show');
    $('addSheet').classList.add('show');
    setTimeout(function () { $('amt').focus(); }, 300);
  };
  window.openSettings = function () {
    var sel = $('setCur'); sel.value = settings.cur; if (!sel.value) sel.value = 'S$';
    $('setYou').value = settings.you;
    $('setPartner').value = settings.partner;
    $('setPin').value = settings.pin || '';
    $('scrim').classList.add('show');
    $('setSheet').classList.add('show');
  };
  window.closeAll = function () {
    $('scrim').classList.remove('show');
    $('addSheet').classList.remove('show');
    $('setSheet').classList.remove('show');
    $('expSheet').classList.remove('show');
  };

  window.saveExpense = function () {
    var raw = parseFloat(String($('amt').value).replace(/[^0-9.]/g, ''));
    if (!raw || raw <= 0) { toast('Enter an amount'); $('amt').focus(); return; }
    var row = {
      amount: Math.round(raw * 100) / 100,
      category: pick.cat,
      paid_by: pick.who === 'you' ? settings.you : settings.partner,
      note: $('note').value.trim().slice(0, 60),
      spent_on: $('dt').value || ymd(new Date())
    };
    $('saveBtn').disabled = true;
    closeAll();

    if (!online) {
      var tmp = 'tmp_' + Date.now();
      var q = queueGet(); q.push(Object.assign({ _tmp: tmp }, row)); queueSet(q);
      expenses.unshift(Object.assign({ id: tmp, _pending: true,
        created_at: new Date().toISOString() }, row));
      $('saveBtn').disabled = false;
      render();
      toast('Saved offline \u2014 will sync');
      return;
    }

    sb.from('expenses').insert(row).then(function (res) {
      $('saveBtn').disabled = false;
      if (res.error) {
        var tmp2 = 'tmp_' + Date.now();
        var q2 = queueGet(); q2.push(Object.assign({ _tmp: tmp2 }, row)); queueSet(q2);
        expenses.unshift(Object.assign({ id: tmp2, _pending: true,
          created_at: new Date().toISOString() }, row));
        render();
        toast('Saved offline \u2014 will sync');
      } else {
        fetchAll(false);
        toast('Saved \u2713');
      }
    });
  };

  window.delExp = function (id) {
    if (!confirm('Delete this expense?')) return;
    if (!online) { toast('Delete needs a connection'); return; }
    sb.from('expenses').delete().eq('id', id).then(function (res) {
      if (res.error) { toast('Could not delete'); return; }
      expenses = expenses.filter(function (e) { return String(e.id) !== String(id); });
      render(); toast('Deleted');
    });
  };

  window.saveSettings = function () {
    var sel = $('setCur');
    settings.cur = sel.options[sel.selectedIndex].value || 'S$';
    settings.you = $('setYou').value.trim().slice(0, 14) || 'Name 1';
    settings.partner = $('setPartner').value.trim().slice(0, 14) || 'Name 2';
    var pin = $('setPin').value.replace(/[^0-9]/g, '').slice(0, 4);
    settings.pin = (pin.length === 4) ? pin : '';
    persistSettings();
    closeAll();
    render();
    toast('Settings saved \u2713');
  };

  window.eraseAll = function () {
    if (!confirm('Erase ALL expenses for BOTH of you, permanently? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Everything will be gone.')) return;
    sb.from('expenses').delete().neq('id', '00000000-0000-0000-0000-000000000000')
      .then(function (res) {
        if (res.error) { toast('Could not erase'); return; }
        expenses = []; queueSet([]); closeAll(); render(); toast('All data erased');
      });
  };

  /* ---------- export ---------- */
  function buildCsv() {
    var rows = [['Date', 'Category', 'Paid by', 'Note', 'Amount']];
    expenses.slice().sort(function (a, b) { return a.spent_on < b.spent_on ? -1 : 1; })
      .forEach(function (e) {
        var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
        rows.push([e.spent_on, catById(e.category).name, e.paid_by, e.note || '',
          Number(e.amount).toFixed(2)].map(q).join(','));
      });
    rows[0] = rows[0].join(',');
    return rows.join('\r\n');
  }
  window.openExport = function () {
    $('csvOut').value = expenses.length ? buildCsv() : 'No expenses yet.';
    $('setSheet').classList.remove('show');
    $('scrim').classList.add('show');
    $('expSheet').classList.add('show');
  };
  window.downloadCsv = function () {
    if (!expenses.length) { toast('Nothing to export'); return; }
    try {
      var blob = new Blob(['\uFEFF' + buildCsv()], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'expenses-' + ymd(new Date()) + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Downloaded \u2713');
    } catch (e) { toast('Download blocked \u2014 copy instead'); }
  };
  window.copyCsv = function () {
    var t = $('csvOut');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t.value).then(
        function () { toast('Copied \u2713'); },
        function () { t.focus(); t.select(); toast('Select all & copy'); });
    } else { t.focus(); t.select(); toast('Select all & copy'); }
  };

  /* ---------- toast ---------- */
  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------- go ---------- */
  if (!configured()) { showSetupNeeded(); }
  else if (!window.supabase || !window.supabase.createClient) {
    $('app').innerHTML = '<div class="setup"><h3>Library not loaded</h3>' +
      '<p>Could not load the database library. Check that <code>vendor/supabase.js</code> was uploaded.</p></div>';
  } else { gateThenStart(); }

})();
