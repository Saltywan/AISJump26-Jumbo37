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
                board: null, boardHost: null, boardFit: null, view: null, jxg: [], tables: [], jsxBase: {},
                jsxUnknown: [], jsxFails: [], jsxAliased: [], jsxRerouted: [], tagFails: [],
                movers: [], instantMotion: false, replaced: 0, badCoord: [] };

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
  var texFix = { escapes: 0, wrapped: 0, tags: 0 };
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
    var t = fixTex(autoMath(html));
    // Outside $...$ a LaTeX command is never typeset — it reaches the student as
    // literal backslash text. The lint flags it; this stops it being ugly meanwhile.
    // Segments inside $...$ are left completely alone for KaTeX.
    return t.split(/(\$[^$]*\$)/).map(function (seg) {
      if (seg.charAt(0) === '$') return seg;
      return seg
        /* A literal \n means "line break" only when it is NOT the head of a LaTeX
           command. \neq, \ne, \nu, \nabla and \not all start this way, and the
           blanket replace turned every one of them into "<br>eq", "<br>u" and so
           on — \neq alone appears 9 times across the reference pages. Thai text
           after a real break is non-ASCII, so refusing to break before an ASCII
           letter keeps genuine line breaks working. Math spans are never touched. */
        .replace(/\\n(?![A-Za-z])/g, '<br>')
        .replace(/\r?\n/g, '<br>')
        .replace(/\\textbf\{([^}]*)\}/g, '<b>$1</b>')
        .replace(/\\textit\{([^}]*)\}/g, '<i>$1</i>')
        .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1');
    }).join('');
  }
  /* same clean-up for SVG <text>, where HTML tags would render literally */
  function plainify(text) {
    return fixTex(autoMath(text)).split(/(\$[^$]*\$)/).map(function (seg) {
      if (seg.charAt(0) === '$') return seg;
      return seg
        .replace(/\\(?:textbf|textit|text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
        /* An SVG <text> has no HTML in it. Prompt rule 2.5 tells the model to use
           <b> for bold Thai, which is right in the step panel and wrong in a
           label — one page rendered "<b>10</b>" eight times, literally, inside a
           Venn diagram. Strip the tags rather than show them. */
        .replace(/<\/?(?:b|i|em|strong|br|sub|sup|span|small)\s*\/?>/gi,
                 function () { texFix.tags++; return ''; });
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
      /* Calling Shell.board() or Shell.canvas() first is against the documented
         order, but it happens — the model wrote it that way on 3 of 109 pages
         checked, including one generated today. Those calls auto-init the frame
         by calling this with no arguments, and this function then built a SECOND
         complete frame when the page made its own Shell.page() call: a stray
         empty header above the diagram, the real header stranded below it, two
         button bars, and the steps repointed into a frame the board was not in.
         Every check scored those pages clean, because a .sh-stage svg does
         exist — it is just in the wrong one of two frames.
         So fill the header in rather than building over the top of it. */
      if (state.built) {
        if (state.head) {
          var hEl = state.head.querySelector('h1');
          if (hEl && o.title) hEl.textContent = o.title;
          var pEl = state.head.querySelector('.sh-problem');
          if (pEl && o.problem) pEl.textContent = o.problem;
          if (o.level && !state.head.querySelector('.sh-level'))
            h('span', 'sh-level', state.head, 'ระดับชั้น: ' + o.level);
        }
        if (o.problem) state.problem = o.problem;
        if (o.level) state.level = o.level;
        return;
      }
      var wrap = h('div', 'sh-wrap', document.body);
      var head = h('div', 'sh-head', wrap);
      state.head = head;
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

    /* ---- a 3D view, for solids and space vectors --------------------------
       ม.1–ม.3 needs cones, spheres and prisms; ม.5 needs 3-D vectors. JSXGraph
       can do all of it, but the entry point is easy to get wrong: 3D elements
       are created on the VIEW, not the board — board.create('point3d', ...)
       throws outright. Shell.view3d() returns the view, and the shell also
       reroutes any *3d element mistakenly created on the board. */
    view3d: function (o) {
      o = o || {};
      var b = state.board || Shell.board({ axis: false, grid: false,
                                           box: o.box || [-8, 4.5, 8, -4.5] });
      if (state.view) return state.view;
      var bounds = o.bounds || [[-5, 5], [-5, 5], [-5, 5]];
      var v = b.create('view3d',
        [o.at || [-6, -3], o.size || [8, 8], bounds],
        { projection: o.projection || 'central',
          trackball: { enabled: false },
          depthOrderPoints: true,
          axesPosition: 'border' });
      /* The 3D axes and walls are objects hanging off view.defaultAxes, not
         creation attributes — passing xAxis/xPlaneRear to initBoard silently does
         nothing. JSXGraph's defaults put an orange tick label on every unit along
         three edges, which reads as noise around the figure, and paint the walls
         its own greys. Same rule as everywhere else: the shell owns the chrome. */
      styleView(v);
      state.view = v;
      /* the view's walls, axes and ticks are scaffolding, exactly like the
         board's — re-snapshot so the lint keeps counting authored elements only */
      for (var vid in b.objects) state.jsxBase[vid] = 1;
      guardCreate(v, true);
      return v;
    },

    /* board user coordinates -> the 960 x 540 frame the shell places text in */
    px: function (x, y) {
      if (!state.board) return [x, y];
      var c = new JXG.Coords(JXG.COORDS_BY_USER, [x, y], state.board).scrCoords;
      return [c[1], c[2]];
    },

    /* 3-D user coordinates -> the 960 x 540 frame, via the view's projection */
    px3: function (x, y, z) {
      if (!state.view) return [x, y];
      var p = state.view.create('point3d', [x, y, z], { visible: false });
      var q = Shell.px(p.element2D.X(), p.element2D.Y());
      try { state.board.removeObject(p); } catch (e) { }
      return q;
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
      var p = tagPoint(target);
      if (!p) {                       // nothing usable: say so rather than emit NaN
        state.tagFails.push(String((target && target.elType) || typeof target));
        p = [W / 2, H / 2];
      }
      var d = o.dist == null ? 22 : o.dist;
      var g = Shell.label(parent, p[0], p[1] - d, text,
        { role: o.role, until: o.until, anchor: p, size: o.size, align: o.align });
      var L = state.labels[state.labels.length - 1];
      if (L && target && target.X && !target.element2D) { L.bxy = [target.X(), target.Y()]; L.bdist = d; }
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
          /* A chip is a promise that clicking it takes you back to where a value
             came from. A citation of this step or a later one cannot keep that
             promise, so it is not drawn; the lint reports it instead. */
          if (!(u >= 1 && u < n)) return;
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

    /* ---- motion: something that MOVES, not something that appears --------
       The recede/stroke-draw motion already in the shell animates REVEAL —
       something fading in or drawing itself once. This is for the other kind
       of motion the syllabus needs: a projectile flying its parabola, two
       carts approaching and separating, a point tracing out a graph, a ray
       crossing a lens. One call, three ways to use it, chosen by `mover`:

       omit it (SVG)  — Shell.motion creates and returns ONE fresh <g> (same
                     contract as every other creating call), already placed
                     at the path's start. Draw your icon INSIDE it centred on
                     (0,0) — the shell moves the <g> itself via transform, so
                     the icon never has to know where it is.
       pass a <g> you already drew (SVG) — the shell moves THAT element
                     instead of making a new one, and returns it unchanged.
                     Use this to carry one actor through more than one
                     Shell.motion call across steps (approach, then separate).
                     Position it yourself before the first leg — the shell
                     never repositions an element you handed in until its
                     step is actually reached, so its starting pose is
                     whatever you drew, and the LAST leg's end position must
                     equal the NEXT leg's first waypoint or it will jump.
       pass an existing point (board) — b.create('point',...) or
                     ('glider',...). Nothing is created; the shell drives
                     that point's coordinates and returns the same point,
                     exactly like Shell.on hands back what you gave it. Same
                     multi-leg rule as above: position it at the first
                     waypoint yourself if this isn't its first leg.

       `path` is either a function t (0..1) -> [x,y], or an array of 2+
       waypoints: 2 points = a straight line, 3 = a quadratic Bezier (the
       natural shape for a parabola — start, apex-ish control point, end),
       4+ = a polyline through every waypoint (a bent light ray, a bounce).
       Coordinates are the 960x540 frame in SVG mode (board coordinates with
       {board:true}), and always board coordinates in board mode.

       Runs once when its step is revealed and holds the end position — it
       does not replay just because you click forward past it again, same as
       stroke-draw. Going back past its step resets it, so replaying the
       whole page from the top plays it again. Under prefers-reduced-motion,
       and always inside Shell.showAll() (thumbnails must be the FINISHED
       frame, not a random mid-flight one), it jumps straight to the end —
       the same guarantee stroke-draw already gives label placement: motion
       never changes where anything ends up. */
    motion: function (parent, mover, path, o) {
      o = o || {};
      var born = stepNo(parent) || (state.steps.length || 1);
      var isBoard = mover && typeof mover.X === 'function' && typeof mover.setPosition === 'function';
      /* board-mode always wants board user coordinates — that IS the space
         setPosition(COORDS_BY_USER,...) consumes, so it must never be run
         through Shell.px. {board:true} is for the OTHER case: an SVG mover
         (or an SVG overlay path) whose waypoints were written in board
         coordinates for convenience and need pixel-frame conversion once. */
      var fn = buildMotionPath(path, (!isBoard && o.board) ? Shell.px : null);
      var M = { path: fn, dur: o.dur > 0 ? o.dur : 900,
                ease: o.ease === 'linear' ? function (t) { return t; } : smoothstep,
                rotate: !!o.rotate, loop: !!o.loop, onFrame: typeof o.onFrame === 'function' ? o.onFrame : null,
                born: born, phase: 'idle', raf: null, start: null, dir: 1 };
      if (isBoard) {
        M.kind = 'board'; M.el = mover;          // an element you placed yourself: leave it alone
      } else if (mover && typeof mover.setAttribute === 'function') {
        M.kind = 'svg'; M.el = mover;             // ditto — trust the pose you already drew
      } else {
        M.kind = 'svg';
        M.el = el('g', { 'data-motion': '1' }, parent);   // brand new: nothing else placed it, so we must
        setMoverFrame(M, fn(0), 0);
      }
      state.movers.push(M);
      return M.el;
    },

    /* ---- a label that knows what it points at, and how long it lives ------
       until: 'end'  (default) stays once revealed
              'step'          disappears when the next step begins
              <number>        disappears after that step number          */
    label: function (parent, x, y, text, o) {
      o = o || {};
      /* A page that miscomputes a coordinate hands us NaN, and it reaches the
         SVG as x="NaN": twelve console errors on one high-effort page, and the
         label is simply not drawn. Shell.tag already refuses to emit NaN; a bare
         Shell.label did not. Seat it at the frame centre so the text is at least
         readable and the placer can move it somewhere sane, and record it. */
      if (!isFinite(+x) || !isFinite(+y)) {
        state.badCoord.push(String(text).slice(0, 30));
        x = isFinite(+x) ? +x : W / 2;
        y = isFinite(+y) ? +y : H / 2;
      }
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
        /* A foreignObject clips whatever overflows its box, and this box is sized
           at creation — before KaTeX has rendered anything into it. Long
           expressions were therefore cut off mid-equation: 13 of 105 labels
           across the golden set, the worst holding 113px of content in a 98px
           box. Resizing the box after the fact was tried twice, before and after
           autoFit, and made it worse both times (20 and then 59 clipped) because
           the scale it measures against is still moving. Telling the element not
           to clip is the whole fix: nothing is resized, so label placement is
           untouched, and the equation simply renders in full. */
        var fo = el('foreignObject', { x: x - 110, y: y - 19, width: 220, height: 38,
                                       overflow: 'visible' }, g);
        fo.style.overflow = 'visible';
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
      /* Third time for this pattern. A page that writes M11 at (600,290) in
         step 2, M12 there in step 3 and M13 there again in step 4 is REPLACING a
         value, not stacking three — but with the default lifetime all three live
         to the end, so the placer had to fling them apart and drew leader lines
         a quarter of the frame long getting back to their anchors. Tables and
         matrices already retire a predecessor at the same origin; a bare label
         is the same story, so it does too. */
      if (dies === Infinity && !o.keep) {
        for (var q = 0; q < state.labels.length; q++) {
          var P = state.labels[q];
          if (P.dies === Infinity && P.born < born &&
              Math.abs(P.home.x - x) < 6 && Math.abs(P.home.y - y) < 6) {
            P.dies = born - 1;
            state.replaced++;
          }
        }
      }
      state.labels.push({ g: g, node: node, home: { x: x, y: y }, bxy: bxy, bdist: 0,
                          anchor: o.anchor || [x, y], dx: 0, dy: 0, role: role,
                          pin: !!o.pin, born: born, dies: dies });
      return g;
    },

    /* ---- a table: the thing 54 hand-placed labels were pretending to be ----
       A truth table, a data table, a frequency table. Every cell is pinned, so
       the placer can never shuffle a column, and the whole thing costs the
       optimiser nothing because pinned labels have one candidate each.
         rows[0] is the header. roles[] colours the columns.               */
    table: function (parent, x, y, rows, o) {
      o = o || {};
      var g = el('g', { 'data-table': '1' }, parent);
      if (!rows || !rows.length || !rows[0] || !rows[0].length) return g;
      var cols = rows[0].length;
      var num = function (v, d) { v = +v; return isFinite(v) && v > 0 ? v : d; };
      /* colW may be one width or a width per column. A generated page passed
         [60, 60, 60] — the obvious reading — and the first version did arithmetic
         on the array and emitted width="NaN" across 244 console errors. An API's
         surface is what it ACCEPTS, not only what it is called. */
      var dflt = Math.round(Math.min(120, 560 / cols)), widths = [], i;
      for (i = 0; i < cols; i++)
        widths.push(Array.isArray(o.colW) ? num(o.colW[i], dflt) : num(o.colW, dflt));
      x = isFinite(+x) ? +x : 0;
      y = isFinite(+y) ? +y : 0;
      var xs = [x];
      for (i = 0; i < cols; i++) xs.push(xs[i] + widths[i]);
      /* a KaTeX cell renders taller than a plain line at the same size, so a
         maths table needs more room between rows than a text one */
      var mathy = rows.some(function (rr) { return rr.some(function (c) {
        return c != null && String(c).indexOf('$') >= 0; }); });
      var rh = num(o.rowH, mathy ? 36 : 30), wTot = xs[cols] - x, hTot = rh * rows.length;

      el('rect', { x: x, y: y, width: wTot, height: hTot, fill: 'none',
                   stroke: Shell.C.note, 'stroke-width': 1.2, rx: 3 }, g);
      for (var c = 1; c < cols; c++)
        el('line', { x1: xs[c], y1: y, x2: xs[c], y2: y + hTot,
                     stroke: Shell.C.note, 'stroke-width': 0.8, opacity: 0.55 }, g);
      for (var r = 1; r < rows.length; r++)
        el('line', { x1: x, y1: y + r * rh, x2: x + wTot, y2: y + r * rh,
                     stroke: Shell.C.note, 'stroke-width': r === 1 ? 1.2 : 0.8,
                     opacity: r === 1 ? 1 : 0.45 }, g);
      rows.forEach(function (row, r) {
        row.forEach(function (cell, c) {
          if (cell == null || cell === '' || c >= cols) return;
          var role = r === 0 ? 'note' : ((o.roles && o.roles[c]) || 'work');
          Shell.label(g, xs[c] + widths[c] / 2, y + r * rh + rh / 2, String(cell),
            { role: role, pin: true, size: o.size || 17,
              weight: r === 0 ? 700 : 600, until: o.until });
        });
      });

      /* The grid lines must follow the same timeline as the cells, or a retired
         table leaves its frame behind. And a table drawn over an earlier one is a
         progressive reveal — four landed on the same origin on one page — so the
         earlier one retires instead of stacking. */
      return retireAt(g, x, y, o.until);
    },

    /* ---- a matrix, with brackets ------------------------------------------
       Matrices were being hand-built out of free labels: one page created 23 of
       them, none transient, and drew the same value twice in different steps so
       that "16" collided with itself. Cells are pinned, so a column can never
       drift, and the group remembers its own geometry so a later step can point
       at a row, a column or a single entry without recomputing coordinates. */
    matrix: function (parent, x, y, rows, o) {
      o = o || {};
      var g = el('g', { 'data-matrix': '1' }, parent);
      if (!rows || !rows.length || !rows[0] || !rows[0].length) return g;
      var nr = rows.length, nc = rows[0].length;
      var fin = function (v, d) { v = +v; return isFinite(v) && v > 0 ? v : d; };
      var cw = fin(o.cellW, 46), ch = fin(o.cellH, 38), pad = 10;
      x = isFinite(+x) ? +x : 0; y = isFinite(+y) ? +y : 0;
      var Wm = nc * cw + pad * 2, Hm = nr * ch;
      var col = Shell.C[o.role] || Shell.C.given, ear = 7;

      el('path', { d: 'M ' + (x + ear) + ' ' + y + ' L ' + x + ' ' + y +
                      ' L ' + x + ' ' + (y + Hm) + ' L ' + (x + ear) + ' ' + (y + Hm),
                   fill: 'none', stroke: col, 'stroke-width': 2,
                   'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      el('path', { d: 'M ' + (x + Wm - ear) + ' ' + y + ' L ' + (x + Wm) + ' ' + y +
                      ' L ' + (x + Wm) + ' ' + (y + Hm) + ' L ' + (x + Wm - ear) + ' ' + (y + Hm),
                   fill: 'none', stroke: col, 'stroke-width': 2,
                   'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);

      if (o.name) Shell.label(g, x + Wm / 2, y - 18, o.name,
                              { role: o.role || 'given', pin: true, size: 19 });
      rows.forEach(function (row, i) {
        row.forEach(function (cell, j) {
          if (cell == null || cell === '' || j >= nc) return;
          Shell.label(g, x + pad + (j + 0.5) * cw, y + (i + 0.5) * ch, String(cell),
            { role: o.role || 'given', pin: true, size: o.size || 18, until: o.until });
        });
      });
      /* geometry the highlight calls read back, so the page never does this arithmetic */
      g.__m = { x: x, y: y, cw: cw, ch: ch, nr: nr, nc: nc, pad: pad, w: Wm, h: Hm };
      return retireAt(g, x, y, o.until);
    },

    /* ---- point at part of a matrix ----------------------------------------
       Shell.mark(s2, mA, {row:1}) / {col:2} / {cell:[1,2]}
       Transient BY DEFAULT. A highlight is a gesture, not a fact: the page that
       collided had four of them alive at once because every one was permanent.
       Pass until:'end' only if the emphasis genuinely belongs to the answer. */
    mark: function (parent, mg, o) {
      o = o || {};
      var g = el('g', { 'data-mark': '1' }, parent);
      var m = mg && mg.__m;
      if (!m) return g;
      var role = o.role || 'work', col = Shell.C[role] || Shell.C.work;
      var bx = m.x, by = m.y, bw = m.w, bh = m.h;
      if (o.cell) {
        bx = m.x + m.pad + (o.cell[1] - 1) * m.cw; bw = m.cw;
        by = m.y + (o.cell[0] - 1) * m.ch;         bh = m.ch;
      } else if (o.row) {
        by = m.y + (o.row - 1) * m.ch; bh = m.ch;
        bx = m.x + m.pad - 3; bw = m.nc * m.cw + 6;
      } else if (o.col) {
        bx = m.x + m.pad + (o.col - 1) * m.cw; bw = m.cw;
      }
      el('rect', { x: bx + 1, y: by + 1, width: Math.max(0, bw - 2),
                   height: Math.max(0, bh - 2), rx: 5,
                   fill: col, 'fill-opacity': 0.14, stroke: col,
                   'stroke-width': 1.6, 'stroke-dasharray': '5 3' }, g);
      var hb = state.steps.length || 1;
      state.tables.push({ g: g, x: -1, y: -1, born: hb,
        dies: o.until === 'end' ? Infinity
            : (typeof o.until === 'number' ? o.until : hb) });
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
      try { checks.drawn = armStrokeDraw(); } catch (e) { checks.drawn = 0; }
      try { checks.contrast = scanContrast(state.stage).slice(0, 6); }
      catch (e) { checks.contrast = []; }
      root.__shellCheck = checks;
      root.__scaleWarnings = checks.magnitude;
      Shell.replay();
      root.__done = true;
      return checks;
    },

    /* jump straight to the finished frame — what the review pane and thumbnail need */
    showAll: function () {
      clearTimeout(state.timer);
      state.instantMotion = true;          // thumbnails need the FINISHED frame, not mid-flight
      Shell.go(state.steps.length, true);
      state.instantMotion = false;
      return state.steps.length;
    },

    /* move to step n (1..N); n = N means finished, answer shown */
    go: function (n, silent) {
      if (!silent) clearTimeout(state.timer);
      var N = state.steps.length;
      n = Math.max(0, Math.min(N, n));
      state.at = n;
      /* Everything that has been revealed used to stay at full strength, so by
         the last step the drawing shouted all of itself at once — which is both
         why the pages read as static and why labels pile up. Earlier work now
         recedes while a step is current, and returns to full on the final frame
         so the finished picture is still the finished picture. */
      var mid = n > 0 && n < N;
      state.steps.forEach(function (s) {
        var on = s.n <= n;
        s.box.classList.toggle('sh-on', on);
        s.box.classList.toggle('sh-cur', s.n === n);
        s.g.classList.toggle('sh-on', on);
        s.g.classList.toggle('sh-past', mid && on && s.n < n);
        s.g.classList.toggle('sh-now', on && s.n === n);
      });
      // a label lives from the step that created it until its `dies` step
      state.labels.forEach(function (L) {
        var alive = n >= L.born && n <= L.dies;
        L.g.style.opacity = alive ? '' : '0';
        L.g.style.pointerEvents = alive ? '' : 'none';
      });
      state.tables.forEach(function (t) {
        t.g.style.opacity = (n >= t.born && n <= t.dies) ? '' : '0';
      });
      if (state.jxg.length && state.board) {
        try { state.board.suspendUpdate(); } catch (e) { }
        state.jxg.forEach(function (J) {
          var alive = n >= J.born && n <= J.dies;
          try { J.el.setAttribute({ visible: alive }); } catch (e) { }
          /* the CSS draw-in keys off sh-on, which board elements never had */
          try {
            var nd = renderNodeOf(J.el);
            if (nd && nd.classList) nd.classList.toggle('sh-on', alive && n >= J.born);
          } catch (e2) { }
        });
        try { state.board.unsuspendUpdate(); } catch (e) { }
      }
      state.movers.forEach(function (M) {
        if (n >= M.born) { if (M.phase !== 'playing' && M.phase !== 'done') playMover(M); }
        else resetMover(M);
      });
      /* The diagram is sticky so it follows the reader down, but nothing kept
         the step being explained on screen. On a seven-step page the last two
         sat 119 and 291 px below the fold: the picture was being narrated by
         text the reader could not see. Scroll the current step into view — with
         'nearest', so a step already visible is left alone and the page never
         jumps under someone who is reading. */
      if (n >= 1 && !state.instantMotion) {
        /* On the last step the thing worth seeing is the answer, not the step
           that produced it. Scrolling to the step left the green card clipped at
           the bottom of the viewport on every page measured, at both widths —
           the payoff was the one part never fully shown. */
        var cur = (n >= N && state.answerEls.length)
          ? { box: state.answerEls[state.answerEls.length - 1] }
          : state.steps[n - 1];
        if (cur && cur.box && cur.box.scrollIntoView) {
          try {
            cur.box.scrollIntoView({ block: 'nearest', inline: 'nearest',
                                     behavior: reduced() ? 'auto' : 'smooth' });
          } catch (e) { try { cur.box.scrollIntoView(false); } catch (e2) { } }
        }
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
      var dwell = state.steps.map(stepDwell);
      var i = 1;
      state.timer = setTimeout(function tick() {
        Shell.go(i, true);
        var d = dwell[i - 1] || 1400;
        if (i++ < N) state.timer = setTimeout(tick, d);
      }, dwell[0] || 1400);
      root.__pacingMs = dwell.reduce(function (a, b) { return a + b; }, 0);
      root.__pacingPer = dwell;
    }
  };

  /* How long a step should stay on screen. A flat 1500 ms was fine when every
     step just faded in, but a step now may draw a line in (550 ms) and run a
     motion (900 ms by default), which left almost no time to read the sentence
     that explains it — the animation outran its own explanation. Dwell is the
     time the step's own animation needs, plus time to read its prose, plus a
     beat to take it in. */
  function stepDwell(st) {
    var text = String(st.text || '').replace(/<[^>]*>/g, '');
    var read = Math.min(2600, text.length * 26);          // Thai reads slower than Latin
    var anim = 0;
    state.movers.forEach(function (M) {
      if (M.born === st.n) anim = Math.max(anim, M.dur || 900);
    });
    if (st.g) {
      var drawn = st.g.querySelectorAll('.sh-draw').length;
      if (drawn) {
        var longest = 0;
        st.g.querySelectorAll('.sh-draw').forEach(function (d) {
          longest = Math.max(longest, parseInt(d.style.transitionDuration) || 850);
        });
        anim = Math.max(anim, longest + Math.min(900, (drawn - 1) * 110));
      }
    }
    if (st.why) read += 700;
    return Math.max(1500, Math.min(6000, 650 + read + anim));
  }

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
    /* Labels must not DRIVE the fit (a huge callout should not zoom the page
       out around itself) — k above is computed from geometry alone and stays
       that way. But a fit computed from geometry alone can still CROP the
       room a label needs beside its anchor: autoFit recenters on the
       geometry's box, and when a label was authored to sit outside that box
       (ordinary — explanation text beside a small diagram) the recentred
       frame can end up so tight that the label's own authored position no
       longer fits inside the new viewBox. The placer then can't find any
       candidate that isn't clipped and flees to whatever sliver of the frame
       is left — sometimes the far corner.
       Fix by PANNING first, not zooming: re-centre on geometry-plus-label-
       reach instead of geometry alone, at the SAME k. A pan changes no
       label's distance to any other label, so it cannot make an already-
       tight cluster worse — it only stops the frame's edge from landing on
       top of an anchor. Only if panning genuinely cannot fit everything (the
       reach is wider than the whole frame at this k) do we fall back to
       reducing k, and then only by the minimum needed — never by recomputing
       TARGET fill from the extended box, which shrank the WHOLE page's zoom
       for one wide label and cost q6_energy a fresh collision between two
       otherwise-settled labels when tried. */
    var svgR0 = state.svg.getBoundingClientRect();
    var vb0 = (state.svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    var vw0 = vb0.length === 4 ? vb0[2] : W, vh0 = vb0.length === 4 ? vb0[3] : H;
    var sx0 = vw0 / (svgR0.width || vw0), sy0 = vh0 / (svgR0.height || vh0);
    var rMinX = bb.x, rMinY = bb.y, rMaxX = bb.x + bb.width, rMaxY = bb.y + bb.height;
    state.labels.forEach(function (L) {
      if (L.pin) return;                      // pinned labels don't roam; nothing to reserve
      var node = L.g.__mathDiv || L.node;
      var r; try { r = node.getBoundingClientRect(); } catch (e) { return; }
      if (!r || (!r.width && !r.height)) return;
      var hw = r.width * sx0 / 2 + 8, hh = r.height * sy0 / 2 + 8;
      /* Reserve room around BOTH the anchor and the spot the label was actually
         authored at. Covering only the anchor left the home outside the frame
         whenever a page placed a label some distance from what it points at —
         which is exactly what a caption does — and a home outside the frame is
         filtered out, which is the whole failure this fix exists to prevent. */
      [[L.anchor[0], L.anchor[1]], [L.home.x, L.home.y]].forEach(function (q) {
        rMinX = Math.min(rMinX, q[0] - hw); rMinY = Math.min(rMinY, q[1] - hh);
        rMaxX = Math.max(rMaxX, q[0] + hw); rMaxY = Math.max(rMaxY, q[1] + hh);
      });
    });
    var reachW = rMaxX - rMinX, reachH = rMaxY - rMinY;
    if (reachW > nw || reachH > nh) {                 // panning alone can't fit the reach
      var k2 = Math.min(k, W / reachW, H / reachH);
      k = Math.max(MINK, Math.min(MAXK, k2));
      nw = W / k; nh = H / k;
    }
    cx = rMinX + reachW / 2; cy = rMinY + reachH / 2;
    /* keep the geometry itself inside the frame even if the reach pan alone
       would push it to one side (a label reaching far right of a diagram
       hugging the left edge, say) */
    cx = Math.max(bb.x + bb.width - nw / 2, Math.min(bb.x + nw / 2, cx));
    cy = Math.max(bb.y + bb.height - nh / 2, Math.min(bb.y + nh / 2, cy));
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
  var W_FAR = 900;      // flat toll for leaving leader range at all

  function roleWeight(a, b) {
    var heavy = { answer: 4, given: 3, work: 2, note: 1, warn: 4 };
    return (heavy[a] || 1) * (heavy[b] || 1);
  }
  function areaOverlap(A, B) {
    var ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
    var oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
    return (ox > 0 && oy > 0) ? ox * oy : 0;
  }
  function strokeHits(B, pts, it) {
    var n = 0, dies = it ? it.dies : Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      /* co-visibility, same rule the labels already use on each other: a stroke
         that only appears after this label is gone is not an obstacle for it */
      if (p.born > dies) continue;
      if (p.x > B.x && p.x < B.x + B.w && p.y > B.y && p.y < B.y + B.h) n++;
    }
    return n;
  }

  var BAND_GAP = 4, BAND_TRIES = [1, 1.6, 2.3];   // stagger amplitudes, in label-heights

  function inGrid(it) {
    return !!(it && it.g && it.g.closest && it.g.closest('[data-table],[data-matrix]'));
  }

  /* Returns how many labels it actually moved. Nothing else can tell whether
     this ran: it only fires where co-visible labels overlap side-by-side, so
     a page with no crowding never enters it and a suite of uncrowded pages
     stays green no matter what state this function is in. A merge shipped it
     broken twice that way. The count is what makes a page's claim to exercise
     this path checkable instead of assumed. */
  function bandDecrowd(L, vx, vy, vw, vh) {
    var n = L.length;
    if (n < 2) return 0;
    var parent = []; for (var i = 0; i < n; i++) parent.push(i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function overlaps(A, B) {
      return A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
    }
    var inCluster = {};
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
      if (!coVisible(L[a], L[b])) continue;
      var A = L[a].box, B = L[b].box;
      if (!overlaps(A, B)) continue;
      var dx = Math.abs((A.x + A.w / 2) - (B.x + B.w / 2));
      var dy = Math.abs((A.y + A.h / 2) - (B.y + B.h / 2));
      if (dx < dy) continue;                      // stacked, not side-by-side: not this fix
      /* A table or matrix cell is horizontal-dominant by construction, so a row
         of them looks exactly like a crowded caption band to the test above. It
         is not one: those grids are the one place where a label's exact position
         IS the fact, and staggering a cell out of its column is worse than
         letting it overlap. No page currently trips this — the truth-table page
         has 162 pinned cells and moves none — but that is the grid being wide
         enough, not the rule being stated, so state it. */
      if (inGrid(L[a]) || inGrid(L[b])) continue;
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
      inCluster[a] = inCluster[b] = true;
    }
    var byRoot = {};
    Object.keys(inCluster).forEach(function (k) {
      var r = find(+k);
      (byRoot[r] = byRoot[r] || []).push(+k);
    });
    var movedCount = 0;
    Object.keys(byRoot).forEach(function (r) {
      var idxs = byRoot[r];
      if (idxs.length < 2) return;
      idxs.sort(function (p, q) { return L[p].box.x - L[q].box.x; });
      var startY = idxs.map(function (idx) { return L[idx].box.y; });
      var lo = vy + MARGIN, hiFor = function (idx) { return vy + vh - MARGIN - L[idx].box.h; };
      /* Score LEAVING IT ALONE first, and make that the bar every stagger has to
         beat. With bestScore seeded at Infinity the first arrangement tried won
         unconditionally, so this pass could — and did — make a page worse than
         if it had never run: m24_2 went from 3 collisions to 6, shuffling two
         rows of a dot product whose authored positions were 55 units apart onto
         the same band. Excluding pinned labels here looks like the fix and is
         not: p03_2 ends up with FEWER collisions precisely because its pinned
         labels are allowed to stagger. The rule is not "never move a pin", it is
         "never accept a move that does not help". */
      var bestY = startY.slice(), bestScore = collisions(L);
      /* Try both phases of the alternation (which side the first item lands
         on) at each amplitude — something above or below the strip (an arrow
         label, a neighbouring cluster) can make one phase land a specific
         caption right on top of it while the other phase clears everything,
         and there is no way to know which without a page's actual content. */
      for (var t = 0; t < BAND_TRIES.length; t++) {
        var mul = BAND_TRIES[t];
        for (var phase = 0; phase < 2; phase++) {
          var tryY = idxs.map(function (idx, k) {
            var it = L[idx], off = (it.box.h / 2 + BAND_GAP) * mul;
            var goesUp = ((k + phase) % 2 === 0);
            var y = startY[k] + (goesUp ? -off : off);
            return Math.max(lo, Math.min(hiFor(idx), y));
          });
          idxs.forEach(function (idx, k) { L[idx].box.y = tryY[k]; });
          // score = collisions across the WHOLE page, not just this cluster —
          // stretching a caption row must not shove it into an arrow label or
          // another cluster sitting just above or below the band.
          var score = collisions(L);
          if (score < bestScore) { bestScore = score; bestY = tryY.slice(); }
        }
        if (bestScore === 0) break;
      }
      idxs.forEach(function (idx, k) { L[idx].box.y = bestY[k]; });
      idxs.forEach(function (idx, k) {
        if (Math.abs(bestY[k] - startY[k]) > 0.01) movedCount++;
      });
      /* A strict alternation is only load-bearing between neighbours that
         actually touch — item 3 and item 5 sharing a side is fine, they
         don't overlap each other. But something ABOVE or BELOW the strip
         (an arrow label, here) rarely lines up with every band evenly, so
         one caption in the middle of an otherwise-clear run can still be on
         the wrong side of it while its neighbours are both fine. Flipping
         one item at a time — never breaking the pairwise separation that
         got the cluster this far — catches exactly that case without the
         combinatorial cost of searching every up/down combination. */
      if (bestScore > 0) {
        for (var rep = 0; rep < 2 && bestScore > 0; rep++) {
          var improvedAny = false;
          idxs.forEach(function (idx, k) {
            var applied = bestY[k] - startY[k];
            if (Math.abs(applied) < 0.01) return;
            var flip = Math.max(lo, Math.min(hiFor(idx), startY[k] - applied));
            var prev = L[idx].box.y;
            L[idx].box.y = flip;
            var score = collisions(L);
            if (score < bestScore) {
              bestScore = score; bestY[k] = flip; improvedAny = true;
            } else {
              L[idx].box.y = prev;
            }
          });
          if (!improvedAny) break;
        }
      }
      /* Still stuck: something on ITS side of the strip is crowding this one
         item specifically (an arrow label the others happened to clear, a
         neighbouring cluster) and flipping to the other side only trades that
         collision for one with the item's own neighbours in this cluster,
         which the flip step above already tried and correctly refused. The
         remaining lever that does not touch a neighbour at all is to push
         this one item further out along the side it is already on. */
      if (bestScore > 0) {
        var PUSH = [1.6, 2.3, 3.1, 4.2];
        for (var pi = 0; pi < PUSH.length && bestScore > 0; pi++) {
          idxs.forEach(function (idx, k) {
            if (bestScore <= 0) return;
            var applied = bestY[k] - startY[k];
            if (Math.abs(applied) < 0.01) return;          // this one never moved
            var it = L[idx];
            var unitOff = (it.box.h / 2 + BAND_GAP) * (applied < 0 ? -1 : 1);
            var pushed = Math.max(lo, Math.min(hiFor(idx), startY[k] + unitOff * PUSH[pi]));
            var prev = L[idx].box.y;
            L[idx].box.y = pushed;
            var score = collisions(L);
            if (score < bestScore) { bestScore = score; bestY[k] = pushed; }
            else { L[idx].box.y = prev; }
          });
        }
      }
    });
    return movedCount;
  }

  /* two labels only conflict if they are ever on screen together */  function placeLabels() {
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
      /* A pinned label's position IS its meaning — a truth-table cell, a branch
         probability, a tick on a number line. Moving it does not tidy the
         picture, it changes what the picture says. So a pinned label gets one
         candidate (where the author put it) and still counts as an obstacle
         everything else has to route around. */
      if (it.pin) { it.cands = cands; it.baseDist = 1e9; return; }
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
      /* A candidate further from its anchor than a leader line can usefully span
         is not a placement, it is a guess: the reader sees text with no visible
         tie to what it describes. Exile is therefore removed from the menu
         rather than being allowed and then hidden. The trade was measured over
         82 pages — exiled labels fell from 34 to 4 (the 4 being frames where the
         home is still cropped) at a cost of two extra collisions across 68
         generated pages, and none on the golden set. An overlap near the right
         place beats a clean seat in the wrong one. The full candidate set is
         kept when nothing at all is within range. */
      it.homeKept = it.cands.some(function (c) { return c.ring === 0; });
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
        if (!isFinite(cost)) cost = 1e12;      // a non-finite cost is still a ranking
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      /* One unplaceable label used to throw here and take the whole page's label
         placement with it — 5 collisions and 0 labels registered on a page whose
         only real fault was a single NaN coordinate. */
      if (!best) best = it.cands[0] || { x: it.base.x, y: it.base.y, ring: 0, dir: 0 };
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

    var decrowded = bandDecrowd(L, vx, vy, vw, vh) || 0;
    var far = 0, farNoHome = 0;
    L.forEach(function (it) {
      var dx = it.box.x - it.base.x, dy = it.box.y - it.base.y;
      it.dx = dx; it.dy = dy;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
        it.g.setAttribute('transform', 'translate(' + dx.toFixed(1) + ',' + dy.toFixed(1) + ')');
      var cx = it.box.x + it.box.w / 2, cy = it.box.y + it.box.h / 2;
      var reach = Math.hypot(cx - it.anchor[0], cy - it.anchor[1]);
      /* A leader is meant to say "this text belongs to that point". Past about a
         sixth of the frame it stops doing that and just draws a diagonal across
         the picture — three of them crossed one determinant page. The label
         still goes where the placer put it; the line that made the exile look
         deliberate is dropped, and the count is reported so a page relying on
         long leaders is still visible as a problem rather than quietly ugly. */
      if (reach > 150) { far++; if (!it.homeKept) farNoHome++; }
      else if (reach > 34) {
        var e = edgePoint(it.box, it.anchor);
        el('path', { d: 'M ' + (e.x - dx) + ' ' + (e.y - dy) +
                        ' L ' + (it.anchor[0] - dx) + ' ' + (it.anchor[1] - dy),
                     class: 'sh-leader' }, it.g);
        leaders++;
      }
    });
    return { n: L.length, before: before, after: collisions(L), leaders: leaders, far: far, farNoHome: farNoHome,
 decrowded: decrowded, strokes: strokes.length };

    function costOf(it, B, c, others, strokes) {
      var cost = 0;
      for (var i = 0; i < others.length; i++) {
        var o = others[i];
        if (!coVisible(it, o)) continue;                 // never fight an invisible label
        var a = areaOverlap(B, o.box);
        if (a > 0) cost += W_OVER * a * roleWeight(it.role, o.role);
      }
      cost += W_STROKE * strokeHits(B, strokes, it);
      var cx = B.x + B.w / 2, cy = B.y + B.h / 2;
      /* Distance used to be linear while overlap is quadratic in area, so the
         placer would happily fly a label a quarter of the frame away to dodge a
         modest overlap — one page ended up with leader lines 250 units long
         crossing the whole diagram. Squaring the far end makes a long exile
         cost more than the overlap it was avoiding, while leaving placements
         near home almost unchanged. */
      var reach = Math.hypot(cx - it.anchor[0], cy - it.anchor[1]);
      var dn = reach / it.baseDist;
      cost += W_DIST * (dn + 0.8 * dn * dn);
      /* Beyond leader range a label has no visible tie to what it describes, so
         going there is heavily penalised — but as a price, not a prohibition.
         Forbidding it outright was tried and is worse: on a matrix-times-vector
         page every near seat overlapped something, so the answer label was
         forced on top of the vector and covered one of its digits. Sitting far
         away is bad; obscuring a number the student has to read is worse. */
      if (reach > 150) cost += W_FAR + (reach - 150) * 4;
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
    /* Board geometry is deliberately NOT collected here. It was tried: pulling
       JSXGraph's curves in (filtered to real geometry, excluding grid and axes)
       took b5_sine from 0 obstacle points to 200, and moved exactly nothing —
       16 of 20 board labels sat on a stroke before and after, unchanged even at
       3.6x the stroke weight. The reason is structural: a label attached to a
       point ON a curve has no candidate that avoids that curve, since every
       direction and ring around the anchor crosses it. The term is constant
       across candidates and cannot discriminate, so collecting the points only
       costs time. Fixing this needs the label to be allowed to sit further along
       the curve's normal, which is a different mechanism. */
    var SEL = 'path,line,polyline,polygon,circle,rect,ellipse';
    var pts = [], marks = [].slice.call(state.svg.querySelectorAll(SEL));
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.getAttribute('class') === 'sh-leader') continue;
      /* Which step does this stroke belong to? A label that lives only during
         step 2 has no reason to dodge a curve first drawn in step 5. Board
         geometry has no step group, so it counts as always present. */
      var owner = m.closest ? m.closest('[data-step]') : null;
      var sBorn = owner ? (+owner.getAttribute('data-step') || 0) : 0;
      try {
        var Lg = m.getTotalLength ? m.getTotalLength() : 0;
        if (Lg > 0) {
          var n = Math.min(16, Math.max(2, Math.round(Lg / 22)));
          for (var k = 0; k <= n; k++) {
            var p = m.getPointAtLength(Lg * k / n);
            var sp = new DOMPoint(p.x, p.y).matrixTransform(m.getScreenCTM());
            pts.push({ x: (sp.x - svgR.x) * sx + vx, y: (sp.y - svgR.y) * sy + vy, born: sBorn });
          }
          continue;
        }
      } catch (e) { }
      var r = m.getBoundingClientRect();
      pts.push({ x: (r.x + r.width / 2 - svgR.x) * sx + vx,
                 y: (r.y + r.height / 2 - svgR.y) * sy + vy, born: sBorn });
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
      /* A cited step that carries no digit used to be flagged. That was wrong,
         and it was the only thing this check ever fired on: 26 hits across 87
         pages, every one of them a step legitimately citing a setup step such as
         "หาน้ำหนักจาก $W = mg$". `uses` means "this step builds on that one",
         not only "this number came from there", so citing a formula step is
         correct and flagging it sends a reviewer chasing a non-problem.
         What IS broken is a citation that cannot be followed — a step that does
         not exist, or one at or after this one, which on click would jump the
         reader forward past material they have not seen. Corpus-wide that is
         currently zero, and this is here to keep it that way. */
      (st.uses || []).forEach(function (u) {
        if (u >= st.n)
          unverified.push({ step: st.n, reason: 'อ้างขั้น ' + u + ' ซึ่งอยู่ข้างหน้าหรือคือขั้นเดียวกัน' });
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
             tagFails: state.tagFails.slice(0, 5), replaced: state.replaced,
             badCoord: state.badCoord.slice(0, 5),
             repaired: { escapes: texFix.escapes, wrapped: texFix.wrapped,
                         tags: texFix.tags } };
  }

  /* ==== JSXGraph: defaults, name guard, lint ==============================
     Three things the fluency test said had to move out of the prompt and into
     code: the palette (JSXGraph defaults are blue/red and break one-colour-one-
     meaning), element labels (not scene-aware — the shell places all text), and
     invented element names (1 page in 10 died on `perpendicularbisector`, which
     sounds real and is not; that must not be able to blank a board again). */

  /* Shell.tag is handed whatever the page has to hand — a point, a 3D point, a
     segment it wants to name, a circle, a polygon, or a bare pair of numbers.
     The first version understood points and bare pairs only, so tagging an edge
     (the obvious way to label "ด้านฐาน 6 cm") produced x="NaN", which then killed
     label placement for the entire page. Resolve the element to a point instead. */
  function tagPoint(t) {
    if (!t) return null;
    if (t.element2D) t = t.element2D;                    // a 3D element -> its projection
    var fin = function (a) { return a && isFinite(a[0]) && isFinite(a[1]) ? a : null; };
    if (typeof t.X === 'function') {
      var q = fin([t.X(), t.Y()]);
      if (q) return state.board ? Shell.px(q[0], q[1]) : q;
    }
    if (t.point1 && t.point2 && typeof t.point1.X === 'function') {   // a line or segment
      var m = fin([(t.point1.X() + t.point2.X()) / 2, (t.point1.Y() + t.point2.Y()) / 2]);
      if (m) return state.board ? Shell.px(m[0], m[1]) : m;
    }
    if (t.center && typeof t.center.X === 'function') {               // a circle
      var c = fin([t.center.X(), t.center.Y()]);
      if (c) return state.board ? Shell.px(c[0], c[1]) : c;
    }
    if (t.vertices && t.vertices.length) {                           // a polygon
      var sx = 0, sy = 0, k = 0;
      t.vertices.forEach(function (v) {
        if (v && typeof v.X === 'function' && isFinite(v.X())) { sx += v.X(); sy += v.Y(); k++; }
      });
      if (k) { var g2 = [sx / k, sy / k]; return state.board ? Shell.px(g2[0], g2[1]) : g2; }
    }
    if (Array.isArray(t)) {
      if (t.length >= 3 && state.view) return fin(Shell.px3(t[0], t[1], t[2]));
      if (t.length >= 2) { var a = fin([t[0], t[1]]);
        return a ? (state.board ? Shell.px(a[0], a[1]) : a) : null; }
    }
    return null;
  }

  /* Any positioned composite — a table, a matrix — drawn at an origin that is
     already occupied is a progressive reveal, not a second object: the page is
     showing the same thing filling in. The earlier one retires. This was fixed
     for tables first and the same fault then appeared verbatim for matrices
     (four result matrices stacked at 540,160), so it lives in one place now. */
  function retireAt(g, x, y, until) {
    var born = state.steps.length || 1;
    var dies = until === 'step' ? born
             : (typeof until === 'number' ? until : Infinity);
    state.tables.forEach(function (t) {
      if (t.x === x && t.y === y && t.dies === Infinity && t.born < born)
        t.dies = born - 1;
    });
    state.tables.push({ g: g, x: x, y: y, born: born, dies: dies });
    return g;
  }

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
    /* Reflecting across a LINE is `reflection`; `mirrorpoint` reflects a point
       about another POINT. Both are "mirror", so the confusion is natural, and
       JSXGraph punishes it in two different ways depending on argument order:
       mirrorpoint(point, line) throws, mirrorpoint(line, point) returns NaN
       coordinates silently. Both appeared on the same transformation problem —
       once at medium effort, once at high — and both left the reflected
       triangle missing while the prose answer was correct. Detect a line among
       the parents and send it to the element that actually does the job. */
    mirrorpoint: function (b, p, a) {
      var isLine = function (e) { return e && e.elementClass === JXG.OBJECT_CLASS_LINE; };
      if (isLine(p[0]) || isLine(p[1])) {
        var line = isLine(p[0]) ? p[0] : p[1], pt = isLine(p[0]) ? p[1] : p[0];
        return b.create('reflection', [pt, line], a);
      }
      return b.create('mirrorelement', p, a);
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
  /* Depth of the current create() call, shared by the board and the view guards.
     JSXGraph builds 3D elements out of other elements — a line3d asks the view
     for point3d, which asks for point — and some of those inner calls come back
     through board.create. Rerouting those re-entered the view and blew the
     stack. The reroute is for page code only, so it fires at depth 0 and never
     inside the library's own machinery. */
  var creating = 0;

  function guardCreate(b, isView) {
    if (b.__shGuarded) return;
    b.__shGuarded = true;
    var orig = b.create.bind(b);
    b.create = function (type, parents, attrs) {
      var t = String(type).toLowerCase().replace(/[\s_-]/g, '');
      /* A 3D element asked of the board is the mistake the API invites, and it
         throws rather than degrading. Send it where it belongs. */
      if (!isView && creating === 0 && /3d$/.test(t) && t !== 'view3d' && state.view) {
        state.jsxRerouted.push(String(type));
        creating++;
        try { return state.view.create(type, parents, attrs); }
        finally { creating--; }
      }
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
      creating++;
      try { return orig(type, parents, attrs); }
      catch (e) {
        state.jsxFails.push({ type: String(type), msg: String(e.message || e).slice(0, 120) });
        return stubEl(t);
      }
      finally { creating--; }
    };
  }

  /* Contrast, not palette membership. The first version of this flagged any
     colour outside Shell.C and lit up 5 of 16 golden pages — the light blue of
     a cart, the yellow of a beam load, the grey of ground hatching. All fine,
     all readable. The actual defect n3_pulley had is narrower and worse: it
     filled its blocks with a near-black navy and the shell then drew its own
     dark label text on top, so the labels were invisible. That is a contrast
     failure, and palette membership cannot see it while flagging things that
     read perfectly. Measure what goes wrong: a label sitting on a dark fill. */
  function luminance(rgb) {
    var m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb);
    if (!m) return null;
    var c = [+m[1], +m[2], +m[3]].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function scanContrast(rootEl) {
    var bad = [];
    if (!rootEl) return bad;
    try {
      var labels = rootEl.querySelectorAll('[data-label]');
      var shapes = rootEl.querySelectorAll('svg path,svg circle,svg ellipse,svg polygon,svg rect');
      for (var i = 0; i < labels.length; i++) {
        var lb = labels[i];
        if (lb.style.opacity === '0') continue;
        var inner = lb.querySelector('foreignObject') ? lb.querySelector('foreignObject').firstElementChild
                                                      : lb.querySelector('text');
        if (!inner) continue;
        var r = inner.getBoundingClientRect();
        if (r.width < 1) continue;
        var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        /* Take the SMALLEST shape under the label, not the first one found.
           A first-match scan blamed whatever happened to be early in document
           order, and picked up every stroke-only path on the page: an SVG
           element that never sets fill explicitly computes to rgb(0,0,0), so
           lines and curves all looked like black fills and 8 of 16 golden pages
           were reported unreadable. Skip anything not actually painted, and let
           the tightest enclosing shape be the background that matters. */
        var best = null, bestArea = Infinity, bestAlpha = 1;
        for (var j = 0; j < shapes.length; j++) {
          var cs = getComputedStyle(shapes[j]);
          if (!cs.fill || cs.fill === 'none' || /rgba\(0, 0, 0, 0\)/.test(cs.fill)) continue;
          var fo = parseFloat(cs.fillOpacity);
          if (fo === 0) continue;
          var tag = shapes[j].tagName.toLowerCase();
          if (tag === 'path' && !shapes[j].getAttribute('fill')
              && !(shapes[j].style && shapes[j].style.fill)) continue;   // stroke-only path
          var q = shapes[j].getBoundingClientRect();
          if (cx < q.x || cx > q.x + q.width || cy < q.y || cy > q.y + q.height) continue;
          /* It has to be a BACKGROUND, not a speck. A 6px point marker in
             answer-green sits under the centre of the label naming that point on
             nearly every construction page, and blaming it reported two golden
             pages as unreadable when the text is almost entirely on white. Only
             consider a shape at least half the area of the label it is behind. */
          var area = q.width * q.height;
          if (area < 0.5 * (r.width * r.height)) continue;
          if (area < bestArea) { bestArea = area; best = cs.fill; bestAlpha = isFinite(fo) ? fo : 1; }
        }
        if (best) {
          /* Composite against the paper before judging. A shape filled with a
             saturated colour at 0.1 opacity reads as near-white, but
             getComputedStyle reports the raw colour — so a translucent tint
             behind a label looked as dark as an opaque block, and two golden
             pages with a lightly shaded circle came back "unreadable". */
          var L = luminance(best);
          if (L !== null) L = L * bestAlpha + 1 * (1 - bestAlpha);
          if (L !== null && L <= 0.3) {
            var txt = (inner.textContent || '').trim().slice(0, 14);
            bad.push(txt + ' on ' + best);
          }
        }
      }
    } catch (e) { }
    return bad;
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

  var WALL = '#E4E9EE';
  function styleView(v) {
    var INK = '#6B7688', ax = v.defaultAxes || {};
    Object.keys(ax).forEach(function (k) {
      var e = ax[k];
      if (!e || typeof e.setAttribute !== 'function') return;
      try {
        if (/^[xyz]Axis$/.test(k)) {
          e.setAttribute({ strokeColor: INK, strokeWidth: 1.2, strokeOpacity: 0.9,
                           highlight: false });
        } else if (/Plane/.test(k)) {
          /* the front walls would sit between the reader and the figure */
          e.setAttribute(/Front/.test(k)
            ? { visible: false }
            : { fillColor: WALL, fillOpacity: 0.30, strokeColor: WALL,
                strokeOpacity: 0.85, highlight: false });
        }
      } catch (err) { }
    });
    /* tick labels are children of the axes; thin them out and calm them down */
    try {
      var objs = v.board.objects;
      for (var id in objs) {
        var o = objs[id];
        if (o && o.elType === 'ticks')
          o.setAttribute({ strokeColor: INK, strokeOpacity: 0.45, majorHeight: 6,
                           label: { fontSize: 11, strokeColor: INK, display: 'internal' } });
      }
    } catch (err2) { }
  }

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
    if (state.view) { out.view3d = true; return out; }   // the view frames itself
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
      /* A board point whose construction failed reports NaN coordinates, and
         projecting it produced x="NaN" on the label — twelve console errors on
         one page, with four labels silently not drawn. The label keeps the
         position it already had rather than inheriting the failure. */
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) {
        state.badCoord.push(String(L.node.textContent || '').slice(0, 30));
        return;
      }
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

  /* A line that draws itself reads as motion; the same line fading in reads as a
     slide change. Every stroked path in a step group gets its own length as a
     dash pattern, so revealing the step animates the offset to zero. Anything
     already using a dash pattern is left alone — that dashing is meaning
     (construction lines, hidden edges) and must not be overwritten. */
  /* The SVG node a board element actually paints into. A 3D element has no
     rendNode of its own — it paints through a separate 2D projection companion
     — so every caller that reaches for .rendNode directly silently did nothing
     on a view3d page. Both the arming and the revealing side must resolve the
     same way: arming without revealing parks the stroke at dashoffset = its
     own length, which does not merely fail to animate, it erases it. */
  function renderNodeOf(e) {
    if (!e) return null;
    if (!e.rendNode && e.element2D) e = e.element2D;
    return e.rendNode || null;
  }

  function armStrokeDraw() {
    if (reduced() || !state.root) return 0;
    var n = 0, order = 0;
    var arm = function (m) {
      if (!m || !m.getTotalLength) return;
      if (m.closest('[data-label]') || m.getAttribute('class') === 'sh-leader') return;
      var cs = getComputedStyle(m);
      if (!cs.stroke || cs.stroke === 'none') return;
      if (cs.strokeDasharray && cs.strokeDasharray !== 'none') return;
      var len = 0;
      try { len = m.getTotalLength(); } catch (e) { return; }
      if (!isFinite(len) || len < 8 || len > 6000) return;
      m.style.strokeDasharray = len + ' ' + len;
      m.style.setProperty('--sh-len', len);
      /* Stagger. Four lines drawing at once in half a second reads as a flicker;
         the same four drawn one after another reads as a construction being
         made, which is the entire point. The delay is per element within its
         step, capped so a busy step still finishes inside its dwell. */
      m.style.transitionDelay = Math.min(900, order * 110) + 'ms';
      /* Draw at a constant SPEED, not a constant duration. Every stroke taking
         0.85s meant a 400px construction line and a 20px tick mark animated
         identically — the long line too quick to follow, the tick a pointless
         wait. A step that reveals a single stroke has no stagger to help it, so
         that stroke must carry the motion alone, which it only does if its pace
         matches its length. */
      m.style.transitionDuration =
        Math.round(Math.max(380, Math.min(1500, len / 0.42))) + 'ms';
      order++;
      m.classList.add('sh-draw');
      n++;
    };
    /* circle, rect, ellipse and polygon all implement getTotalLength() — the
       original selector just did not ask for them, so across one 68-page run
       108 circles, 53 rectangles and 17 polygons appeared instantly while the
       lines beside them drew in. That is what made pages read as half animated.
       Fill-only shapes are still skipped by the stroke test above, and anything
       already dashed keeps its dashing. */
    var DRAWABLE = 'path, line, polyline, polygon, circle, ellipse, rect';
    state.steps.forEach(function (st) {
      order = 0;                                   // each step paces itself
      var marks = st.g.querySelectorAll(DRAWABLE);
      for (var i = 0; i < marks.length; i++) arm(marks[i]);
    });
    /* Board geometry lives in JSXGraph's own SVG, not in the step group, so the
       pages with the best curves to draw were getting none of this. Their nodes
       are reachable through the elements tied to a step with Shell.on. */
    state.jxg.forEach(function (J) {
      /* A 3D element draws through a separate 2D projection companion; the
         wrapper Shell.on was given has no rendNode of its own, so this used to
         return early and every view3d page animated nothing at all, however
         carefully its author tied things to steps. Resolve to the projection,
         the same way tagPoint already does. */
      var node = renderNodeOf(J.el);
      if (!node) return;
      if (/^(path|line|polyline|polygon|circle|ellipse|rect)$/i.test(node.tagName)) arm(node);
      else if (node.querySelectorAll) {
        var kids = node.querySelectorAll(DRAWABLE);
        for (var k = 0; k < kids.length; k++) arm(kids[k]);
      }
    });

    /* Board geometry that was never tied to a step has no reveal moment, so it
       used to appear fully formed before the first step — five of the seven
       pages with no animation at all in that run were board pages for exactly
       this reason. Give the opening figure a draw-in of its own, one frame
       later so the transition has a starting state to move from. */
    if (state.board) {
      var tied = {};
      /* Tie BOTH ids for a 3D element: the wrapper the author passed to
         Shell.on, and the projection that actually renders. Marking only the
         wrapper left the projection looking untied, so the opening sweep below
         switched it on at load — which is precisely why a 3D page showed its
         whole figure before step 1 even when every element was tied. */
      state.jxg.forEach(function (J) {
        var e = J.el;
        if (!e) return;
        if (e.id) tied[e.id] = 1;
        if (e.element2D && e.element2D.id) tied[e.element2D.id] = 1;
      });
      var opening = [];
      for (var oid in state.board.objects) {
        var ob = state.board.objects[oid];
        if (!ob || !ob.elType || tied[oid] || state.jsxBase[oid]) continue;
        if (ob.elType === 'ticks' || ob.elType === 'grid' || ob.elType === 'axis') continue;
        var on = ob.rendNode;
        if (!on || !on.classList) continue;
        if (/^(path|line|polyline|polygon|circle|ellipse|rect)$/i.test(on.tagName)) {
          arm(on); opening.push(on);
        }
      }
      if (opening.length) requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          opening.forEach(function (el2) { el2.classList.add('sh-on'); });
        });
      });
    }

    /* The same courtesy for the raw-SVG path, which never had it. Only step
       groups were ever scanned here, so anything appended straight to the
       Shell.canvas() <g> — the whole figure, on the pages that build one up
       front — was not merely revealed early, it was invisible to this system
       forever: it never received sh-draw at all. One physics page armed 4
       strokes out of a full diagram. Board pages got an opening draw-in and
       canvas pages silently did not; that asymmetry was the bug.
       Guarded to the canvas path so the board sweep above stays the only one
       that touches board pages. */
    if (!state.board && state.root) {
      order = 0;
      var cOpen = [];
      var croots = state.root.querySelectorAll(DRAWABLE);
      for (var ci = 0; ci < croots.length; ci++) {
        var cel = croots[ci], inStep = false;
        for (var ca = cel.parentNode; ca && ca !== state.root; ca = ca.parentNode) {
          if (ca.getAttribute && ca.getAttribute('data-step') != null) { inStep = true; break; }
        }
        if (inStep) continue;                    // its step already paces it
        if (cel.classList.contains('sh-draw')) continue;
        arm(cel);
        if (cel.classList.contains('sh-draw')) cOpen.push(cel);
      }
      /* Mandatory: .sh-draw parks the stroke at dashoffset = its own length, so
         arming without this reveal would blank the figure outright. */
      if (cOpen.length) requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          cOpen.forEach(function (el2) { el2.classList.add('sh-on'); });
        });
      });
    }
    return n;
  }

  /* ---- motion engine ------------------------------------------------------
     One requestAnimationFrame loop drives everything Shell.motion() moves,
     on both drawing paths, so there is exactly one place that has to know
     about reduced-motion, showAll()'s "instant" thumbnails, and replay's
     reset-then-play-again. Neither SMIL <animateMotion> nor CSS offset-path
     was used here: see the write-up for what was actually tried and why a
     small rAF loop won out — mainly that both of those have no clean way to
     answer "what is the exact x,y at an arbitrary already-elapsed time",
     which is what a velocity arrow that must stay glued to a moving
     projectile needs every frame, and what jumping the WHOLE page straight
     to step n (a step click, not just next/back) needs too. */
  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function buildMotionPath(path, toPx) {
    var fn;
    if (typeof path === 'function') fn = path;
    else if (Array.isArray(path) && path.length >= 2) fn = polyPath(path);
    else fn = function () { return [0, 0]; };
    if (!toPx) return fn;
    return function (t) { var q = fn(t); return toPx(q[0], q[1]); };
  }
  function polyPath(pts) {
    if (pts.length === 2) {
      var a = pts[0], b = pts[1];
      return function (t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
    }
    if (pts.length === 3) {
      var p0 = pts[0], p1 = pts[1], p2 = pts[2];
      return function (t) {
        var u = 1 - t;
        return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
      };
    }
    var segs = [], total = 0, i;
    for (i = 0; i < pts.length - 1; i++) {
      var d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      segs.push(d); total += d;
    }
    return function (t) {
      var target = t * total, acc = 0;
      for (var i2 = 0; i2 < segs.length; i2++) {
        if (acc + segs[i2] >= target || i2 === segs.length - 1) {
          var lt = segs[i2] > 0 ? (target - acc) / segs[i2] : 0;
          lt = Math.max(0, Math.min(1, lt));
          var a2 = pts[i2], b2 = pts[i2 + 1];
          return [a2[0] + (b2[0] - a2[0]) * lt, a2[1] + (b2[1] - a2[1]) * lt];
        }
        acc += segs[i2];
      }
      return pts[pts.length - 1];
    };
  }
  /* orientation from a tiny secant around t — cheap, and exact enough that a
     rotated icon (a car, a photon) never visibly wobbles */
  function tangentDeg(fn, t) {
    var e = 0.001, t0 = Math.max(0, t - e), t1 = Math.min(1, t + e);
    var a = fn(t0), b = fn(t1);
    if (t1 === t0) return 0;
    return Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  }
  function setMoverFrame(M, pt, t) {
    var tr = 'translate(' + pt[0].toFixed(2) + ',' + pt[1].toFixed(2) + ')';
    if (M.rotate) tr += ' rotate(' + tangentDeg(M.path, t).toFixed(2) + ')';
    M.el.setAttribute('transform', tr);
  }
  function driveMover(M, pt, t) {
    if (M.kind === 'board') {
      try { M.el.setPosition(JXG.COORDS_BY_USER, pt); if (state.board) state.board.update(); } catch (e) { }
    } else setMoverFrame(M, pt, t);
    if (M.onFrame) try { M.onFrame(pt, t); } catch (e) { }
  }
  function resetMover(M) {
    if (M.raf) { cancelAnimationFrame(M.raf); M.raf = null; }
    if (M.phase === 'idle') return;
    M.phase = 'idle'; M.start = null; M.dir = 1;
    driveMover(M, M.path(0), 0);
  }
  function playMover(M) {
    /* two legs of the same actor (approach, then separate) can be handed to
       the shell as two Shell.motion calls on the same element. If the first
       leg's rAF is still mid-flight when the second leg's step is reached —
       a fast click, or a short per-step replay interval — both would fight
       over the same transform every frame. Finish the earlier leg at ITS
       own end instead of letting them race; the two legs are expected to
       share that point, so this reads as a clean handoff, not a jump. */
    state.movers.forEach(function (other) {
      if (other !== M && other.el === M.el && other.phase === 'playing') {
        if (other.raf) { cancelAnimationFrame(other.raf); other.raf = null; }
        other.phase = 'done';
        driveMover(other, other.path(1), 1);
      }
    });
    if (reduced() || state.instantMotion) {
      if (M.raf) { cancelAnimationFrame(M.raf); M.raf = null; }
      M.phase = 'done';
      driveMover(M, M.path(1), 1);
      return;
    }
    M.phase = 'playing'; M.start = null;
    var tick = function (ts) {
      if (!M.start) M.start = ts;
      var raw = Math.min(1, (ts - M.start) / M.dur);
      if (M.loop) {
        var cyc = ((ts - M.start) / M.dur) % 2;
        raw = cyc <= 1 ? cyc : 2 - cyc;
      }
      var t = M.ease(raw);
      driveMover(M, M.path(t), t);
      if (M.loop || raw < 1) M.raf = requestAnimationFrame(tick);
      else { M.phase = 'done'; M.raf = null; driveMover(M, M.path(1), 1); }
    };
    M.raf = requestAnimationFrame(tick);
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
    ['rgb(107, 118, 136)', 'rgb(217, 222, 230)', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)',
     /* JSXGraph paints the 3D wall mesh in its own two greys from generated
        <path> elements that are not reachable through view.defaultAxes — three
        attempts to restyle them changed nothing. They are chrome, not meaning,
        so they are allow-listed rather than left to trip the palette check on
        every 3D page. styleView() below still calms the axes. */
     'rgb(204, 204, 204)', 'rgb(231, 231, 231)',
     hexToRgb(WALL)].forEach(function (r) { if (r) ok[r] = 1; });
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
    /* An element can be real, accept its parents, and still produce nothing
       usable: mirrorpoint(line, point) returns NaN coordinates without throwing,
       so the guard never sees it and the geometry silently vanishes. Sweep every
       authored element that carries a position and report the ones that are not
       finite numbers. This is the only way the silent half of that failure is
       visible at all. */
    var nanEls = [];
    for (var nid in b.objects) {
      var no = b.objects[nid];
      if (!no || !no.elType || state.jsxBase[nid]) continue;
      /* Only POINTS have a single position. A line, segment or bisector also
         exposes X()/Y(), and they legitimately return NaN because the question
         has no answer — asking anyway flagged six elements on nearly every
         construction page. Circles are checked through their centre. */
      var nx, ny;
      if (no.elementClass === JXG.OBJECT_CLASS_POINT) {
        try { nx = no.X(); ny = no.Y(); } catch (e) { continue; }
      } else if (no.elementClass === JXG.OBJECT_CLASS_CIRCLE && no.center) {
        try { nx = no.center.X(); ny = no.center.Y(); } catch (e) { continue; }
      } else continue;
      if (!isFinite(nx) || !isFinite(ny)) nanEls.push(no.elType);
    }

    return { elements: els, constructed: constructed, freePoints: freePoints,
             nanEls: nanEls.slice(0, 6),
             ownLabels: ownLabels, tied: state.jxg.length,
             unknown: state.jsxUnknown.slice(0, 6), failed: state.jsxFails.slice(0, 6),
             aliased: state.jsxAliased.slice(0, 6), rerouted: state.jsxRerouted.slice(0, 6),
             view3d: !!state.view, offPalette: off.slice(0, 6), kinds: kinds };
  }

  root.Shell = Shell;
})(window);
