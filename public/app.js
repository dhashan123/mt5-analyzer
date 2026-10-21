/* mt5batch web analyzer
 *
 * A port of mt5batch/report.py + mt5batch/metrics.py to JavaScript, so a
 * Strategy Tester report can be analysed entirely in the browser. Nothing is
 * uploaded: the file is read with the File API and parsed here.
 *
 * The port is faithful, not approximate. The number formats, the label
 * matching and the trade reconstruction follow the Python implementation
 * exactly, because a tool that quietly disagrees with the batch harness
 * would be worse than no tool.
 */
var MT5 = (function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(v, dflt) { return (v === null || v === undefined || isNaN(v)) ? (dflt === undefined ? null : dflt) : v; }
  function fmt(v, spec) { return (v === null || v === undefined || isNaN(v)) ? '—' : spec.replace('%v', v); }
  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(v) { return (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(2) + '%'; }
  function count(v) { return (v === null || v === undefined || isNaN(v)) ? '—' : Math.round(v).toLocaleString('en-US'); }

  // ------------------------------------------------------------ decoding
  // MT5 writes the report as UTF-16 (usually LE, with a BOM). TextDecoder
  // does not auto-detect UTF-16, so the encoding is chosen explicitly.
  function readReportText(bytes) {
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    }
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  // -------------------------------------------------------------- parsing
  var ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  var CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  var TAG_RE = /<[^>]+>/g;

  function stripTags(s) {
    return String(s || '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  function rows(text) {
    var out = [];
    var m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(text)) !== null) {
      var cells = [], cm;
      CELL_RE.lastIndex = 0;
      while ((cm = CELL_RE.exec(m[1])) !== null) {
        var c = stripTags(cm[1]);
        if (c !== '') cells.push(c);
      }
      if (cells.length) out.push(cells);
    }
    return out;
  }

  // Parse a number the way MT5 renders it: space as thousands separator,
  // dot as decimal point. Missing stays missing — never zero.
  function parseNumber(text) {
    if (text === null || text === undefined) return null;
    var cleaned = String(text).replace(/ /g, ' ').replace(/−/g, '-');
    var m = cleaned.match(/-?\d+(?:[.,  ]\d+)*/);
    if (!m) return null;
    var raw = m[0].replace(/[  ]/g, '');
    if (raw.indexOf(',') >= 0 && raw.indexOf('.') >= 0) {
      raw = raw.replace(/,/g, '');
    } else if (raw.indexOf(',') >= 0) {
      var parts = raw.split('.');
      var tail = parts.pop();
      raw = (tail.length === 1 || tail.length === 2) ? parts.join('.') + '.' + tail : raw.replace(/,/g, '');
    }
    var v = parseFloat(raw);
    return isNaN(v) ? null : v;
  }

  function parsePercent(text) {
    if (!text) return null;
    var m = String(text).match(/(-?\d+(?:[.,]\d+)?)\s*%/);
    if (!m) return null;
    var v = parseFloat(m[1].replace(',', '.'));
    return isNaN(v) ? null : v;
  }

  function parseDuration(text) {
    if (!text) return null;
    var parts = String(text).trim().split(':');
    if (parts.length > 3) return null;
    var s = 0, ok = true;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+$/.test(parts[i])) { ok = false; break; }
      s = s * 60 + parseInt(parts[i], 10);
    }
    return ok ? s : null;
  }

  function parseDateTime(text) {
    if (!text) return null;
    var m = String(text).match(/^(\d{4})[.\-](\d{2})[.\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function parseReport(text) {
    var r = { settings: {}, inputs: {}, results: {}, orders: [], deals: [], warnings: [] };
    var all = rows(text);
    var section = null, inInputs = false;

    for (var i = 0; i < all.length; i++) {
      var row = all[i];
      var first = row[0];

      if (row.length === 1) {
        if (first === 'Settings' || first === 'Results') { section = first; inInputs = false; }
        else if (inInputs && first.indexOf('=') >= 0) {
          var p = first.split('='); r.inputs[p[0].trim()] = p.slice(1).join('=').trim();
        } else { inInputs = false; }
        continue;
      }

      if (/:$/.test(first)) {
        if (first.slice(0, -1) === 'Inputs') {
          inInputs = true;
          if (row[1] && row[1].indexOf('=') >= 0) {
            var q = row[1].split('='); r.inputs[q[0].trim()] = q.slice(1).join('=').trim();
          }
          continue;
        }
        if (inInputs && row[1] && row[1].indexOf('=') >= 0 && first.indexOf(' ') < 0) {
          var t = row[1].split('='); r.inputs[t[0].trim()] = t.slice(1).join('=').trim();
          continue;
        }
        inInputs = false;
        for (var k = 0; k + 1 < row.length; k += 2) {
          if (!/:$/.test(row[k])) break;
          var label = row[k].slice(0, -1), value = row[k + 1];
          if (section === 'Settings') { if (!(label in r.settings)) r.settings[label] = value; }
          else if (section === 'Results') { if (!(label in r.results)) r.results[label] = value; }
        }
        continue;
      }

      if (inInputs && row.length === 1 && first.indexOf('=') >= 0) {
        var u = first.split('='); r.inputs[u[0].trim()] = u.slice(1).join('=').trim();
        continue;
      }
      inInputs = false;

      if (first === 'Open Time' && row.length >= 6) { i = readOrders(all, i, r); continue; }
      if (first === 'Time' && row.length >= 5 && row[1] === 'Deal') { i = readDeals(all, i, r); continue; }
    }
    if (!Object.keys(r.results).length) r.warnings.push('no Results section found');
    return r;
  }

  function readOrders(all, index, r) {
    var i = index + 1;
    while (i < all.length) {
      var row = all[i];
      if (row.length < 6 || !/^\d{4}\.\d{2}\.\d{2}/.test(row[0])) break;
      r.orders.push({
        open_time: parseDateTime(row[0]), order: parseNumber(row[1]), symbol: row[2] || '',
        type: row[3] || '', volume: parseNumber(row[4]), price: parseNumber(row[5]),
        sl: parseNumber(row[6]), tp: parseNumber(row[7]),
        close_time: parseDateTime(row[8]), state: row[9] || '', comment: row[10] || ''
      });
      i++;
    }
    return i;
  }

  function readDeals(all, index, r) {
    var i = index + 1;
    while (i < all.length) {
      var row = all[i];
      if (!/^\d{4}\.\d{2}\.\d{2}/.test(row[0])) {
        if (row.length === 4 && row.every(function (c) { return /^-?[\d\s.,]+$/.test(c); })) {
          if (!('Total Commission' in r.results)) {
            r.results['Total Commission'] = row[0];
            r.results['Total Swap'] = row[1];
            r.results['Total Deal Profit'] = row[2];
            r.results['Final Balance'] = row[3];
          }
          i++; break;
        }
        break;
      }
      if (row.length < 10) { i++; continue; }
      r.deals.push({
        time: parseDateTime(row[0]), deal: parseNumber(row[1]), symbol: row[2] || '',
        type: row[3] || '', direction: row[4] || '', volume: parseNumber(row[5]),
        price: parseNumber(row[6]), order: parseNumber(row[7]),
        commission: parseNumber(row[8]), swap: parseNumber(row[9]),
        profit: parseNumber(row[10]), balance: parseNumber(row[11]), comment: row[12] || ''
      });
      i++;
    }
    return i;
  }

  // ------------------------------------------------------ trade rebuilding
  function tradesFromReport(r) {
    var trades = [], open = [];
    for (var i = 0; i < r.deals.length; i++) {
      var d = r.deals[i];
      if (d.direction === 'in') {
        open.push({ time: d.time, side: (d.type === 'buy' || d.type === 'buy in') ? 'long' : 'short',
                    volume: d.volume || 0, price: d.price, commission: d.commission || 0, swap: d.swap || 0 });
        continue;
      }
      if (d.direction !== 'out') continue;
      while (open.length) {
        var pos = open[0], remaining = pos.volume, closed = d.volume || remaining;
        if (remaining <= 0) { open.shift(); continue; }
        var take = Math.min(remaining, closed), share = remaining ? take / remaining : 1;
        open.shift();
        if (remaining - take > 1e-12) {
          open.unshift({ time: pos.time, side: pos.side, volume: remaining - take, price: pos.price,
                         commission: pos.commission * share, swap: pos.swap * share });
        }
        var dur = (pos.time && d.time) ? Math.round((d.time - pos.time) / 1000) : null;
        trades.push({ open_time: pos.time, close_time: d.time, side: pos.side, volume: take,
                      entry: pos.price, exit: d.price, profit: d.profit || 0,
                      commission: (d.commission || 0) + pos.commission, swap: (d.swap || 0) + pos.swap,
                      net: (d.profit || 0) + (d.commission || 0) + pos.commission + (d.swap || 0) + pos.swap,
                      duration: dur, reason: d.comment || '' });
        if (take < closed - 1e-12) break;
      }
    }
    return trades;
  }

  // ------------------------------------------------------------- metrics
  function metrics(r) {
    var res = r.results;
    var g = function (label) { return parseNumber(res[label]); };
    var gp = function (label) { return parsePercent(res[label]); };
    var gi = function (label) { var v = parseNumber(res[label]); return v === null ? null : Math.round(v); };
    var countFrom = function (text) {
      if (!text) return null;
      var head = text.split('(')[0].trim();
      var v = parseFloat(head.replace(/[ ,]/g, ''));
      return isNaN(v) ? null : Math.round(v);
    };

    var m = {
      expert: r.settings.Expert || null,
      symbol: r.settings.Symbol || null,
      period: (r.settings.Period || '').split(' ')[0] || null,
      deposit: parseNumber(r.settings['Initial Deposit']),
      currency: r.settings.Currency || null,
      net: g('Total Net Profit'),
      gross_profit: g('Gross Profit'),
      gross_loss: g('Gross Loss'),
      pf: g('Profit Factor'),
      expectancy: g('Expected Payoff'),
      recovery: g('Recovery Factor'),
      sharpe: g('Sharpe Ratio'),
      trades: gi('Total Trades'),
      profit_trades: countFrom(res['Profit Trades (% of total)']),
      loss_trades: countFrom(res['Loss Trades (% of total)']),
      dd_balance_pct: gp('Balance Drawdown Maximal'),
      dd_equity_pct: gp('Equity Drawdown Maximal'),
      dd_equity_abs: g('Equity Drawdown Absolute'),
      largest_win: g('Largest profit trade'),
      largest_loss: g('Largest loss trade'),
      avg_win: g('Average profit trade'),
      avg_loss: g('Average loss trade'),
      max_consec_wins: countFrom(res['Maximum consecutive wins ($)']),
      max_consec_losses: countFrom(res['Maximum consecutive losses ($)']),
      min_hold: parseDuration(res['Minimal position holding time']),
      max_hold: parseDuration(res['Maximal position holding time']),
      avg_hold: parseDuration(res['Average position holding time']),
      commission: res['Total Commission'] !== undefined ? Math.abs(parseNumber(res['Total Commission']) || 0) : null,
      swap: res['Total Swap'] !== undefined ? Math.abs(parseNumber(res['Total Swap']) || 0) : null,
      final_balance: res['Final Balance'] !== undefined ? parseNumber(res['Final Balance']) : null
    };
    m.win_rate = (m.profit_trades !== null && m.trades) ? m.profit_trades / m.trades * 100 : null;

    var trades = tradesFromReport(r);
    m.trade_count = trades.length;

    // equity curve + worst losing streak
    var curve = [], bal = m.deposit || 0, streak = 0, streakSum = 0, worst = 0, worstSum = 0;
    var bestStreak = 0, curWin = 0;
    for (var i = 0; i < trades.length; i++) {
      bal += trades[i].net;
      curve.push(bal);
      if (trades[i].net < 0) { streak++; streakSum += trades[i].net; if (streak > worst) { worst = streak; worstSum = streakSum; } }
      else { streak = 0; streakSum = 0; }
      if (trades[i].net > 0) { curWin++; if (curWin > bestStreak) bestStreak = curWin; } else curWin = 0;
    }
    m.equity = curve;
    m.worst_streak = worst || null;
    m.worst_streak_money = worst ? worstSum : null;

    if (m.deposit && m.net !== null) m.rod = m.net / m.deposit * 100;
    var costs = (m.commission || 0) + (m.swap || 0);
    if (m.gross_profit && costs) m.cost_ratio = costs / m.gross_profit * 100;
    if (m.net !== null && costs) { m.net_2x = m.net - costs; m.net_3x = m.net - 2 * costs; }

    // break-even win rate from the average win and average loss
    if (m.avg_win !== null && m.avg_loss !== null && m.avg_loss !== 0) {
      var aw = m.avg_win, al = Math.abs(m.avg_loss);
      m.breakeven_wr = al / (aw + al) * 100;
    }

    // attribution
    function bucket(keyFn) {
      var b = {};
      for (var j = 0; j < trades.length; j++) {
        if (!trades[j].close_time) continue;
        var k = keyFn(trades[j].close_time);
        if (!k) continue;
        if (!b[k]) b[k] = { n: 0, net: 0, wins: 0 };
        b[k].n++; b[k].net += trades[j].net;
        if (trades[j].net > 0) b[k].wins++;
      }
      var out = [];
      for (var key in b) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
        out.push({ key: key, n: b[key].n, net: b[key].net, wr: b[key].n ? b[key].wins / b[key].n * 100 : null });
      }
      return out;
    }
    m.by_weekday = bucket(function (d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]; });
    m.by_hour = bucket(function (d) { return (d.getHours() < 10 ? '0' : '') + d.getHours(); });

    // trades per month
    var period = r.settings.Period || '';
    var pm = period.match(/\(([^)]+)\)/);
    if (pm && m.trades) {
      var parts = pm[1].split('-');
      if (parts.length === 2) {
        var a = parseDateTime(parts[0].trim() + ' 00:00:00'), b = parseDateTime(parts[1].trim() + ' 00:00:00');
        if (a && b) {
          var months = Math.max((b - a) / 1000 / 60 / 60 / 24 / 30.4375, 1e-9);
          m.trades_per_month = m.trades / months;
        }
      }
    }
    return m;
  }

  // -------------------------------------------------------------- verdict
  // A plain reading of the numbers, with the thresholds stated. The point is
  // not to produce a score; it is to say the same thing every time so two
  // reports can be compared honestly.
  function verdict(m) {
    var flags = [], cls = 'good', head = 'This looks like it might be a real edge';
    var trades = m.trades || 0;

    if (trades < 30) {
      flags.push('Only ' + trades + ' trades. Below about 30 the result is indistinguishable from luck — ' +
                 'the standard error on a win rate is too wide to say anything.');
      cls = 'warn'; head = 'Not enough trades to judge';
    }
    if (m.pf !== null && m.pf < 1.05) {
      flags.push('Profit factor ' + m.pf.toFixed(2) + '. A profit factor under 1.05 is inside the noise band for most systems.');
      if (cls === 'good') { cls = 'warn'; head = 'Marginal at best'; }
    }
    if (m.expectancy !== null && m.expectancy <= 0) {
      flags.push('Expectancy is ' + money(m.expectancy) + ' per trade — the strategy loses money per trade before anything else is considered.');
      cls = 'bad'; head = 'Negative expectancy';
    }
    if (m.dd_equity_pct !== null && m.dd_equity_pct > 30) {
      flags.push('Max equity drawdown ' + m.dd_equity_pct.toFixed(2) + '%. Above roughly 30% most retail accounts cannot hold the position through it.');
      if (cls === 'good') { cls = 'warn'; head = 'The drawdown is the problem, not the return'; }
    }
    if (m.net_2x !== null && m.net_2x !== undefined && m.net > 0 && m.net_2x < 0) {
      flags.push('The result goes negative when commission and swap are doubled. A strategy that only works at current costs is not a strategy.');
      cls = 'bad'; head = 'It only works at today\'s costs';
    }
    if (m.worst_streak !== null && m.worst_streak >= 12) {
      flags.push('Worst losing streak: ' + m.worst_streak + ' consecutive losers' +
                 (m.worst_streak_money !== null ? ' (' + money(m.worst_streak_money) + ')' : '') +
                 '. That is what you have to be able to sit through.');
    }
    if (m.breakeven_wr !== null && m.win_rate !== null && m.win_rate < m.breakeven_wr) {
      flags.push('Win rate ' + m.win_rate.toFixed(1) + '% is below the ' + m.breakeven_wr.toFixed(1) +
                 '% this system needs to break even at its current average win and loss.');
      if (cls === 'good') { cls = 'warn'; head = 'Below break-even for its own payoff ratio'; }
    }
    if (!flags.length) {
      flags.push('Expectancy, profit factor, drawdown and cost sensitivity all clear the usual thresholds, ' +
                 'and the sample is large enough to mean something. That is the *starting* condition, not the conclusion — ' +
                 'a walk-forward test on data these settings never saw is what settles it.');
    }
    return { cls: cls, head: head, flags: flags };
  }

  // --------------------------------------------------------------- output
  function verdictHtml(m) {
    var v = verdict(m);
    var pills = [];
    if (m.trades !== null) pills.push('<span class="pill">' + m.trades + ' trades</span>');
    if (m.pf !== null) pills.push('<span class="pill">PF ' + m.pf.toFixed(2) + '</span>');
    if (m.expectancy !== null) pills.push('<span class="pill y">exp ' + money(m.expectancy) + '</span>');
    if (m.dd_equity_pct !== null) pills.push('<span class="pill y">DD ' + m.dd_equity_pct.toFixed(1) + '%</span>');
    return '<div class="verdict ' + v.cls + '"><h2>' + esc(v.head) + '</h2><p>' + pills.join(' ') + '</p>' +
      v.flags.map(function (f) { return '<p>· ' + esc(f) + '</p>'; }).join('') +
      '<p class="small" style="margin-top:12px;color:var(--dim)">This is a reading of one historical simulation. ' +
      'It is not a forecast and it is not advice. The check that settles it is a walk-forward test on data the ' +
      'parameters never saw.</p></div>';
  }

  function cardsHtml(m) {
    var cards = [
      ['Net profit', money(m.net), m.rod !== null && m.rod !== undefined ? m.rod.toFixed(2) + '% of deposit' : ''],
      ['Profit factor', m.pf === null ? '—' : m.pf.toFixed(2), 'gross profit / gross loss'],
      ['Expectancy / trade', money(m.expectancy), 'the number that matters'],
      ['Max equity DD', pct(m.dd_equity_pct), money(m.dd_equity_abs)],
      ['Win rate', pct(m.win_rate), m.profit_trades !== null ? m.profit_trades + ' of ' + m.trades : ''],
      ['Recovery factor', m.recovery === null ? '—' : m.recovery.toFixed(2), 'net profit / max drawdown'],
      ['Sharpe', m.sharpe === null ? '—' : m.sharpe.toFixed(2), 'as MT5 computes it'],
      ['Break-even win rate', pct(m.breakeven_wr), 'for its own payoff ratio'],
      ['Worst losing streak', m.worst_streak === null ? '—' : m.worst_streak + ' in a row', m.worst_streak_money !== null ? money(m.worst_streak_money) : ''],
      ['Trades / month', m.trades_per_month === null || m.trades_per_month === undefined ? '—' : m.trades_per_month.toFixed(1), 'sample density'],
      ['Net at 2× costs', money(m.net_2x), m.cost_ratio !== null && m.cost_ratio !== undefined ? 'costs are ' + m.cost_ratio.toFixed(2) + '% of gross profit' : ''],
      ['Net at 3× costs', money(m.net_3x), 'if costs rise']
    ];
    return '<div class="cards">' + cards.map(function (c) {
      var neg = typeof c[1] === 'string' && c[1].indexOf('-') === 0;
      return '<div class="card"><div class="k">' + esc(c[0]) + '</div><div class="v' + (neg ? ' bad' : '') + '">' +
        esc(c[1]) + '</div><div class="n">' + esc(c[2] || '') + '</div></div>';
    }).join('') + '</div>';
  }

  function chartsHtml(m) {
    var out = '';
    if (m.equity && m.equity.length > 1) out += '<h2>Equity curve</h2>' + equitySvg(m);
    if (m.by_hour && m.by_hour.length) out += '<h2>Profit by hour of day</h2>' + bucketSvg(m.by_hour, 'hour');
    if (m.by_weekday && m.by_weekday.length) out += '<h2>Profit by day of week</h2>' + bucketSvg(m.by_weekday, 'day');
    return out;
  }

  function equitySvg(m) {
    var data = m.equity, W = 1000, H = 220, pad = 30;
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    if (max === min) { max = min + 1; }
    var x = function (i) { return pad + (W - 2 * pad) * (i / (data.length - 1)); };
    var y = function (v) { return H - pad - (H - 2 * pad) * ((v - min) / (max - min)); };
    var line = '', area = '';
    for (var i = 0; i < data.length; i++) {
      line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(data[i]).toFixed(1) + ' ';
    }
    area = 'M' + x(0).toFixed(1) + ' ' + y(min).toFixed(1) + ' ' + line + 'L' + x(data.length - 1).toFixed(1) + ' ' + y(min).toFixed(1) + ' Z';
    var zeroY = (m.deposit !== null && m.deposit >= min && m.deposit <= max) ? y(m.deposit) : null;
    var final = data[data.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Equity curve">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4c8dff" stop-opacity="0.35"/><stop offset="100%" stop-color="#4c8dff" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#g)"/>' +
      '<path d="' + line + '" fill="none" stroke="#4c8dff" stroke-width="1.6"/>' +
      (zeroY !== null ? '<line x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + zeroY.toFixed(1) +
        '" stroke="#8b95a9" stroke-dasharray="4 4" stroke-width="1"/>' : '') +
      '<text x="' + pad + '" y="18" fill="#8b95a9" font-size="12">' + money(max) + '</text>' +
      '<text x="' + pad + '" y="' + (H - 8) + '" fill="#8b95a9" font-size="12">' + money(min) + '</text>' +
      '<text x="' + (W - pad) + '" y="18" fill="#8b95a9" font-size="12" text-anchor="end">final ' + money(final) + '</text>' +
      '</svg>';
  }

  function bucketSvg(rows, kind) {
    var order = kind === 'day'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : (function () { var a = []; for (var i = 0; i < 24; i++) a.push(i < 10 ? '0' + i : '' + i); return a; })();
    var map = {};
    rows.forEach(function (r) { map[r.key] = r; });
    var keys = order.filter(function (k) { return map[k]; });
    if (!keys.length) keys = rows.map(function (r) { return r.key; });
    var W = 1000, H = 190, pad = 30, base = H - 46;
    var vals = keys.map(function (k) { return map[k].net; });
    var maxAbs = Math.max.apply(null, vals.concat([1]).map(Math.abs)) * 1.15;
    var bw = (W - 2 * pad) / keys.length;
    var zeroY = base - (base - pad) / 2;
    var bars = '';
    keys.forEach(function (k, i) {
      var v = map[k].net;
      var h = Math.abs(v) / maxAbs * (base - pad) / 2;
      var x = pad + i * bw + bw * 0.16, w = bw * 0.68;
      var y = v >= 0 ? zeroY - h : zeroY;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) +
        '" fill="' + (v >= 0 ? '#34c759' : '#ff5f56') + '" rx="2"/>' +
        '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (base + 16) + '" fill="#8b95a9" font-size="11" text-anchor="middle">' + k + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Profit by ' + kind + '">' +
      '<line x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + zeroY.toFixed(1) + '" stroke="#28303d" stroke-width="1"/>' +
      bars + '</svg>';
  }

  function tablesHtml(m) {
    var out = '';
    if (m.by_weekday && m.by_weekday.length) {
      out += '<h2>Day of week</h2><table><tr><th>Day</th><th>Trades</th><th>Net</th><th>Win rate</th></tr>' +
        m.by_weekday.slice().sort(function (a, b) { return b.net - a.net; }).map(function (r) {
          return '<tr><td>' + esc(r.key) + '</td><td>' + r.n + '</td><td class="' + (r.net < 0 ? 'bad' : 'good') + '">' +
            money(r.net) + '</td><td>' + (r.wr === null ? '—' : r.wr.toFixed(1) + '%') + '</td></tr>';
        }).join('') + '</table>';
    }
    if (m.by_hour && m.by_hour.length) {
      out += '<h2>Hour of day</h2><table><tr><th>Hour</th><th>Trades</th><th>Net</th><th>Win rate</th></tr>' +
        m.by_hour.map(function (r) {
          return '<tr><td>' + esc(r.key) + ':00</td><td>' + r.n + '</td><td class="' + (r.net < 0 ? 'bad' : 'good') + '">' +
            money(r.net) + '</td><td>' + (r.wr === null ? '—' : r.wr.toFixed(1) + '%') + '</td></tr>';
        }).join('') + '</table>';
    }
    out += '<h2>Everything the terminal reported</h2><table><tr><th>Metric</th><th>Value</th></tr>' +
      Object.keys(m.rawResults || {}).length ? '' : '';
    return out;
  }

  function ctaHtml() {
    return '<div class="cta"><h2>One report is one run</h2>' +
      '<p>A single backtest cannot tell you whether the parameters fitted the sample. Two things do, and both ' +
      'are automated services:</p><ul>' +
      '<li><b>Walk-forward validation</b> — parameters are chosen on one window and run on the next, unseen one. ' +
      'You get the out-of-sample result and the efficiency number, including when it says your edge did not survive.</li>' +
      '<li><b>Parameter sweep</b> — the grid, ranked by a declared objective, with every run pinned to one ' +
      'configuration so the comparison is real.</li></ul>' +
      '<p style="margin-top:16px"><a class="btn" href="https://mt5-analyzer.dhashan.workers.dev/order">Get a walk-forward validation — from $39</a> ' +
      '<a class="btn ghost" href="https://mt5-analyzer.dhashan.workers.dev/order">See pricing and how it works</a></p>' +
      '<p class="small" style="margin-top:14px">No profitability claims. The deliverable is measurement, and the ' +
      'measurement is allowed to be unflattering — that is the entire point of paying for it.</p></div>';
  }

  return {
    esc: esc, readReportText: readReportText, parseReport: parseReport,
    metrics: metrics, verdict: verdict, tradesFromReport: tradesFromReport,
    verdictHtml: verdictHtml, cardsHtml: cardsHtml, chartsHtml: chartsHtml,
    tablesHtml: tablesHtml, ctaHtml: ctaHtml
  };
})();
