// vscode-port: the Trace Driver panel's page. Port of the panel of cmux's Resources/vaporview/
// cmux-trace-ui.js (render, renderChain; cmux branch tracex-wcz 44516d52d6a), GPL-3.0 with VaporView. The extension
// host traces (src/cmux/trace); this page shows a step or a chain and posts clicks back:
//   open {loc} | follow {index} | back | forward | cancel | addFanin | chainStep {index} | chainAdd
//   | chainCause {step, index}
(function () {
  const vscode = acquireVsCodeApi();
  const S = () => window.traceStrings || {};
  const root = document.getElementById('trace');
  const post = (m) => vscode.postMessage(m);
  const format = (text, ...args) => {
    let i = 0;
    return String(text || '').replace(/%(\d+\$)?@/g, (_, n) => String(args[n ? Number(n.slice(0, -1)) - 1 : i++]));
  };
  const number = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : String(n));
  const where = (loc) => (loc ? `${String(loc.file).split('/').pop()}:${loc.line}` : '');
  function bitsShown(bits) {
    const b = String(bits);
    if (b.length <= 4 || /[xz]/.test(b) && b.length <= 16) { return `${b.length}'b${b}`; }
    if (!/[xz]/.test(b)) { return `${b.length}'h${BigInt('0b' + b).toString(16)}`; }
    let out = '';
    for (let i = b.length; i > 0; i -= 4) {
      const d = b.slice(Math.max(0, i - 4), i);
      out = (/^[01]+$/.test(d) ? parseInt(d, 2).toString(16) : /^x+$/.test(d) ? 'x' : /^z+$/.test(d) ? 'z' : /x/.test(d) ? 'X' : 'Z') + out;
    }
    return `${b.length}'h${out}`;
  }
  const valueText = (bits) => (bits === null || bits === undefined ? '?' : bitsShown(bits));
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }
  function button(label, title, run, cls) {
    const b = el('button', cls || '', label);
    b.title = title || '';
    b.addEventListener('click', run);
    return b;
  }
  function head(titleText, extra) {
    root.textContent = '';
    const h = el('div', 'head');
    h.append(el('span', 'title', titleText));
    for (const x of extra || []) { h.append(x); }
    root.append(h);
    return h;
  }
  const open = (loc) => { if (loc) { post({ type: 'open', loc }); } };
  function link(loc) {
    const a = el('a', 'loc', where(loc));
    a.title = S().traceOpen || 'Open in Editor';
    a.href = '#';
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(loc); });
    return a;
  }

  function driverText(st) {
    const s = S();
    const d = st.driver || {};
    switch (d.kind) {
      case 'assign': return s.traceKindAssign;
      case 'proc': return format(s.traceKindProc, st.procKind || d.procKind || '');
      case 'portIn': return format(s.traceKindPortIn, d.port, d.instance);
      case 'portOut': return format(s.traceKindPortOut, d.port, d.instance);
      case 'initial': return s.traceKindInitial;
      case 'topInput': return s.traceKindTopInput;
      case 'undriven': return s.traceKindUndriven;
      case 'initializer': return s.traceKindInitializer;
      default: return s.traceKindNone;
    }
  }
  function reasonText(r) {
    const text = S()['traceReason_' + r.code];
    if (!text) { return r.code; }
    return format(text, r.path || r.src || (r.time !== undefined ? number(r.time) : '') || r.count || r.why || r.error || '', r.predicted ? valueText(r.predicted) : '');
  }
  function trustBadge(trust) {
    const s = S();
    const b = el('span', 'badge ' + (trust || ''), s['traceTrust_' + trust] || trust || '');
    b.title = s['traceTrustHelp_' + trust] || '';
    return b;
  }

  // Answers read before the file's whole-file check confirmed it (FSDB/WCZ opened lazily).
  // vscode-port: says what is not confirmed: the reader's whole-file check has not run yet (pending; it
  // clears when the check passes) or is turned off (vaporview.wisp.verifyStart off).
  function unconfirmedBadge(kind) {
    const s = S();
    const off = kind === 'off';
    const b = el('span', 'badge unconfirmed', off ? (s.traceUnconfirmedOff || 'file check off') : (s.traceUnconfirmed || 'file check pending'));
    b.dataset.kind = off ? 'off' : 'pending';
    b.title = off ? (s.traceUnconfirmedOffHelp || '') : (s.traceUnconfirmedHelp || '');
    return b;
  }

  function renderStep(state) {
    const st = state.step;
    const s = S();
    const nav = [button('‹', s.traceBack || 'Back', () => post({ type: 'back' }), 'nav back'), button('›', s.traceForward || 'Forward', () => post({ type: 'forward' }), 'nav forward')];
    nav[0].disabled = !state.canBack;
    nav[1].disabled = !state.canForward;
    const extra = [];
    if (st.trust) { extra.push(trustBadge(st.trust)); }
    if (st.unconfirmed) { extra.push(unconfirmedBadge(st.unconfirmed)); }
    extra.push(...nav);
    head(format(s.traceStepTitle, st.signal, valueText(st.value), number(st.time)), extra);
    const body = el('div', 'body step');
    body.dataset.signal = st.signal || '';
    if (st.error) {
      body.append(el('div', 'error', s['traceError_' + st.error] || st.error));
      root.append(body);
      return;
    }
    const line = el('div', 'driver');
    line.append(el('span', 'kind', driverText(st) + ' '));
    if (st.driver && st.driver.writer) { line.append(el('span', 'muted', format(s.traceWriter, st.driver.writer) + ' ')); }
    const loc = st.stmt && st.stmt.loc;
    if (loc) { line.append(link(loc)); }
    if (st.activation) {
      line.append(el('span', 'muted activation', ' · ' + format(s.traceActivation, st.activation.trigger ? `${st.activation.trigger.edge === 'NegEdge' ? 'negedge' : 'posedge'} ${st.activation.trigger.path}` : '', number(st.activation.time), number(st.sample))));
    } else if (st.since !== null && st.since !== undefined) {
      line.append(el('span', 'muted since', ' · ' + format(s.traceSince, number(st.since))));
    }
    body.append(line);
    if (st.resolvedVia) { body.append(el('div', 'muted resolved', format(s.traceResolvedTarget || 'Not in the dump: its value is read via %@', st.resolvedVia))); }
    if (st.noValue) { body.append(el('div', 'muted novalue', st.noValueText || 'no value')); }
    if (st.candidates && st.candidates.length && st.wrote === false) {
      const ul = el('ul', 'candidates');
      for (const c of st.candidates) { const li = el('li', 'code candidate', c.src); if (c.loc) { li.addEventListener('click', () => open(c.loc)); } ul.append(li); }
      body.append(el('div', 'muted', s.traceCandidates || 'Possible drivers:'));
      body.append(ul);
    }
    body.append(el('div', 'muted engine', s.traceEngineCmux || 'Traced by the slang design model'));
    if (st.stmt && st.stmt.src) { const c = el('div', 'code stmt', st.stmt.src); if (loc) { c.addEventListener('click', () => open(loc)); } body.append(c); }
    for (const m of st.merged || []) { body.append(el('div', 'code muted', '↔ ' + m.src)); }
    if (st.decisions && st.decisions.length) {
      const ul = el('ul', 'decisions');
      for (const d of st.decisions) {
        const li = el('li', 'code decision');
        const taken = d.taken === 'merge' ? s.traceTakenMerge : d.taken === 'then' ? s.traceTakenThen : d.taken === 'else' ? s.traceTakenElse
          : d.taken === 'default' ? s.traceTakenDefault : format(s.traceTakenItem, d.item || String(d.taken));
        const takenText = d.taken === 'unknown' ? (s.traceTakenUnknown || 'branch unknown') : taken;
        li.textContent = d.noValue ? `${d.kind === 'if' ? 'if' : 'case'} (${d.src}): ${d.noValueText || 'no value'} → ${takenText}${d.inferred ? ' ' + (s.traceInferredTag || '(branch inferred from the value change)') : ''}`
          : `${d.kind === 'if' ? 'if' : 'case'} (${d.src}) = ${valueText(d.value)} → ${takenText}${d.inferred ? ' ' + (s.traceInferredTag || '(branch inferred from the value change)') : ''}`;
        if (d.noValue) { li.classList.add('novalue'); li.dataset.novalue = d.noValueText || ''; }
        if (d.xCond) { li.classList.add('x'); li.title = s.traceXCondition || ''; }
        if (d.loc) { li.addEventListener('click', () => open(d.loc)); }
        ul.append(li);
      }
      body.append(ul);
    }
    if (st.fanin && st.fanin.length) {
      const fh = el('div', 'fanin-head');
      fh.append(el('span', 'muted', s.traceFanin));
      fh.append(button(s.traceAddFanin || 'Add Fan-in to Waveform', '', () => post({ type: 'addFanin' }), 'addfanin'));
      body.append(fh);
      const table = el('table', 'fanin');
      // vscode-port: names relative to the traced signal's instance (clk_i, not the whole hierarchy), so
      // the value and @time stay in view; the full path is the row's tooltip. Names outside that instance stay full.
      const scope = String(st.signal || '').replace(/\.[^.\[\]]+(\[[^\]]*\])*$/, '');
      const short = (p) => (scope && scope !== st.signal && p.startsWith(scope + '.') ? p.slice(scope.length + 1) : p);
      st.fanin.forEach((f, i) => {
        const tr = el('tr', 'fanin');
        tr.tabIndex = 0;
        const name = f.local ? format(s.traceLocal, f.name) : f.path ? short(f.path) : f.name;
        // vscode-port: not in the dump but read through its connection: the value, and what it came via.
        // no value: says so, with why; never "?" or x.
        const v = f.noValue ? el('td', 'code value novalue', f.noValueText || 'no value')
          : el('td', 'code value' + (/[xz]/.test(String(f.value)) ? ' x' : ''), f.dumped === false && !f.local && !f.resolvedVia ? (s.traceNoValue || 'no value') : valueText(f.value));
        if (f.noValue) { tr.dataset.novalue = f.noValueText || 'no value'; }
        tr.append(el('td', 'code name', name), v, el('td', 'muted', '@' + number(f.time)), el('td', 'muted role', s['traceRole_' + f.role] || f.role));
        // (the notes share one last cell that takes the remaining width and is cut with an ellipsis: a long note
        // never wraps the row taller or pushes the value out of view; the tooltip has it whole)
        const notes = [];
        if (f.computed) { notes.push(f.computedText || 'computed by the helper (port copy)'); tr.dataset.computed = f.computedText || 'computed'; }
        if (f.resolvedVia) { notes.push(format(s.traceResolvedVia || 'via %@', f.resolvedVia)); tr.dataset.via = f.resolvedVia; }
        const note = el('td', 'muted note' + (f.computed ? ' computed' : '') + (f.resolvedVia ? ' via' : ''), notes.join(' · '));
        tr.append(note);
        tr.title = [f.path || '', ...notes, f.via ? format(s.traceVia, f.via.src) : ''].filter(Boolean).join('\n');
        tr.dataset.path = f.path || '';
        const go = () => post({ type: 'follow', index: i });
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        table.append(tr);
      });
      body.append(table);
    }
    if (st.root === 'testbench') { body.append(el('div', 'muted', s.traceRootTestbench)); }
    // vscode-port: the cross-check with the user's own Verdi (on request only; the host shows the licence
    // notice first). Only when an installation was found (state.verdiAvailable); otherwise nothing of it shows.
    if (state.verdiAvailable || st.verdi) {
    const vrow = el('div', 'verdi-row');
    const vb = button(s.traceVerdiCheck || 'Cross-check with your installation', s.traceVerdiCheckTip || 'Check this statement against your Verdi installation (uses your licence)', () => post({ type: 'verdi' }), 'verdi');
    vb.disabled = !!state.verdiBusy;
    vrow.append(vb);
    if (state.verdiBusy) { vrow.append(el('span', 'muted', ' ' + (s.traceVerdiBusy || 'Asking Verdi…'))); }
    const v = st.verdi;
    if (v && !state.verdiBusy) {
      const out = el('span', 'verdict ' + v.verdict);
      out.dataset.verdict = v.verdict;
      if (v.code) { out.dataset.code = v.code; }
      if (v.verdict === 'agrees') { out.append(document.createTextNode(' ' + (s.traceVerdiAgrees || 'Verdi agrees') + ' ')); out.append(link({ file: v.verdi.file, line: v.verdi.line })); }
      else if (v.verdict === 'differs') { out.append(document.createTextNode(' ' + (s.traceVerdiDiffers || 'Verdi names another statement:') + ' ')); out.append(link({ file: v.verdi.file, line: v.verdi.line })); }
      else { out.append(document.createTextNode(' ' + (s.traceVerdiUnavailable || 'Verdi did not answer:') + ' ' + (v.message || v.code))); }
      vrow.append(out);
    }
    body.append(vrow);
    }
    const reasons = (st.reasons || []).filter((r) => r.code !== 'multiDriven' || (st.drivers || []).length > 1);
    if (reasons.length) {
      const ul = el('ul', 'muted reasons');
      const seen = new Set();
      for (const r of reasons) { const t = reasonText(r); if (!seen.has(t)) { seen.add(t); const li = el('li', 'reason', t); li.dataset.code = r.code; ul.append(li); } }
      body.append(ul);
    }
    root.append(body);
  }

  function whyText(e, valueChain) {
    const s = S();
    const w = e.why || {};
    const text = w.code === 'earliest' ? format(valueChain ? s.traceXWhy_earliestValue : s.traceXWhy_earliest, w.count)
      : w.code === 'only' && valueChain ? s.traceXWhy_onlyValue
        : w.code === 'held' ? format(valueChain ? s.traceXWhy_heldValue : w.limited ? s.traceXWhy_heldLimited : s.traceXWhy_held, number(w.since))
          : w.code === 'xSince' ? format(s.traceXWhy_xSince, number(w.since))
            : w.code === 'shifted' ? format(w.limited ? s.traceXWhy_shiftedLimited : s.traceXWhy_shifted, number(w.stages), number(w.since))
              + (Number.isFinite(w.bit) && s.traceXWhy_bit ? ', ' + format(s.traceXWhy_bit, number(w.bit)) : '')
              + (w.timedOut && s.traceXWhy_timedOut ? '; ' + s.traceXWhy_timedOut : '')
              : s['traceXWhy_' + w.code] || w.code;
    const bits = (w.bitsChanged ? '; ' + format(s.traceXWhy_bitsChanged, number(w.bitsChanged.from), number(w.bitsChanged.to)) : '')
      + (w.causeSkipped ? '; ' + (s['traceXWhy_causeSkipped_' + w.causeSkipped] || w.causeSkipped) : '');
    const role = w.role && w.code !== 'start' ? ' · ' + (s['traceRole_' + w.role] || w.role) : '';
    return text + bits + role;
  }

  function renderChain(state) {
    const c = state.chain;
    const s = S();
    const valueChain = c.mode === 'value' || (!c.mode && c.steps.length && !/[xz]/i.test(String(c.steps[0].value)));
    const extra = [];
    if (!c.running && c.steps.length) { extra.push(trustBadge(c.approximate ? 'approximate' : 'exact')); }
    if (c.unconfirmed) { extra.push(unconfirmedBadge(c.unconfirmed)); }
    if (c.running) { extra.push(button(s.traceXCancel || 'Cancel', s.traceXCancel, () => post({ type: 'cancel' }), 'xcancel')); }
    if (c.steps.length) { extra.push(button(s.traceXAdd || 'Add to Waveform', s.traceXAdd, () => post({ type: 'chainAdd' }), 'xadd')); }
    head(format(valueChain ? s.traceXTitleValue : s.traceXTitle, c.designPath, number(c.time)), extra);
    const body = el('div', 'body chain');
    body.dataset.running = c.running ? '1' : '0';
    const table = el('table', 'xchain');
    c.steps.forEach((e, i) => {
      const st = e.step || {};
      const tr = el('tr', 'xstep' + (i === c.root ? ' root' : ''));
      tr.tabIndex = 0;
      tr.dataset.path = e.signal || '';
      tr.dataset.time = String(e.time);
      tr.dataset.why = (e.why && e.why.code) || '';
      tr.dataset.trust = e.trust || '';
      const loc = st.stmt && st.stmt.loc;
      const locCell = el('td', 'loc');
      if (loc) { locCell.append(link(loc)); }
      tr.append(el('td', 'muted', String(i + 1)), el('td', 'code signal', e.signal), el('td', 'code value' + (/[xz]/.test(String(e.value)) ? ' x' : ''), valueText(e.value)),
        el('td', 'muted', '@' + number(e.time)), locCell, el('td', 'muted why', whyText(e, valueChain)));
      const tb = el('td', 'trust');
      tb.append(trustBadge(e.trust));
      // (the root mark next to the trust badge, in the same cell: no extra column on one row)
      if (i === c.root) { tb.append(' ', el('span', 'badge rootbadge', s.traceXRootBadge || 'root')); }
      tr.append(tb);
      if (st.stmt && st.stmt.src) { tr.title = st.stmt.src; }
      const go = () => post({ type: 'chainStep', index: i });
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
      table.append(tr);
      // The inputs this step was chosen among, earliest x first (ranked causes); each one traceable.
      if (e.causes && e.causes.length > 1) {
        const cr = el('tr', 'causes');
        const td = el('td', 'muted');
        td.colSpan = 8;
        td.append(el('span', '', (s.traceXCauses || 'Ranked causes') + ': '));
        e.causes.forEach((k, j) => {
          if (j) { td.append(el('span', '', ', ')); }
          const a = el('a', 'cause', `${j + 1}. ${k.path} (x since ${k.since === null || k.since === undefined ? '?' : number(k.since)})`);
          a.href = '#';
          a.dataset.path = k.path;
          a.addEventListener('click', (ev) => { ev.preventDefault(); post({ type: 'chainCause', step: i, index: j }); });
          td.append(a);
        });
        cr.append(td);
        table.append(cr);
      }
    });
    body.append(table);
    const endCode = c.end && c.end.code;
    const endText = c.running ? format(valueChain ? s.traceXRunningValue : s.traceXRunning, c.steps.length)
      : format(s['traceXEnd_' + endCode] || endCode || '', endCode === 'budget' ? String(c.steps.length) : endCode === 'noX' ? c.designPath : (c.end && c.end.signal) || '')
        + (c.end && c.end.error ? ' ' + c.end.error : '');
    const end = el('div', 'muted end', endText);
    end.dataset.code = c.running ? 'running' : (endCode || '');
    body.append(end);
    const last = c.steps[c.steps.length - 1];
    if (last && !c.running && c.root >= 0) {
      const reasons = ((last.step && last.step.reasons) || []).filter((r) => r.code !== 'multiDriven');
      if (reasons.length) { const ul = el('ul', 'muted reasons'); for (const r of reasons) { ul.append(el('li', 'reason', reasonText(r))); } body.append(ul); }
    }
    root.append(body);
  }

  const BUILD_STAGES = { fetch: 'Downloading slang', configure: 'Configuring', compile: 'Compiling', install: 'Installing', upload: 'Preparing' };
  function render(state) {
    renderKind(state);
    // vscode-port: the design was rebuilt from slang's open modules (no profile, no designArgs).
    if (state.designNote) { root.append(el('div', 'body muted design-note', state.designNote)); }
  }
  function renderKind(state) {
    root.dataset.kind = state.kind;
    if (state.kind === 'step') { renderStep(state); return; }
    if (state.kind === 'chain') { renderChain(state); return; }
    const s = S();
    if (state.kind === 'build') {
      head(s.traceTitle || 'Trace Driver');
      const body = el('div', 'body build');
      body.append(el('div', '', 'Building the design model (on slang) on this machine, once. It takes a few minutes.'));
      body.append(el('div', 'muted', (BUILD_STAGES[state.stage] || state.stage) + (state.percent !== undefined ? ` ${state.percent}%` : '') + '…'));
      root.append(body);
      return;
    }
    head(s.traceTitle || 'Trace Driver');
    root.append(el('div', 'body ' + (state.kind === 'error' ? 'error' : 'muted busy'), state.text || ''));
  }

  function e2e(q) {
    const list = [...document.querySelectorAll(q.selector || '*')];
    if (q.kind === 'texts') { return list.map((e) => e.textContent); }
    if (q.kind === 'count') { return list.length; }
    if (q.kind === 'attrs') { return list.map((e) => Object.assign({}, e.dataset, { className: e.className })); }
    // (the fan-in table's fit at a given panel width: row heights, and whether it overflows sideways)
    if (q.kind === 'layout') {
      const body = document.body; const was = body.style.width;
      if (q.width) { body.style.width = q.width + 'px'; }
      try {
        const t = document.querySelector('table.fanin');
        const rows = [...document.querySelectorAll('tr.fanin')];
        const line = rows.length ? rows[0].querySelector('td.name').getBoundingClientRect().height : 0;
        return { heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)), line: Math.round(line),
          overflow: t ? t.scrollWidth - t.parentElement.clientWidth : 0, names: rows.map((r) => r.querySelector('td.name').textContent),
          titles: rows.map((r) => r.title), valueVisible: rows.map((r) => { const v = r.querySelector('td.value').getBoundingClientRect(); return v.right <= body.getBoundingClientRect().right + 1 && v.width > 0; }) };
      } finally { body.style.width = was; }
    }
    if (q.kind === 'click') { const e = list[q.index || 0]; if (!e) { return { error: 'no element' }; } e.click(); return true; }
    return { error: 'unknown query' };
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'render') { render(m.state); }
    if (m.type === 'e2e') { let result; try { result = e2e(m.query || {}); } catch (e) { result = { error: String(e) }; } post({ type: 'e2e', id: m.id, result }); }
  });
  post({ type: 'ready' });
})();
