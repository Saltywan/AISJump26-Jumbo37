/* shell.js — the fixed page shell for JumpAIS problem pages.
 *
 * The model calls seven functions and draws SVG. The shell owns everything that
 * was previously reinvented on every generation: the frame and its size, the
 * palette, the reveal timeline and its pacing, KaTeX rendering, label placement
 * (with leader lines), the answer card, the replay control, and the error guard.
 *
 * Every function that creates something returns ONE <g> element you can draw into
 * or attach to. Nothing returns a bare leaf node you have to guess the shape of.
 */
(function (root) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var W = 960, H = 540;                    // the frame. identical on every page.
  var state = { steps: [], labels: [], arrows: [], groups: [], setupG: null, sanity: null,
                problem: '', level: null, stage: null, svg: null, root: null,
                answerEl: null, answerEls: [], timer: null, built: false, at: 0,
                prevBtn: null, nextBtn: null, playBtn: null, counter: null,
                board: null, boardHost: null, boardFit: null, jxg: [], jsxBase: {},
                jsxUnknown: [], jsxFails: [], jsxAliased: [] };

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  /* the model writes "\n" inside Thai strings meaning "line break". As HTML that
     renders as the literal two characters. Normalise both real newlines and the
     escaped pair to a <br> before inserting. */
  /* ---- two repairs the prompt could not buy ------------------------------
     1. A LaTeX command written with ONE backslash inside a JS string is eaten by
        JavaScript before the shell ever sees it: '\triangle' arrives as TAB +
        "riangle", '\nu' as a newline + "u". A generated page had exactly this —
        one bare \triangle among three correct \\triangle — so it is a slip, not a
        misunderstanding, and a slip is worth repairing rather than reporting.
        Only inside $...$, where a raw control character has no other meaning.
     2. A string that is pure maths with the $ delimiters forgotten reaches the
        student as literal backslashes. Wrap it — but only when it holds no Thai,
        because wrapping Thai into maths mode hides it instead (KaTeX has no
        Thai face). Both repairs are counted and reported, never silent. */
  var texFix = { escapes: 0, wrapped: 0 };
  var TEXESC = { '\t': 't', '\b': 'b', '\f': 'f', '\v': 'v', '\r': 'r' };
  function autoMath(s) {
    var t = String(s);
    if (t.indexOf('$') >= 0 || !/\\[a-zA-Z]{2,}/.test(t)) return t;
    if (/[\u0E00-\u0E7F]/.test(t)) return t;
    texFix.wrapped++;
    return '$' + t + '$';
  }
  function fixTex(s) {
    return String(s).split(/(\$[^$]*\$)/).map(function (seg) {
      if (seg.charAt(0) !== '$') return seg;
      return seg.replace(/[\t\b\f\v\r\n](?=[A-Za-z])/g, function (c) {
        texFix.escapes++;
        return '\\' + (TEXESC[c] || 'n');
      });
    }).join('');
  }

  function brify(html) {
    var t = fixTex(autoMath(html)).replace(/\\n|\r?\n/g, '<br>');
    // Outside $...$ a LaTeX command is never typeset — it reaches the student as
    // literal backslash text. The lint flags it; this stops it being ugly meanwhile.
    // Segments inside $...$ are left completely alone for KaTeX.
    return t.split(/(\$[^$]*\$)/).map(function (seg) {
      if (seg.charAt(0) === '$') return seg;
      return seg
        .replace(/\\textbf\{([^}]*)\}/g, '<b>$1</b>')
        .replace(/\\textit\{([^}]*)\}/g, '<i>$1</i>')
        .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1');
    }).join('');
  }
  /* same clean-up for SVG <text>, where HTML tags would render literally */
  function plainify(text) {
    return fixTex(autoMath(text)).split(/(\$[^$]*\$)/).map(function (seg) {
      if (seg.charAt(0) === '$') return seg;
      return seg.replace(/\\(?:textbf|textit|text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1');
    }).join('');
  }

  function h(tag, cls, parent, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = brify(html);
    if (parent) parent.appendChild(n);
    return n;
  }
  function reduced() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* ---- error guard: a blank page must always say why ---------------------- */
  window.addEventListener('error', function (e) {
    root.__drawError = e.message;
    try {
      var w = document.querySelector('.sh-wrap') || document.body;
      if (!document.querySelector('.sh-error')) {
        var d = h('div', 'sh-error', null, 'เกิดข้อผิดพลาดในการวาดภาพ: ' + e.message);
        w.insertBefore(d, w.firstChild);
      }
    } catch (_) { }
  });

  var Shell = {
    W: W, H: H,
    /* one colour = one meaning. these are the only five the drawing may use. */
    C: { given: '#1F5FBF', work: '#B4690E', answer: '#0F7A46', note: '#6B7688', warn: '#B3261E' },

    /* ---- page chrome ----------------------------------------------------- */
    page: function (o) {
      o = o || {};
      var wrap = h('div', 'sh-wrap', document.body);
      var head = h('div', 'sh-head', wrap);
      h('h1', null, head, o.title || '');
      h('p', 'sh-problem', head, o.problem || '');
      state.problem = o.problem || '';
      /* The grade level is INPUT — the teacher states it with the problem and the
         model passes it through. That is authoritative, so it is shown plainly.
         What was removed was the earlier version of this: a level the model
         *inferred* from the problem text, labelled 'ระดับที่ประเมิน' (assessed
         level), which presented a guess as a finding. If no level was supplied,
         nothing is drawn — the prompt forbids inventing one. */
      state.level = o.level || null;
      if (o.level) h('span', 'sh-level', head, 'ระดับชั้น: ' + o.level);
      var main = h('div', 'sh-main', wrap);
      state.stage = h('div', 'sh-stage', main);
      state.stepsHost = h('div', 'sh-steps', main);
      state.answerHost = h('div', null, wrap);
      var bar = h('div', 'sh-bar', wrap);
      state.prevBtn = h('button', 'sh-btn sh-ghost', bar, '‹ ย้อนกลับ');
      state.counter = h('span', 'sh-count', bar, '');
      state.nextBtn = h('button', 'sh-btn sh-ghost', bar, 'ถัดไป ›');
      state.playBtn = h('button', 'sh-btn', bar, '▶ เล่นอีกครั้ง');
      [state.prevBtn, state.nextBtn, state.playBtn].forEach(function (b) { b.type = 'button'; });
      state.prevBtn.addEventListener('click', function () { Shell.go(state.at - 1); });
      state.nextBtn.addEventListener('click', function () { Shell.go(state.at + 1); });
      state.playBtn.addEventListener('click', function () { Shell.replay(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); Shell.go(state.at + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); Shell.go(state.at - 1); }
      });
      state.built = true;
      return wrap;
    },

    /* ---- the drawing surface: always W x H ------------------------------- */
    canvas: function () {
      if (!state.built) Shell.page({});
      if (state.root) return state.root;   // a board page already owns the layer
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'xMidYMid meet', role: 'img' }, state.stage);
      state.svg = svg;
      state.root = el('g', { 'data-shell': 'root' }, svg);
      return state.root;
    },

    /* ---- a JSXGraph board: exact geometry, shell-owned text ---------------
       Use this whenever the picture IS the mathematics — a graph, a conic, a
       construction. JSXGraph computes the geometry so nothing is placed by eye;
       the shell keeps ownership of every piece of text, because JSXGraph's own
       labels are per-element and not scene-aware (5 of 9 pages in the fluency
       test had a label defect, and that is the whole reason to wrap it).
       Returns the BOARD, not a <g> — the one call that has to. */
    board: function (o) {
      o = o || {};
      if (typeof JXG === 'undefined')
        throw new Error('JSXGraph ยังไม่ถูกโหลด: ต้องมี <script src="lib/jsxgraphcore.js"></script>');
      if (state.board) return state.board;
      if (!state.built) Shell.page({});
      applyBoardDefaults();

      var scale = h('div', 'sh-scale', state.stage);
      var frame = h('div', 'sh-frame', scale);
      var host = h('div', 'sh-board', frame);
      host.id = 'shb' + Math.random().toString(36).slice(2, 8);

      var b = JXG.JSXGraph.initBoard(host.id, {
        boundingbox: o.box || o.boundingbox || [-10, 6, 10, -6],
        keepaspectratio: o.keepaspect !== false,   // equal px/unit unless told otherwise
        axis: o.axis !== false,
        grid: o.grid === true,
        showCopyright: false, showNavigation: false, showInfobox: false,
        pan: { enabled: false }, zoom: { enabled: false }, drag: { enabled: false },
        defaultAxes: { x: axisSpec(), y: axisSpec() }
      });
      /* everything the board built for itself — axes, their defining points,
         grid, ticks — is scaffolding. The lint counts what the page authored. */
      state.jsxBase = {};
      for (var bid in b.objects) state.jsxBase[bid] = 1;
      state.board = b; state.boardHost = host;
      guardCreate(b);

      /* the shell's own layer, in the same 960 x 540 space as every other page */
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'sh-over', role: 'img' }, frame);
      state.svg = svg;
      state.root = el('g', { 'data-shell': 'root' }, svg);

      state.boardFit = function () {
        var k = Math.min(1, (scale.clientWidth || W) / W);
        frame.style.transform = 'scale(' + k + ')';
        scale.style.height = Math.round(H * k) + 'px';
      };
      state.boardFit();
      window.addEventListener('resize', state.boardFit);
      return b;
    },

    /* board user coordinates -> the 960 x 540 frame the shell places text in */
    px: function (x, y) {
      if (!state.board) return [x, y];
      var c = new JXG.Coords(JXG.COORDS_BY_USER, [x, y], state.board).scrCoords;
      return [c[1], c[2]];
    },

    /* tie board elements to a step's reveal. everything not passed here stays
       visible from the start — which is what you want for axes and the givens. */
    on: function (parent) {
      var n = stepNo(parent), list = [], opts = {};
      var args = Array.prototype.slice.call(arguments, 1);
      var last = args[args.length - 1];
      if (last && typeof last === 'object' && !Array.isArray(last) && !last.elType
          && !last.__stub && ('until' in last)) opts = args.pop();
      args.forEach(function (a) { if (a) list = list.concat(Array.isArray(a) ? a : [a]); });
      var dies = opts.until === 'step' ? n
               : (typeof opts.until === 'number' ? opts.until : Infinity);
      list.forEach(function (e) {
        if (!e || typeof e.setAttribute !== 'function') return;
        state.jxg.push({ el: e, born: n, dies: dies });
        try { e.setAttribute({ visible: false }); } catch (_) { }
      });
      return list.length === 1 ? list[0] : list;
    },

    /* label a board point without doing any coordinate arithmetic yourself.
       `target` is a JSXGraph element or [x, y] in board coordinates. The shell
       places the text and draws a leader back to the point if it has to move. */
    tag: function (parent, target, text, o) {
      o = o || {};
      var bx, by;
      if (target && typeof target.X === 'function') { bx = target.X(); by = target.Y(); }
      else { bx = target[0]; by = target[1]; }
      var p = Shell.px(bx, by);
      var d = o.dist == null ? 22 : o.dist;
      var g = Shell.label(parent, p[0], p[1] - d, text,
        { role: o.role, until: o.until, anchor: p, size: o.size, align: o.align });
      var L = state.labels[state.labels.length - 1];
      if (L) { L.bxy = [bx, by]; L.bdist = d; }        // survives a bounding-box refit
      return g;
    },

    /* ---- the decision that precedes every step: axis choice, approach -----
       Deliberately NOT pushed to state.steps, so it can never inflate the
       reveal budget (pacing is computed from step count). */
    setup: function (thaiHtml) {
      if (!state.built) Shell.page({});
      var box = h('div', 'sh-setup', state.stepsHost);
      h('span', 'sh-setup-k', box, 'แนวทาง');
      h('span', 'sh-setup-body', box, thaiHtml || '');
      var g = el('g', { 'data-setup': '1' }, state.root || Shell.canvas());
      state.setupG = g;
      return g;
    },

    /* ---- a subgoal heading: names the method a run of steps belongs to ---- */
    group: function (thaiTitle) {
      if (!state.built) Shell.page({});
      var d = h('div', 'sh-group', state.stepsHost, thaiTitle || '');
      state.groups.push({ title: thaiTitle, afterStep: state.steps.length });
      return d;
    },

    /* ---- a step: prose in the panel, a group to draw into ---------------- */
    step: function (thaiHtml, o) {
      o = o || {};
      if (!state.built) Shell.page({});
      var n = state.steps.length + 1;
      var box = h('div', 'sh-step', state.stepsHost);
      box.tabIndex = 0;
      box.addEventListener('click', function () { Shell.go(n); });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); Shell.go(n); }
      });
      var num = h('span', 'sh-n', box, String(n));
      h('span', 'sh-step-body', box, thaiHtml || '');
      if (o.uses && o.uses.length) {
        var chips = h('span', 'sh-uses', box);
        o.uses.forEach(function (u) {
          var c = h('button', 'sh-chip', chips, '← ขั้น ' + u);
          c.type = 'button';
          c.addEventListener('click', function (e) { e.stopPropagation(); Shell.go(u); });
        });
      }
      if (o.why) h('div', 'sh-why', box, o.why);
      var g = el('g', { 'data-step': String(n), class: 'sh-reveal' },
                 state.root || Shell.canvas());
      state.steps.push({ n: n, box: box, g: g, text: thaiHtml || '',
                         why: o.why || null, uses: o.uses || [] });
      return g;
    },

    /* ---- an arrow, so the model never hand-rolls an SVG marker again ------
       Three pages in six invented an `orient` value (auto-or-angle, auto-angular,
       auto-change) and lost their arrowheads. The shell owns the marker now.
       Returns ONE <g>. Pass `value` and the magnitude check knows what it means. */
    arrow: function (parent, x1, y1, x2, y2, o) {
      o = o || {};
      if (o.board && state.board) {                 // endpoints given in board coordinates
        var a1 = Shell.px(x1, y1), a2 = Shell.px(x2, y2);
        x1 = a1[0]; y1 = a1[1]; x2 = a2[0]; y2 = a2[1]; o = Object.assign({}, o, { board: false });
      }
      var role = o.role || 'note', col = Shell.C[role] || Shell.C.note;
      var id = 'sh-ah-' + role;
      var svg = state.svg || (parent.ownerSVGElement);
      if (svg && !svg.querySelector('#' + id)) {
        var defs = svg.querySelector('defs');
        if (!defs) { defs = el('defs', {}, null); svg.insertBefore(defs, svg.firstChild); }
        var m = el('marker', { id: id, viewBox: '0 0 10 10', refX: 8.5, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
          markerUnits: 'strokeWidth' }, defs);
        el('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: col }, m);
      }
      var g = el('g', { 'data-arrow': role }, parent);
      el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: col,
        'stroke-width': o.width || 2.5, 'stroke-linecap': 'round',
        'marker-end': 'url(#' + id + ')',
        'stroke-dasharray': o.dash ? '7 5' : null }, g);
      if (o.value != null) {
        state.arrows.push({ g: g, value: Math.abs(+o.value), unit: o.unit || '',
          px: Math.hypot(x2 - x1, y2 - y1),
          axis: Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? 'x' : 'y' });
      }
      if (o.label) {
        var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        var dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
        var nx = -dy / L, ny = dx / L; if (ny > 0) { nx = -nx; ny = -ny; }
        Shell.label(parent, mx + nx * 16, my + ny * 16, o.label,
          { role: role, anchor: [mx, my], until: o.until });
      }
      return g;
    },

    /* ---- a label that knows what it points at, and how long it lives ------
       until: 'end'  (default) stays once revealed
              'step'          disappears when the next step begins
              <number>        disappears after that step number          */
    label: function (parent, x, y, text, o) {
      o = o || {};
      var bxy = null;
      if (o.board && state.board) {                 // x, y given in board coordinates
        bxy = [x, y];
        var q = Shell.px(x, y); x = q[0]; y = q[1];
        if (o.anchor) o.anchor = Shell.px(o.anchor[0], o.anchor[1]);
      }
      var role = o.role || 'note';
      var fill = Shell.C[role] || Shell.C.note;
      var g = el('g', { 'data-label': '1' }, parent);
      var node;
      if (/\$.+\$/.test(text)) {                      // maths label -> KaTeX via foreignObject
        var fo = el('foreignObject', { x: x - 110, y: y - 19, width: 220, height: 38 }, g);
        var div = document.createElement('div');
        div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        div.style.cssText = 'display:inline-block;white-space:nowrap;font-size:19px;color:' + fill;
        div.textContent = plainify(text);
        fo.appendChild(div);
        node = fo; g.__mathDiv = div;
      } else {
        node = el('text', { x: x, y: y, fill: fill,
          'text-anchor': o.align || 'middle', 'dominant-baseline': 'middle',
          'font-weight': o.weight || 600, 'font-size': o.size || 20 }, g);
        node.textContent = plainify(text);
      }
      var born = state.steps.length || 1;             // the step being built
      var dies = Infinity;
      if (o.until === 'step') dies = born;
      else if (typeof o.until === 'number') dies = o.until;
      state.labels.push({ g: g, node: node, home: { x: x, y: y }, bxy: bxy, bdist: 0,
                          anchor: o.anchor || [x, y], dx: 0, dy: 0, role: role,
                          born: born, dies: dies });
      return g;
    },

    answer: function (labelText, valueHtml, o) {
      o = o || {};
      if (!state.built) Shell.page({});
      var box = h('div', 'sh-answer', state.answerHost);
      h('span', 'sh-lab', box, labelText || 'คำตอบ');
      h('span', 'sh-val', box, valueHtml || '');
      if (o.sanity) h('div', 'sh-sanity', box, o.sanity);
      state.answerEl = box;
      state.answerEls.push(box);   // a two-part question gets two cards; both reveal
      state.sanity = o.sanity || state.sanity || null;
      return box;
    },

    /* ---- finish: typeset, place labels, assert, then play ---------------- */
    done: function () {
      try { typeset(); } catch (e) { }
      var fit = null;
      if (state.board) { try { state.boardFit(); } catch (e) { }
                         try { fit = fitBoard(); } catch (e) { fit = { board: true, error: String(e).slice(0,120) }; } }
      else try { fit = autoFit(); } catch (e) { }
      var checks = { magnitude: [], labels: null, fit: fit };
      try { checks.labels = placeLabels(); } catch (e) { checks.labelError = String(e && e.stack || e).slice(0,300); }
      try { checks.magnitude = checkMagnitudes(); } catch (e) { }
      checks.fit = fit;
      try { checks.explain = lintExplanation(); } catch (e) { checks.explain = null; }
      try { checks.latex = lintLatex(); } catch (e) { checks.latex = null; }
      try { checks.jsx = lintJsx(); } catch (e) { checks.jsx = null; }
      root.__shellCheck = checks;
      root.__scaleWarnings = checks.magnitude;
      Shell.replay();
      root.__done = true;
      return checks;
    },

    /* jump straight to the finished frame — what the review pane and thumbnail need */
    showAll: function () {
      clearTimeout(state.timer);
      Shell.go(state.steps.length, true);
      return state.steps.length;
    },

    /* move to step n (1..N); n = N means finished, answer shown */
    go: function (n, silent) {
      if (!silent) clearTimeout(state.timer);
      var N = state.steps.length;
      n = Math.max(0, Math.min(N, n));
      state.at = n;
      state.steps.forEach(function (s) {
        var on = s.n <= n;
        s.box.classList.toggle('sh-on', on);
        s.box.classList.toggle('sh-cur', s.n === n);
        s.g.classList.toggle('sh-on', on);
      });
      // a label lives from the step that created it until its `dies` step
      state.labels.forEach(function (L) {
        var alive = n >= L.born && n <= L.dies;
        L.g.style.opacity = alive ? '' : '0';
        L.g.style.pointerEvents = alive ? '' : 'none';
      });
      if (state.jxg.length && state.board) {
        try { state.board.suspendUpdate(); } catch (e) { }
        state.jxg.forEach(function (J) {
          var alive = n >= J.born && n <= J.dies;
          try { J.el.setAttribute({ visible: alive }); } catch (e) { }
        });
        try { state.board.unsuspendUpdate(); } catch (e) { }
      }
      state.answerEls.forEach(function (a) { a.classList.toggle('sh-on', n >= N); });
      if (state.counter) state.counter.textContent = n + ' / ' + N;
      if (state.prevBtn) state.prevBtn.disabled = (n <= 0);
      if (state.nextBtn) state.nextBtn.disabled = (n >= N);
      return n;
    },

    replay: function () {
      clearTimeout(state.timer);
      var N = state.steps.length;
      if (reduced() || !N) { Shell.go(N, true); root.__pacingMs = 0; return; }
      Shell.go(0);
      var per = Math.min(1500, Math.max(800, Math.round(10000 / (N + 1))));
      var i = 1;
      state.timer = setTimeout(function tick() {
        Shell.go(i, true);
        if (i++ < N) state.timer = setTimeout(tick, per);
      }, per);
      root.__pacingMs = per * (N + 1);
    }
  };

  /* ---- auto-fit: identical drawing scale on every page -------------------
     The prompt asking for "fill 70% of the frame" was obeyed on 2 of 6 pages.
     Enforced here instead: refit the viewBox to the geometry, then divide every
     label size and stroke width by the resulting zoom so text and line weight
     render at one constant size no matter how big the model drew. */
  // Never shrink. Zooming out while label text stays a constant size makes labels
// crowd — it cost q4_lens 1 -> 4 collisions. Only enlarge under-filled frames.
  var TARGET = 0.86, MINK = 1.0, MAXK = 1.6;
  function autoFit() {
    if (!state.svg || !state.root) return null;
    // measure the geometry only — labels must not drive the fit
    state.labels.forEach(function (L) { L.g.setAttribute('data-fit-skip', '1'); });
    var probe = el('g', {}, state.svg), bb = null;
    try {
      var kids = state.root.querySelectorAll('path,line,circle,rect,polygon,polyline,ellipse');
      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].closest('[data-label]')) continue;
        if (kids[i].getAttribute('class') === 'sh-leader') continue;
        var r;
        try { r = kids[i].getBBox(); } catch (e) { continue; }
        if (!r || (r.width === 0 && r.height === 0)) continue;
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height); n++;
      }
      if (n) bb = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } catch (e) { }
    probe.remove();
    state.labels.forEach(function (L) { L.g.removeAttribute('data-fit-skip'); });
    if (!bb || bb.width <= 0 || bb.height <= 0) return null;

    var k = Math.min(W * TARGET / bb.width, H * TARGET / bb.height);
    k = Math.max(MINK, Math.min(MAXK, k));
    if (Math.abs(k - 1) < 0.04) return { scale: 1, changed: false, fill: +((bb.width*bb.height)/(W*H)).toFixed(2) };
    var nw = W / k, nh = H / k;
    var cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    state.svg.setAttribute('viewBox', (cx - nw / 2) + ' ' + (cy - nh / 2) + ' ' + nw + ' ' + nh);

    // keep text and line weight at one rendered size across every page
    state.labels.forEach(function (L) {
      if (L.g.__mathDiv) {
        L.g.__mathDiv.style.fontSize = (19 / k).toFixed(2) + 'px';
      } else if (L.node.tagName.toLowerCase() === 'text') {
        L.node.setAttribute('font-size', (20 / k).toFixed(2));
      }
    });
    normaliseStrokes(k);
    return { scale: +k.toFixed(3), changed: true, fill: +((bb.width*bb.height)/(W*H)).toFixed(2) };
  }

  /* a foreignObject must always match the text now inside it */
  function refitMathBoxes() {
    if (!state.svg) return;
    var svgR = state.svg.getBoundingClientRect();
    var vb = (state.svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    var vw = vb.length === 4 ? vb[2] : W, vh = vb.length === 4 ? vb[3] : H;
    var sx = vw / (svgR.width || vw), sy = vh / (svgR.height || vh);
    state.labels.forEach(function (L) {
      if (!L.g.__mathDiv) return;
      try {
        var r = L.g.__mathDiv.getBoundingClientRect();
        var w = Math.max(18, r.width * sx + 4), h2 = Math.max(14, r.height * sy + 3);
        L.node.setAttribute('width', w); L.node.setAttribute('height', h2);
        L.node.setAttribute('x', L.home.x - w / 2);
        L.node.setAttribute('y', L.home.y - h2 / 2);
      } catch (e) { }
    });
  }

  /* stroke weights snapped to three tiers, then divided by the zoom */
  function normaliseStrokes(k) {
    var TIERS = [1.5, 2.5, 4];
    var marks = state.root.querySelectorAll('path,line,circle,rect,polygon,polyline,ellipse');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.getAttribute('class') === 'sh-leader') continue;
      var cs = getComputedStyle(m);
      if (!cs.stroke || cs.stroke === 'none') continue;
      var w = parseFloat(cs.strokeWidth) || 2;
      var best = TIERS[0], d = 1e9;
      TIERS.forEach(function (t) { var e = Math.abs(t - w); if (e < d) { d = e; best = t; } });
      m.setAttribute('stroke-width', (best / k).toFixed(2));
    }
  }

  /* ---- KaTeX over every piece of prose the shell owns -------------------- */
  function typeset() {
    if (typeof renderMathInElement !== 'function') { root.__katex = false; return; }
    root.__katex = true;
    renderMathInElement(document.body, {
      delimiters: [{ left: '$$', right: '$$', display: true },
                   { left: '$', right: '$', display: false },
                   { left: '\\(', right: '\\)', display: false }],
      throwOnError: false, errorColor: '#B3261E', ignoredTags: ['script', 'style', 'textarea']
    });
    state.labels.forEach(function (L) {
      if (L.g.__mathDiv) {
        try {
          renderMathInElement(L.g.__mathDiv, {
            delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false
          });
          // size the foreignObject to the WHOLE label. The div is inline-block +
          // nowrap so its rect is the true content width — including any Thai prose
          // wrapped around the maths. Measuring only .katex-html under-measures a
          // mixed label by more than half and collision resolution then misses it.
          var r = L.g.__mathDiv.getBoundingClientRect(), svgR = state.svg.getBoundingClientRect();
          var sx = W / (svgR.width || W), sy = H / (svgR.height || H);
          var w = Math.max(18, r.width * sx + 4), hh = Math.max(14, r.height * sy + 3);
          L.node.setAttribute('overflow', 'visible');
          L.node.setAttribute('width', w); L.node.setAttribute('height', hh);
          L.node.setAttribute('x', L.home.x - w / 2); L.node.setAttribute('y', L.home.y - hh / 2);
        } catch (e) { }
      }
    });
  }

  /* ---- label placement: discrete candidate slots -------------------------
     Point-Feature Label Placement (Christensen / Marks / Shieber, ACM TOG 1995).
     Each label gets a menu of candidate boxes around its anchor — 8 compass
     directions x 2 rings, plus the position the model authored — and we search
     that menu instead of nudging. Pairwise nudging could only creep by fractions
     of an overlap and could never move a label to the free side of its anchor
     once boxed in; every residual collision measured came from that.
     Deterministic: fixed candidate order, fixed tie-break, no annealing. */
  var DIRS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  var RINGS = [1.0, 1.6, 2.3, 3.1];
  var W_OVER = 1.0, W_STROKE = 26, W_DIST = 34, W_RING = 14, W_TURN = 9, MARGIN = 5;

  function roleWeight(a, b) {
    var heavy = { answer: 4, given: 3, work: 2, note: 1, warn: 4 };
    return (heavy[a] || 1) * (heavy[b] || 1);
  }
  function areaOverlap(A, B) {
    var ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
    var oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
    return (ox > 0 && oy > 0) ? ox * oy : 0;
  }
  function strokeHits(B, pts) {
    var n = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x > B.x && p.x < B.x + B.w && p.y > B.y && p.y < B.y + B.h) n++;
    }
    return n;
  }

  function placeLabels() {
    var L = state.labels;
    if (!L.length || !state.svg) return { n: 0, before: 0, after: 0, leaders: 0 };
    var svgR = state.svg.getBoundingClientRect();
    var vb = (state.svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    var vw = vb.length === 4 ? vb[2] : W, vh = vb.length === 4 ? vb[3] : H;
    var vx = vb.length === 4 ? vb[0] : 0, vy = vb.length === 4 ? vb[1] : 0;
    var sx = vw / (svgR.width || vw), sy = vh / (svgR.height || vh);

    L.forEach(function (it) {
      var r = it.node.getBoundingClientRect();
      it.box = { x: (r.x - svgR.x) * sx + vx, y: (r.y - svgR.y) * sy + vy,
                 w: r.width * sx, h: r.height * sy };
      it.base = { x: it.box.x, y: it.box.y };
      it.homeDir = dirOf(it.box, it.anchor);
    });
    var strokes = strokePts(sx, sy, svgR, vx, vy);
    var before = collisions(L);

    // candidate menu: the authored spot first, then rings of compass slots
    L.forEach(function (it) {
      var cands = [{ x: it.base.x, y: it.base.y, ring: 0, dir: it.homeDir }];
      var rad = Math.max(it.box.w, it.box.h) * 0.62 + 15;
      for (var r = 0; r < RINGS.length; r++) {
        for (var d = 0; d < DIRS.length; d++) {
          var off = RINGS[r] * rad;
          cands.push({
            x: it.anchor[0] + DIRS[d][0] * (off + it.box.w / 2) - it.box.w / 2,
            y: it.anchor[1] + DIRS[d][1] * (off + it.box.h / 2) - it.box.h / 2,
            ring: r + 1, dir: d
          });
        }
      }
      it.cands = cands.filter(function (c) {
        return c.x >= vx + MARGIN && c.y >= vy + MARGIN &&
               c.x + it.box.w <= vx + vw - MARGIN && c.y + it.box.h <= vy + vh - MARGIN;
      });
      if (!it.cands.length) it.cands = [cands[0]];      // nothing fits: keep the author's
      it.baseDist = Math.max(30, Math.hypot(it.box.w, it.box.h));
    });

    // place important labels first, and crowded ones before roomy ones
    var order = L.slice().sort(function (a, b) {
      var pr = { answer: 0, given: 1, warn: 1, work: 2, note: 3 };
      var d = (pr[a.role] || 3) - (pr[b.role] || 3);
      if (d) return d;
      return a.cands.length - b.cands.length;
    });

    var placed = [];
    order.forEach(function (it) {
      var best = null, bestCost = Infinity;
      for (var i = 0; i < it.cands.length; i++) {
        var c = it.cands[i];
        var B = { x: c.x, y: c.y, w: it.box.w, h: it.box.h };
        var cost = costOf(it, B, c, placed, strokes);
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      it.chosen = best; it.cost = bestCost;
      it.box = { x: best.x, y: best.y, w: it.box.w, h: it.box.h };
      placed.push(it);
    });

    // bounded repair: re-seat the worst offenders now that everything has a home
    for (var pass = 0; pass < 3; pass++) {
      var improved = false;
      order.forEach(function (it) {
        var others = placed.filter(function (o) { return o !== it; });
        var cur = costOf(it, it.box, it.chosen, others, strokes);
        var best = it.chosen, bestCost = cur;
        for (var i = 0; i < it.cands.length; i++) {
          var c = it.cands[i];
          var B = { x: c.x, y: c.y, w: it.box.w, h: it.box.h };
          var cost = costOf(it, B, c, others, strokes);
          if (cost < bestCost - 0.5) { bestCost = cost; best = c; }
        }
        if (best !== it.chosen) {
          it.chosen = best;
          it.box = { x: best.x, y: best.y, w: it.box.w, h: it.box.h };
          improved = true;
        }
      });
      if (!improved) break;
    }

    var leaders = 0;
    L.forEach(function (it) {
      var dx = it.box.x - it.base.x, dy = it.box.y - it.base.y;
      it.dx = dx; it.dy = dy;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
        it.g.setAttribute('transform', 'translate(' + dx.toFixed(1) + ',' + dy.toFixed(1) + ')');
      var cx = it.box.x + it.box.w / 2, cy = it.box.y + it.box.h / 2;
      if (Math.hypot(cx - it.anchor[0], cy - it.anchor[1]) > 34) {
        var e = edgePoint(it.box, it.anchor);
        el('path', { d: 'M ' + (e.x - dx) + ' ' + (e.y - dy) +
                        ' L ' + (it.anchor[0] - dx) + ' ' + (it.anchor[1] - dy),
                     class: 'sh-leader' }, it.g);
        leaders++;
      }
    });
    return { n: L.length, before: before, after: collisions(L), leaders: leaders };

    function costOf(it, B, c, others, strokes) {
      var cost = 0;
      for (var i = 0; i < others.length; i++) {
        var o = others[i];
        if (!coVisible(it, o)) continue;                 // never fight an invisible label
        var a = areaOverlap(B, o.box);
        if (a > 0) cost += W_OVER * a * roleWeight(it.role, o.role);
      }
      cost += W_STROKE * strokeHits(B, strokes);
      var cx = B.x + B.w / 2, cy = B.y + B.h / 2;
      cost += W_DIST * Math.hypot(cx - it.anchor[0], cy - it.anchor[1]) / it.baseDist;
      cost += W_RING * c.ring;
      if (c.ring > 0 && it.homeDir >= 0 && c.dir !== it.homeDir) cost += W_TURN;
      return cost;
    }
    function dirOf(box, anchor) {
      var dx = (box.x + box.w / 2) - anchor[0], dy = (box.y + box.h / 2) - anchor[1];
      if (Math.hypot(dx, dy) < 2) return -1;
      var ang = Math.atan2(dy, dx), best = -1, bd = 9;
      for (var d = 0; d < DIRS.length; d++) {
        var da = Math.abs(Math.atan2(DIRS[d][1], DIRS[d][0]) - ang);
        da = Math.min(da, 2 * Math.PI - da);
        if (da < bd) { bd = da; best = d; }
      }
      return best;
    }
  }

  /* two labels only conflict if they are ever on screen together */
  function coVisible(a, b) {
    return Math.max(a.born, b.born) <= Math.min(a.dies, b.dies);
  }

  function collisions(L) {
    var n = 0;
    for (var a = 0; a < L.length; a++) for (var b = a + 1; b < L.length; b++) {
      if (!coVisible(L[a], L[b])) continue;
      var A = L[a].box, B = L[b].box;
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) n++;
    }
    return n;
  }
  function edgePoint(b, target) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var dx = target[0] - cx, dy = target[1] - cy, m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
    return { x: cx + dx / m * (b.w / 2 + 2), y: cy + dy / m * (b.h / 2 + 2) };
  }
  function strokePts(sx, sy, svgR, vx, vy) {
    vx = vx || 0; vy = vy || 0;
    var pts = [], marks = state.svg.querySelectorAll('path,line,polyline,polygon,circle,rect,ellipse');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.getAttribute('class') === 'sh-leader') continue;
      try {
        var Lg = m.getTotalLength ? m.getTotalLength() : 0;
        if (Lg > 0) {
          var n = Math.min(16, Math.max(2, Math.round(Lg / 22)));
          for (var k = 0; k <= n; k++) {
            var p = m.getPointAtLength(Lg * k / n);
            var sp = new DOMPoint(p.x, p.y).matrixTransform(m.getScreenCTM());
            pts.push({ x: (sp.x - svgR.x) * sx + vx, y: (sp.y - svgR.y) * sy + vy });
          }
          continue;
        }
      } catch (e) { }
      var r = m.getBoundingClientRect();
      pts.push({ x: (r.x + r.width / 2 - svgR.x) * sx + vx, y: (r.y + r.height / 2 - svgR.y) * sy + vy });
    }
    return pts;
  }
  function onStroke(b, pts) {
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x > b.x + 1 && p.x < b.x + b.w - 1 && p.y > b.y + 1 && p.y < b.y + b.h - 1) return true;
    }
    return false;
  }

  /* ---- does a length that encodes a value match the value? --------------- */
  function checkMagnitudes() {
    if (!state.svg) return [];
    if (state.arrows.length >= 2) return checkDeclared();
    var arrows = state.svg.querySelectorAll('[marker-end],[marker-start]');
    var vals = [];
    state.labels.forEach(function (L) {
      var txt = L.node.textContent || '';
      var m = txt.match(/(-?\d+(?:[.,]\d+)?)\s*(N|m\/s|kg·m\/s|eV|V|A|Ω|cm|m)\b/);
      if (!m) return;
      var v = Math.abs(parseFloat(m[1].replace(',', '.')));
      if (v > 0) vals.push({ v: v, unit: m[2], text: txt.trim().slice(0, 26), pt: L.anchor });
    });
    var items = [];
    for (var i = 0; i < arrows.length; i++) {
      var a = arrows[i], len = 0;
      try { len = a.getTotalLength(); } catch (e) { continue; }
      if (!(len > 10)) continue;
      var p0, p1, mid;
      try {
        var q0 = a.getPointAtLength(0), q1 = a.getPointAtLength(len);
        p0 = { x: q0.x, y: q0.y }; p1 = { x: q1.x, y: q1.y };
        mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      } catch (e) { continue; }
      var px = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (px < 10) continue;
      var best = null, bd = 1e9;
      vals.forEach(function (v) {
        var d = Math.hypot(v.pt[0] - mid.x, v.pt[1] - mid.y);
        if (d < bd) { bd = d; best = v; }
      });
      if (best && bd < 70) items.push({ unit: best.unit, val: best.v, px: px, text: best.text, d: bd, lab: best });
    }
    var claimed = new Map();
    items.forEach(function (it) { var p = claimed.get(it.lab); if (!p || it.d < p.d) claimed.set(it.lab, it); });
    items = Array.from(claimed.values());
    var out = [], by = {};
    items.forEach(function (it) { (by[it.unit] = by[it.unit] || []).push(it); });
    Object.keys(by).forEach(function (u) {
      var grp = by[u]; if (grp.length < 2) return;
      var r = grp.map(function (g) { return g.px / g.val; }).sort(function (a, b) { return a - b; });
      var med = r[Math.floor(r.length / 2)];
      if (!(med > 0)) return;
      grp.forEach(function (g) {
        var err = Math.abs(g.px / med - g.val) / g.val;
        if (err > 0.12) out.push({ unit: u, label: g.text, statedValue: g.val,
          impliedValue: +(g.px / med).toFixed(2), error: +err.toFixed(2) });
      });
    });
    return out;
  }

  /* when arrows declare their value, compare like with like: one scale per
     unit PER AXIS. Ray diagrams legitimately draw heights and distances at
     different scales, which made the old single-scale check cry wolf. */
  function checkDeclared() {
    var out = [], by = {};
    state.arrows.forEach(function (a) {
      if (!(a.value > 0) || !(a.px > 0)) return;
      var key = a.unit + '|' + a.axis;
      (by[key] = by[key] || []).push(a);
    });
    Object.keys(by).forEach(function (k) {
      var grp = by[k]; if (grp.length < 2) return;
      var r = grp.map(function (g) { return g.px / g.value; }).sort(function (x, y) { return x - y; });
      var med = r[Math.floor(r.length / 2)];
      if (!(med > 0)) return;
      grp.forEach(function (g) {
        var err = Math.abs(g.px / med - g.value) / g.value;
        if (err > 0.12) out.push({ unit: k, statedValue: g.value,
          impliedValue: +(g.px / med).toFixed(2), error: +err.toFixed(2) });
      });
    });
    return out;
  }

  /* ---- explanation lint -------------------------------------------------
     A step that introduces a number found neither in the problem statement nor
     in any step it cites via `uses` is a derivation, and a derivation with no
     `why` explains nothing. Everything else — scene setting, ray construction,
     arithmetic continuation — is never asked for a `why`, so there is no filler
     tax. Prompt instructions were followed 2 times in 6 on this project; this
     is the same requirement expressed as something checkable. */
  function numbersIn(text) {
    if (!text) return [];
    var t = String(text)
      .replace(/\\[a-zA-Z]+/g, ' ')      // strip LaTeX commands
      .replace(/[{}$\\]/g, ' ');
    var out = [], m, re = /-?\d+(?:\.\d+)?/g;
    while ((m = re.exec(t))) {
      var v = parseFloat(m[0]);
      if (isFinite(v)) out.push(Math.abs(v));
    }
    return out;
  }
  function near(a, b) {
    if (a === b) return true;
    var d = Math.abs(a - b), scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return d / scale < 0.02;               // 43.3 vs 43.30, 3.27 vs 3.2667
  }
  function lintExplanation() {
    var probNums = numbersIn(state.problem);
    var flags = [], unverified = [];
    state.steps.forEach(function (st, i) {
      var mine = numbersIn(st.text);
      if (!mine.length) return;                       // construction / scene step
      var covered = probNums.slice();
      (st.uses || []).forEach(function (u) {
        var src = state.steps[u - 1];
        if (!src) { unverified.push({ step: st.n, reason: 'uses ขั้น ' + u + ' ที่ไม่มีอยู่' }); return; }
        covered = covered.concat(numbersIn(src.text));
      });
      // small integers are almost always indices/exponents, not derived values
      var novel = mine.filter(function (v) {
        if (v === 0 || (v < 10 && Number.isInteger(v))) return false;
        return !covered.some(function (c) { return near(v, c); });
      });
      if (novel.length && !st.why)
        flags.push({ step: st.n, newValues: novel.slice(0, 4),
                     reason: 'ขั้นนี้สร้างค่าใหม่แต่ไม่มีคำอธิบายว่าทำไม' });
      // a cited step that does not actually contain the number claimed
      (st.uses || []).forEach(function (u) {
        var src = state.steps[u - 1]; if (!src) return;
        var sn = numbersIn(src.text);
        if (!sn.length) unverified.push({ step: st.n, reason: 'อ้างขั้น ' + u + ' ที่ไม่มีตัวเลข' });
      });
    });
    return {
      steps: state.steps.length,
      withWhy: state.steps.filter(function (s) { return !!s.why; }).length,
      withUses: state.steps.filter(function (s) { return s.uses && s.uses.length; }).length,
      hasSetup: !!state.setupG, groups: state.groups.length, hasSanity: !!state.sanity,
      missingWhy: flags, unverified: unverified
    };
  }

  /* ---- LaTeX leak lint --------------------------------------------------
     Anything still spelled as a backslash command in the *rendered* text was
     never typeset and is being shown to a student verbatim. Deliberately
     generic: an allow-list of known commands under-detects, which is exactly
     how \textbf{Thai} and \sum shipped unnoticed. */
  function lintLatex() {
    var hits = [], seen = {};
    var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walk.nextNode())) {
      var el = node.parentElement;
      if (!el || el.closest('script, style, .katex-mathml')) continue;
      var m = (node.nodeValue || '').match(/\\[a-zA-Z]{2,}/g);
      if (!m) continue;
      m.forEach(function (t) { if (!seen[t]) { seen[t] = 1; hits.push(t); } });
    }
    /* Thai inside \text{} is a font-mismatch risk, not a guaranteed blank: the
       browser falls back to a Thai-capable face, so it usually reads — but in
       the wrong typeface, and the fallback is not something we control. Flagged,
       not repaired: lifting Thai out of a \frac numerator is not mechanical. */
    var thaiInMath = [];
    state.steps.concat([{ text: state.problem }]).forEach(function (st) {
      var re = /\\(?:text|textbf|textit|mathrm|mathbf|operatorname)\{([^}]*)\}/g, mm;
      while ((mm = re.exec(st.text || ''))) {
        if (/[\u0E00-\u0E7F]/.test(mm[1])) thaiInMath.push(mm[0].slice(0, 40));
      }
    });
    return { leaked: hits.length, samples: hits.slice(0, 6),
             thaiInMath: thaiInMath.length, thaiSamples: thaiInMath.slice(0, 4),
             repaired: { escapes: texFix.escapes, wrapped: texFix.wrapped } };
  }

  /* ==== JSXGraph: defaults, name guard, lint ==============================
     Three things the fluency test said had to move out of the prompt and into
     code: the palette (JSXGraph defaults are blue/red and break one-colour-one-
     meaning), element labels (not scene-aware — the shell places all text), and
     invented element names (1 page in 10 died on `perpendicularbisector`, which
     sounds real and is not; that must not be able to blank a board again). */

  function stepNo(g) {
    if (!g || !g.getAttribute) return 0;
    return +(g.getAttribute('data-step') || 0) || 0;
  }

  var boardDefaultsDone = false;
  function applyBoardDefaults() {
    if (boardDefaultsDone) return; boardDefaultsDone = true;
    var O = JXG.Options, C = Shell.C, INK = '#6B7688', RULE = '#D9DEE6';

    O.showCopyright = false; O.showNavigation = false; O.showInfobox = false;
    O.text.display = 'internal';          // SVG text, one font, one lint path

    /* the shell owns every piece of text on the page */
    ['point', 'line', 'segment', 'arrow', 'circle', 'curve', 'functiongraph', 'polygon',
     'angle', 'ellipse', 'hyperbola', 'parabola', 'conic', 'arc', 'sector', 'glider',
     'intersection', 'midpoint', 'perpendicular', 'perpendicularsegment', 'parallel',
     'bisector', 'tangent', 'normal', 'circumcircle', 'circumcenter', 'incircle',
     'semicircle', 'regularpolygon', 'reflection', 'mirrorpoint', 'slider',
     /* these four do not just label themselves — they PRINT A NUMBER. An
        `integral` page rendered "&int; = 9.0000" beside an answer card that
        correctly said 4.5: JSXGraph was showing the integral of the upper curve
        alone. A stray second number on the diagram is worse than no label. */
     'integral', 'riemannsum', 'slopetriangle', 'tapemeasure', 'measurement'
    ].forEach(function (k) { if (O[k]) { O[k].withLabel = false;
                                         O[k].label = { visible: false }; } });

    O.point.strokeColor = C.given; O.point.fillColor = C.given;
    O.point.size = 3.5; O.point.fixed = true; O.point.highlight = false;
    O.line.strokeColor = C.work; O.line.strokeWidth = 2.5; O.line.highlight = false;
    O.circle.strokeColor = C.work; O.circle.strokeWidth = 2.5;
    O.circle.fillColor = 'none'; O.circle.fillOpacity = 0; O.circle.highlight = false;
    O.curve.strokeColor = C.work; O.curve.strokeWidth = 2.5; O.curve.highlight = false;
    O.polygon.fillColor = C.given; O.polygon.fillOpacity = 0.10; O.polygon.highlight = false;
    O.polygon.borders = { strokeColor: C.given, strokeWidth: 2.5, highlight: false };
    O.angle.strokeColor = C.note; O.angle.fillColor = C.note;
    O.angle.fillOpacity = 0.20; O.angle.radius = 0.9; O.angle.highlight = false;
    if (O.arrow) { O.arrow.strokeColor = C.work; O.arrow.strokeWidth = 2.5; }
    if (O.sector) { O.sector.fillColor = C.note; O.sector.fillOpacity = 0.18; }

    O.axis.strokeColor = INK; O.axis.strokeWidth = 1.4; O.axis.highlight = false;
    O.axis.ticks = O.axis.ticks || {};
    O.axis.ticks.strokeColor = INK; O.axis.ticks.majorHeight = 8;
    O.axis.ticks.label = { fontSize: 13, strokeColor: INK, display: 'internal' };
    if (O.grid) { O.grid.strokeColor = RULE; O.grid.strokeOpacity = 1; O.grid.strokeWidth = 1; }
  }

  /* names that sound like JSXGraph elements, aren't, and are what the models
     actually reached for. Each one is rewritten to the real construction. */
  var JSX_ALIAS = {
    perpendicularbisector: function (b, p, a) {
      var A = p[0], B = p[1];
      var m = b.create('midpoint', [A, B], { visible: false });
      var l = b.create('line', [A, B], { visible: false });
      return b.create('perpendicular', [l, m], a);
    },
    rightanglemark: function (b, p, a) {
      a = a || {}; a.type = 'square'; if (a.radius == null) a.radius = 0.5;
      return b.create('angle', p, a);
    },
    angularbisector: 'bisector', anglebisector: 'bisector',
    functionplot: 'functiongraph', graph: 'functiongraph',
    vector: 'arrow', linesegment: 'segment',
    perpendicularline: 'perpendicular', parallelline: 'parallel', paralleline: 'parallel',
    circlethroughpoints: 'circumcircle', dot: 'point', label: 'text'
  };

  function stubEl(type) {
    return { __stub: true, elType: type, id: 'sh-stub',
             setAttribute: function () { return this; },
             X: function () { return 0; }, Y: function () { return 0; },
             Value: function () { return 0; }, on: function () { }, remove: function () { } };
  }

  /* an unknown or throwing element must cost one element, never the whole page */
  function guardCreate(b) {
    var orig = b.create.bind(b);
    b.create = function (type, parents, attrs) {
      var t = String(type).toLowerCase().replace(/[\s_-]/g, '');
      var al = JSX_ALIAS[t];
      if (al) {
        state.jsxAliased.push(String(type));
        if (typeof al === 'function') {
          try { return al(b, parents || [], attrs || {}); }
          catch (e) { state.jsxFails.push({ type: String(type), msg: String(e.message || e).slice(0, 120) }); return stubEl(t); }
        }
        type = al; t = al;
      }
      if (!JXG.elements[t]) {
        state.jsxUnknown.push(String(type));
        return stubEl(t);
      }
      try { return orig(type, parents, attrs); }
      catch (e) {
        state.jsxFails.push({ type: String(type), msg: String(e.message || e).slice(0, 120) });
        return stubEl(t);
      }
    };
  }

  function hexToRgb(hx) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hx).trim());
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return 'rgb(' + ((v >> 16) & 255) + ', ' + ((v >> 8) & 255) + ', ' + (v & 255) + ')';
  }

  /* elements whose whole point is that JSXGraph, not the model, computed them */
  var CONSTRUCTIVE = { midpoint: 1, perpendicular: 1, perpendicularsegment: 1,
    perpendicularpoint: 1, intersection: 1, otherintersection: 1, circumcircle: 1,
    circumcenter: 1, circumcirclearc: 1, incircle: 1, incenter: 1, bisector: 1,
    bisectorlines: 1, parallel: 1, parallelpoint: 1, tangent: 1, tangentto: 1, normal: 1,
    reflection: 1, mirrorpoint: 1, mirrorelement: 1, glider: 1, orthogonalprojection: 1,
    polar: 1, polarline: 1, polepoint: 1, radicalaxis: 1, functiongraph: 1, plot: 1,
    conic: 1, ellipse: 1, hyperbola: 1, parabola: 1, implicitcurve: 1, integral: 1,
    derivative: 1, semicircle: 1, regularpolygon: 1, riemannsum: 1, slopetriangle: 1,
    curve: 1, arc: 1, sector: 1, locus: 1, transform: 1, curveintersection: 1 };

  function axisSpec() {
    var INK = '#6B7688';
    return { strokeColor: INK, strokeWidth: 1.4, highlight: false,
             strokeOpacity: 0.9, lastArrow: { size: 5 },
             ticks: { strokeColor: INK, strokeOpacity: 0.6, majorHeight: 8,
                      label: { fontSize: 13, strokeColor: INK, display: 'internal' } } };
  }

  /* ---- board auto-fit ----------------------------------------------------
     The same rule the raw-SVG pages get, applied to the board: a construction
     that fills a quarter of the frame is unreadable, and asking the model in
     the prompt to choose a tight bounding box was obeyed 2 times in 6.
     Deliberately narrow: only bounded content (points, circles, polygons) is
     refitted. If the page draws a curve or a function graph, the window IS a
     mathematical choice — where the asymptote sits, how much of the parabola
     to show — and the shell leaves it alone. */
  function fitBoard() {
    var b = state.board, P = JXG.OBJECT_CLASS_POINT, CI = JXG.OBJECT_CLASS_CIRCLE;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0, hasCurve = false;
    for (var id in b.objects) {
      var o = b.objects[id];
      if (!o || !o.elType || state.jsxBase[id]) continue;
      if (o.elType === 'ticks' || o.elType === 'grid' || o.elType === 'axis') continue;
      if (o.elementClass === JXG.OBJECT_CLASS_CURVE) { hasCurve = true; continue; }
      var xs = null;
      if (o.elementClass === P && isFinite(o.X()) && isFinite(o.Y())) xs = [o.X(), o.X(), o.Y(), o.Y()];
      else if (o.elementClass === CI && typeof o.Radius === 'function') {
        var r = o.Radius(), c = o.center;
        if (isFinite(r) && c) xs = [c.X() - r, c.X() + r, c.Y() - r, c.Y() + r];
      }
      if (!xs) continue;
      minX = Math.min(minX, xs[0]); maxX = Math.max(maxX, xs[1]);
      minY = Math.min(minY, xs[2]); maxY = Math.max(maxY, xs[3]); n++;
    }
    var box = b.getBoundingBox();
    var out = { board: true, changed: false, marks: n, curve: hasCurve };
    if (hasCurve || n < 2) return out;
    var cw = maxX - minX, ch = maxY - minY;
    if (!(cw > 0 || ch > 0)) return out;
    var bw = Math.abs(box[2] - box[0]), bh = Math.abs(box[1] - box[3]);
    out.fill = +Math.max(cw / bw, ch / bh).toFixed(2);
    if (out.fill > 0.72 && out.fill < 1.02) return out;   // already reasonable

    var TARGET = 0.82, ar = W / H;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var w = Math.max(cw / TARGET, (ch / TARGET) * ar, 1e-6);
    var h = w / ar;
    if (h < ch / TARGET) { h = ch / TARGET; w = h * ar; }
    b.setBoundingBox([cx - w / 2, cy + h / 2, cx + w / 2, cy - h / 2], true);
    b.fullUpdate();
    /* text was positioned against the old window; move it with the geometry */
    state.labels.forEach(function (L) {
      if (!L.bxy) return;
      var p = Shell.px(L.bxy[0], L.bxy[1]);
      L.anchor = p;
      L.home = { x: p[0], y: p[1] - (L.bdist || 0) };
      if (L.node.tagName.toLowerCase() === 'text') {
        L.node.setAttribute('x', L.home.x); L.node.setAttribute('y', L.home.y);
      } else {                                  // a KaTeX label lives in a foreignObject
        var fw = +L.node.getAttribute('width') || 220, fh = +L.node.getAttribute('height') || 38;
        L.node.setAttribute('x', L.home.x - fw / 2);
        L.node.setAttribute('y', L.home.y - fh / 2);
      }
    });
    out.changed = true;
    out.after = +Math.max(cw / w, ch / h).toFixed(2);
    return out;
  }

  function lintJsx() {
    if (!state.board) return null;
    var b = state.board, els = 0, constructed = 0, freePoints = 0, ownLabels = 0;
    var kinds = {};
    for (var id in b.objects) {
      var o = b.objects[id];
      if (!o || !o.elType) continue;
      if (state.jsxBase[id]) continue;                         // board scaffolding
      if (o.elType === 'ticks' || o.elType === 'grid') continue;
      /* rule B2: the shell owns every piece of text. A board-created text is a
         label the placer cannot see, so it is counted as a violation, not skipped. */
      if (o.elType === 'text') { if (o.visProp && o.visProp.visible) ownLabels++; continue; }
      els++; kinds[o.elType] = (kinds[o.elType] || 0) + 1;
      if (CONSTRUCTIVE[o.elType]) constructed++;
      /* a point JSXGraph can drag is a point with no parents — i.e. two numbers
         the model typed in rather than a position the geometry determined. */
      else if (o.elType === 'point' && o.isDraggable) freePoints++;
      if (o.hasLabel && o.label && o.label.visProp && o.label.visProp.visible) ownLabels++;
    }
    /* one colour = one meaning, enforced over what actually rendered */
    var ok = {}, off = [], seen = {};
    ['given', 'work', 'answer', 'note', 'warn'].forEach(function (k) {
      var r = hexToRgb(Shell.C[k]); if (r) ok[r] = 1;
    });
    ['rgb(107, 118, 136)', 'rgb(217, 222, 230)', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)'].forEach(
      function (r) { ok[r] = 1; });
    try {
      var svg = state.boardHost.querySelector('svg');
      var marks = svg ? svg.querySelectorAll('path,line,circle,ellipse,polygon,polyline,rect') : [];
      for (var i = 0; i < marks.length; i++) {
        var cs = getComputedStyle(marks[i]);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        var rct = marks[i].getBoundingClientRect();
        if (rct.width < 0.5 && rct.height < 0.5) continue;
        [cs.stroke, cs.fill].forEach(function (c) {
          if (/^context-/.test(c)) return;                       // marker inherit keyword
          if (!c || c === 'none' || /^rgba\(0, 0, 0, 0\)/.test(c)) return;
          var base = c.replace(/^rgba\((.+?), [\d.]+\)$/, 'rgb($1)');
          if (ok[base] || seen[base]) return;
          seen[base] = 1; off.push(base);
        });
      }
    } catch (e) { }
    return { elements: els, constructed: constructed, freePoints: freePoints,
             ownLabels: ownLabels, tied: state.jxg.length,
             unknown: state.jsxUnknown.slice(0, 6), failed: state.jsxFails.slice(0, 6),
             aliased: state.jsxAliased.slice(0, 6), offPalette: off.slice(0, 6), kinds: kinds };
  }

  root.Shell = Shell;
})(window);
