/**
 * O.Nursing — Timed Quiz v2: name + course number, timed/untimed,
 * student-chosen duration, Sheet progress reporting (injection snippet)
 * ============================================================================
 * WHAT IT IS
 *   A self-contained add-on for a module quiz page. It adds ONLY:
 *   (1) REQUIRED Name field + REQUIRED «رقمك في الكورس» field on the home
 *       screen (no Start without both),
 *   (2) a mode toggle: timed (student picks 60 / 120 / 180 min or a custom
 *       15–600 min) or untimed (no countdown, no time limit),
 *   (3) a countdown for the CHOSEN duration in timed mode (gold bar,
 *       urgent red under 5 min); at zero it auto-submits and locks,
 *   (4) progress reporting to the Apps Script web app: every 30 s, on
 *       every answer, and on pagehide (sendBeacon) — so the Sheet shows
 *       where the student stopped even if he never presses Finish,
 *   (5) submit of name + course number + mode + duration + score +
 *       answers to the web app, and the close-and-reopen rule: the start
 *       lives on the SERVER and in localStorage, so closing the page and
 *       coming back keeps counting from the original start.
 *
 *   It does NOT touch the existing quiz scoring, Hint/explanation,
 *   flashcards, or the Special O.Nursing Questions sections.
 *
 * HOW TO INJECT (during the page redesign)
 *   Add this ONE line immediately before </body>, AFTER the page's own
 *   <script> block (this snippet must run after the page script, because
 *   it wraps the page's startQuiz/finishAnswer globals):
 *       <script src="timer-snippet-v2.js"></script>
 *   Then set WEB_APP_URL below to that module's deployed web-app /exec
 *   URL. (If the URL is still the placeholder, the local timer still
 *   works, but nothing is sent to the Sheet — the results screen says so.)
 *
 * PAGE HOOKS THIS SNIPPET DEPENDS ON (verified against the M1 v4 page;
 * if a module page renames them, update the names in the CONFIG section):
 *   Element IDs: home, levels, btn-start, btn-resume, home-stats,
 *   quiz, prog-fill, q-count, q-badge, q-score, q-stem, q-body,
 *   btn-hint, q-hint, q-explain, q-model, btn-next, btn-finish,
 *   results, res-pct, res-line, res-table, btn-retry, btn-home,
 *   flashcards, special.
 *   Page globals (same global scope, classic scripts): QUESTIONS
 *   [{id, level, type, q, options, correct, hint, explain, model}],
 *   selectedLvl, queue, idx, score, answered, results,
 *   startQuiz(resume), finishAnswer(ok), renderQ(), cur(), showResults().
 *   Notes: btn-start/btn-resume/btn-retry call startQuiz() BY NAME, so
 *   wrapping the startQuiz binding intercepts them. btn-finish was given
 *   the showResults function OBJECT at registration, so it is NOT
 *   intercepted by wrapping — this snippet instead adds its own later
 *   click listener on #btn-finish (listeners run in registration order,
 *   so the page's showResults runs first, then the submit).
 *
 * SERVER CONTRACT (Code-v2.gs in the timer-system folder)
 *   POST {action:'start', name, courseNumber, mode, durationMin}
 *     -> {ok, name, courseNumber, mode, durationMin, startedAt}
 *   POST {action:'progress', name, courseNumber, startedAt, answered,
 *     stoppedAt, score, total, answers, mode, durationMin} -> {ok, row}
 *   POST {action:'submit', name, courseNumber, startedAt, answers,
 *     score, total, timeTakenSec, completed, stoppedAt, answered,
 *     mode, durationMin} -> {ok, name, status, elapsedSec, row}
 *   First start wins server-side (keyed by lowercase name + course
 *   number); progress upserts the same row; submit is validated
 *   against the SERVER-recorded start; late submits are stored
 *   flagged "late". POSTs use Content-Type: text/plain (lets the
 *   static GitHub page POST cross-origin to the Apps Script web app).
 */
(function () {
  'use strict';

  /* ================= CONFIG ================= */
  // ---- PER-MODULE PLACEHOLDERS (set these before deploying) ----
  var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwvATmAaUdATxDcw7gCf-Em1DLio3ux6Wl_qpls61XxtwrUyVeRrDBNSqPGoJOaVf4y/exec';
  var TKEY = 'onursing_m5_timed_v2'; // localStorage session key — change per module (m1..m5)
  var TOTAL = 36;                    // full attempt = all scored questions — change per module
  // ---------------------------------------------------------------
  var MIN_DURATION_MIN = 15;
  var MAX_DURATION_MIN = 600;
  var PROGRESS_EVERY_MS = 30 * 1000; // progress POST every 30 s

  /* ================= helpers ================= */
  function $(id) { return document.getElementById(id); }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(TKEY)) || null; } catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(TKEY, JSON.stringify(s)); } catch (e) {}
  }
  function endpointReady() {
    return WEB_APP_URL && WEB_APP_URL.indexOf('http') === 0 && WEB_APP_URL.indexOf('PASTE_THE_EXEC_URL') === -1;
  }
  function postJSON(payload) {
    if (!endpointReady()) return Promise.reject(new Error('endpoint not configured'));
    return fetch(WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }
  /** Fire-and-forget progress report that survives page close. */
  function beaconJSON(payload) {
    if (!endpointReady()) return false;
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        return navigator.sendBeacon(WEB_APP_URL, JSON.stringify(payload));
      }
    } catch (e) {}
    return false;
  }
  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (ss < 10 ? '0' + ss : '' + ss);
  }
  function esc(s) {
    var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML;
  }

  /* ================= session state ================= */
  var timerId = null;
  var progressTimerId = null;
  var submitInFlight = false;

  function readName() {
    var inp = $('tq-name');
    return inp ? inp.value.replace(/\s+/g, ' ').trim() : '';
  }
  function readCourseNumber() {
    var inp = $('tq-num');
    return inp ? inp.value.replace(/\s+/g, '').trim() : '';
  }
  function readMode() {
    var u = $('tq-mode-untimed');
    return (u && u.classList.contains('on')) ? 'untimed' : 'timed';
  }
  /** Chosen duration in minutes, or null when the timed choice is invalid. */
  function readDurationMin() {
    if (readMode() === 'untimed') return null;
    var custom = $('tq-dur-custom');
    if (custom && String(custom.value).trim() !== '') {
      var n = Math.floor(Number(custom.value));
      if (!n || n < MIN_DURATION_MIN || n > MAX_DURATION_MIN) return null;
      return n;
    }
    var sel = document.querySelector('#tq-dur .preset.on');
    if (sel) return Math.floor(Number(sel.dataset.min));
    return 60; // default preset
  }
  function durationMs(s) {
    return (s.mode === 'timed' && s.durationMin) ? s.durationMin * 60 * 1000 : null;
  }

  /** Compact per-question result string, e.g. "M4:C M7:W M9:U ..." */
  function compactAnswers(s) {
    var qs = (typeof queue !== 'undefined' && queue && queue.length)
      ? queue
      : QUESTIONS.filter(function (q) { return q.type !== 'written'; });
    return qs.map(function (q) {
      var v = s.answers[q.id];
      return q.id + ':' + (v === true ? 'C' : v === false ? 'W' : 'U');
    }).join(' ');
  }
  /** Id of the question the student is currently on (where he stopped). */
  function currentQuestionId(s) {
    try {
      var q = (typeof cur === 'function') ? cur() : null;
      if (q && q.id) return q.id;
    } catch (e) {}
    var ids = Object.keys(s.answers || {});
    if (ids.length) return ids[ids.length - 1];
    return '—';
  }
  function lastAnsweredId(s) {
    var parts = compactAnswers(s).split(' ').filter(function (t) { return /:([CW])$/.test(t); });
    return parts.length ? parts[parts.length - 1].split(':')[0] : '—';
  }

  /* ================= UI injection ================= */
  function injectStyles() {
    if ($('tq-style')) return;
    var st = document.createElement('style');
    st.id = 'tq-style';
    st.textContent =
      '#tq-name,#tq-num{width:100%;border:1.5px solid #e5d5c8;border-radius:12px;padding:12px 14px;' +
      'font-family:inherit;font-size:16px;margin-top:8px;direction:rtl;text-align:right;background:#fff;color:inherit}' +
      '#tq-name:focus,#tq-num:focus{outline:2px solid var(--gold,#C9A227)}' +
      '.tq-label{display:block;margin-top:14px;font-weight:700;font-size:15px}' +
      '#tq-mode{display:flex;gap:10px;margin-top:8px}' +
      '#tq-mode button{flex:1;padding:11px 8px;border-radius:12px;border:1.5px solid #e5d5c8;' +
      'background:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;color:inherit}' +
      '#tq-mode button.on{border-color:var(--gold,#C9A227);background:var(--gold-l,#F5ECD7)}' +
      '#tq-dur{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}' +
      '#tq-dur .preset{flex:1;min-width:70px;padding:11px 8px;border-radius:12px;border:1.5px solid #e5d5c8;' +
      'background:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;color:inherit}' +
      '#tq-dur .preset.on{border-color:var(--gold,#C9A227);background:var(--gold-l,#F5ECD7)}' +
      '#tq-dur-custom{flex:1;min-width:110px;border:1.5px solid #e5d5c8;border-radius:12px;padding:11px 12px;' +
      'font-family:inherit;font-size:15px;direction:rtl;text-align:right;background:#fff;color:inherit}' +
      '#tq-bar{display:none;background:var(--gold-l,#F5ECD7);border:1.5px solid var(--gold,#C9A227);' +
      'border-radius:12px;padding:10px 14px;margin-top:14px;font-weight:800;font-size:16px;text-align:center}' +
      '#tq-bar.show{display:block}' +
      '#tq-bar.urgent{background:#fdecea;border-color:#b3261e;color:#b3261e}' +
      '#tq-bar.free{background:#eef4f8;border-color:#5B8DB8;color:#1B3A5C}' +
      '#tq-note{font-size:13.5px;color:#8a7a72;text-align:center;margin-top:10px;line-height:1.8}' +
      '#tq-note b{color:var(--burg,#7C2D3E)}' +
      '#tq-timeup h1{color:#b3261e}' +
      '#tq-sent{margin-top:12px;font-size:14.5px;font-weight:700;line-height:1.9}' +
      '#tq-sent.ok{color:#2e7d4f}#tq-sent.no{color:#b3261e}';
    document.head.appendChild(st);
  }

  function injectStartFields() {
    if ($('tq-name')) return;
    var startBtn = $('btn-start');
    if (!startBtn) return;
    var parent = startBtn.parentNode;

    var label1 = document.createElement('label');
    label1.setAttribute('for', 'tq-name');
    label1.className = 'tq-label';
    label1.textContent = 'الاسم (مطلوب قبل بدء الاختبار)';
    var inp1 = document.createElement('input');
    inp1.id = 'tq-name';
    inp1.type = 'text';
    inp1.placeholder = 'اكتب اسمك هنا…';
    inp1.autocomplete = 'off';
    inp1.maxLength = 100;

    var label2 = document.createElement('label');
    label2.setAttribute('for', 'tq-num');
    label2.className = 'tq-label';
    label2.textContent = 'رقمك في الكورس (مطلوب قبل بدء الاختبار)';
    var inp2 = document.createElement('input');
    inp2.id = 'tq-num';
    inp2.type = 'text';
    inp2.placeholder = 'اكتب رقمك في الكورس هنا…';
    inp2.autocomplete = 'off';
    inp2.maxLength = 50;

    var label3 = document.createElement('div');
    label3.className = 'tq-label';
    label3.textContent = 'نوع الاختبار';
    var modeRow = document.createElement('div');
    modeRow.id = 'tq-mode';
    var btnTimed = document.createElement('button');
    btnTimed.id = 'tq-mode-timed';
    btnTimed.type = 'button';
    btnTimed.className = 'on';
    btnTimed.textContent = '⏱ موقوت (بمدة تختارها)';
    var btnUntimed = document.createElement('button');
    btnUntimed.id = 'tq-mode-untimed';
    btnUntimed.type = 'button';
    btnUntimed.textContent = '🕐 غير موقوت (بدون حد زمني)';
    modeRow.appendChild(btnTimed);
    modeRow.appendChild(btnUntimed);

    var durWrap = document.createElement('div');
    durWrap.id = 'tq-dur-wrap';
    var label4 = document.createElement('div');
    label4.className = 'tq-label';
    label4.textContent = 'المدة (بالدقائق)';
    var durRow = document.createElement('div');
    durRow.id = 'tq-dur';
    [60, 120, 180].forEach(function (m, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset' + (i === 0 ? ' on' : '');
      b.dataset.min = String(m);
      b.textContent = (m / 60) + (m === 60 ? ' ساعة' : ' ساعات');
      b.addEventListener('click', function () {
        document.querySelectorAll('#tq-dur .preset').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        var c = $('tq-dur-custom');
        if (c) c.value = '';
      });
      durRow.appendChild(b);
    });
    var custom = document.createElement('input');
    custom.id = 'tq-dur-custom';
    custom.type = 'number';
    custom.min = String(MIN_DURATION_MIN);
    custom.max = String(MAX_DURATION_MIN);
    custom.placeholder = 'مدة أخرى (15–600 دقيقة)';
    custom.addEventListener('input', function () {
      if (String(custom.value).trim() !== '') {
        document.querySelectorAll('#tq-dur .preset').forEach(function (x) { x.classList.remove('on'); });
      }
    });
    durRow.appendChild(custom);
    durWrap.appendChild(label4);
    durWrap.appendChild(durRow);

    var note = document.createElement('div');
    note.id = 'tq-note';
    note.innerHTML = 'اختبار موقوت أو غير موقوت — انت اللي تختار. ' +
      'لو قفلت الصفحة ودخلت تاني، المحاولة بتكمل من مطرح ما وقفت، وبيتبعت للشيت انت وصلت لفين حتى لو مكملتش.';

    parent.insertBefore(label1, startBtn);
    parent.insertBefore(inp1, startBtn);
    parent.insertBefore(label2, startBtn);
    parent.insertBefore(inp2, startBtn);
    parent.insertBefore(label3, startBtn);
    parent.insertBefore(modeRow, startBtn);
    parent.insertBefore(durWrap, startBtn);
    parent.insertBefore(note, startBtn);

    btnTimed.addEventListener('click', function () {
      btnTimed.classList.add('on');
      btnUntimed.classList.remove('on');
      durWrap.style.display = '';
    });
    btnUntimed.addEventListener('click', function () {
      btnUntimed.classList.add('on');
      btnTimed.classList.remove('on');
      durWrap.style.display = 'none';
    });
  }

  function injectTimerBar() {
    if ($('tq-bar')) return;
    var quiz = $('quiz');
    if (!quiz) return;
    var bar = document.createElement('div');
    bar.id = 'tq-bar';
    quiz.insertBefore(bar, quiz.firstChild);
  }

  function injectTimeUpCard() {
    if ($('tq-timeup')) return;
    var wrap = document.querySelector('.wrap');
    if (!wrap) return;
    var card = document.createElement('div');
    card.id = 'tq-timeup';
    card.className = 'card hidden';
    card.style.textAlign = 'center';
    card.innerHTML =
      '<h1>انتهى الوقت ⏰</h1>' +
      '<p style="margin-top:12px;font-size:15px;line-height:2" id="tq-timeup-line"></p>' +
      '<p style="margin-top:8px;font-size:14px;line-height:1.9" id="tq-timeup-sent"></p>' +
      '<button class="btn ghost hidden" id="tq-retry-send">إعادة إرسال الإجابات</button>';
    wrap.appendChild(card);
    $('tq-retry-send').addEventListener('click', function () { submitSession('timeout'); });
  }

  function setHomeNote(html) {
    var n = $('tq-note');
    if (n) n.innerHTML = html;
  }

  function lockStartFields(s) {
    ['tq-name', 'tq-num', 'tq-dur-custom'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = true;
    });
    document.querySelectorAll('#tq-mode button, #tq-dur .preset').forEach(function (b) {
      b.disabled = true;
    });
  }

  function noteAlreadySubmitted(s) {
    var msg = 'أرسلتَ محاولتك بالفعل (' + esc(s.name) + ' — ' + s.score + ' / ' + TOTAL +
      '). بطاقات المراجعة وأسئلة Special O.Nursing تحت لسه متاحة للمذاكرة.';
    setHomeNote(msg);
    if ($('results') && !$('results').classList.contains('hidden')) {
      var div = $('tq-sent');
      if (!div) {
        div = document.createElement('div');
        div.id = 'tq-sent';
        var res = $('res-line');
        if (res) res.parentNode.insertBefore(div, res.nextSibling);
      }
      if (div) {
        div.className = '';
        div.textContent = msg.replace(/<[^>]*>/g, '');
      }
    }
  }

  /* ================= countdown (timed mode only) ================= */
  function updateBar(s) {
    var bar = $('tq-bar');
    if (!bar) return;
    if (s.mode === 'untimed') {
      bar.classList.add('show');
      bar.classList.remove('urgent');
      bar.classList.add('free');
      bar.textContent = '⏱ ' + s.name + ' — وضع غير موقوت (بدون حد زمني)';
      return;
    }
    var remaining = durationMs(s) - (Date.now() - s.startedAt);
    bar.classList.add('show');
    bar.classList.remove('free');
    bar.classList.toggle('urgent', remaining <= 5 * 60 * 1000);
    bar.textContent = '⏱ ' + s.name + ' — الوقت المتبقي: ' + fmt(remaining); // textContent: no escaping needed
  }

  function startCountdown(s) {
    stopCountdown();
    if (s.mode !== 'timed') { updateBar(s); return; } // untimed: no countdown at all
    updateBar(s);
    timerId = setInterval(function () {
      var sess = loadSession();
      if (!sess || sess.submitted) { stopCountdown(); return; }
      var remaining = durationMs(sess) - (Date.now() - sess.startedAt);
      if (remaining <= 0) { expireSession(); return; }
      updateBar(sess);
      var n = $('tq-note');
      if (n && sess && !$('home').classList.contains('hidden')) {
        n.innerHTML = 'محاولتك الموقوتة شغالة — المتبقي: <b>' + fmt(remaining) + '</b>. اضغط «ابدأ الأسئلة» للمتابعة.';
      }
    }, 1000);
  }

  function stopCountdown() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  /* ================= progress reporting ================= */
  function progressPayload(s, viaBeacon) {
    return {
      action: 'progress',
      name: s.name,
      courseNumber: s.courseNumber,
      mode: s.mode,
      durationMin: s.durationMin,
      startedAt: s.startedAt,
      answered: s.answered,
      stoppedAt: currentQuestionId(s),
      score: s.score,
      total: TOTAL,
      answers: compactAnswers(s)
    };
  }

  /** Regular progress POST (fetch). Silent on failure — next tick retries. */
  function sendProgress() {
    var s = loadSession();
    if (!s || s.submitted) return;
    if (!endpointReady()) return;
    postJSON(progressPayload(s)).catch(function () { /* retry on next tick */ });
  }

  /** Beacon progress report (pagehide / tab close). */
  function sendProgressBeacon() {
    var s = loadSession();
    if (!s || s.submitted) return;
    beaconJSON(progressPayload(s, true));
  }

  function startProgressTimer() {
    stopProgressTimer();
    progressTimerId = setInterval(sendProgress, PROGRESS_EVERY_MS);
  }
  function stopProgressTimer() {
    if (progressTimerId) { clearInterval(progressTimerId); progressTimerId = null; }
  }

  /* ================= submit ================= */
  function submitSession(reason) {
    var s = loadSession();
    if (!s || s.submitted || submitInFlight) return;
    submitInFlight = true;
    stopProgressTimer();
    var completed = s.answered >= TOTAL;
    var payload = {
      action: 'submit',
      name: s.name,
      courseNumber: s.courseNumber,
      mode: s.mode,
      durationMin: s.durationMin,
      startedAt: s.startedAt,
      answers: compactAnswers(s),
      score: s.score,
      total: TOTAL,
      answered: s.answered,
      stoppedAt: lastAnsweredId(s),
      completed: completed,
      timeTakenSec: Math.round((Date.now() - s.startedAt) / 1000)
    };
    function markSent(ok, msg) {
      submitInFlight = false;
      if (ok) {
        s.submitted = true;
        saveSession(s);
        stopCountdown();
      }
      showSentNote(ok, msg, s);
    }
    function statusWord(res) {
      if (!res) return '';
      if (res.status === 'late') return 'متأخر (بعد الوقت)';
      if (res.status === 'completed') return 'مكتمل (غير موقوت)';
      return 'في الوقت';
    }
    if (!endpointReady()) {
      markSent(false, 'الرابط بتاع السيرفر لسه متظبطش — إجاباتك محفوظة على جهازك بس، وموصلتش للشيت.');
      return;
    }
    postJSON(payload).then(function (res) {
      if (res && res.ok) {
        markSent(true, '✓ تم إرسال إجاباتك — الاسم: ' + s.name + ' • الدرجة: ' + s.score + ' / ' + TOTAL +
          ' • الحالة: ' + statusWord(res));
      } else {
        markSent(false, 'تعذّر الإرسال (' + ((res && res.error) || 'خطأ غير معروف') + ') — إجاباتك محفوظة على جهازك، جرّب تاني.');
      }
    }).catch(function () {
      // one retry after 3s, then report the failure (answers stay in localStorage)
      setTimeout(function () {
        postJSON(payload).then(function (res) {
          if (res && res.ok) {
            markSent(true, '✓ تم إرسال إجاباتك — الاسم: ' + s.name + ' • الدرجة: ' + s.score + ' / ' + TOTAL +
              ' • الحالة: ' + statusWord(res));
          } else {
            markSent(false, 'تعذّر الإرسال — إجاباتك محفوظة على جهازك، جرّب تاني من زر «إعادة إرسال الإجابات».');
          }
        }).catch(function () {
          markSent(false, 'تعذّر الإرسال (مشكلة اتصال) — إجاباتك محفوظة على جهازك، جرّب تاني من زر «إعادة إرسال الإجابات».');
        });
      }, 3000);
    });
  }

  function showSentNote(ok, msg, s) {
    var line = $('tq-timeup-sent');
    if (line && !$('tq-timeup').classList.contains('hidden')) {
      line.textContent = msg.replace(/<[^>]*>/g, '');
      $('tq-retry-send').classList.toggle('hidden', ok);
    }
    var res = $('res-line');
    if (res && !$('results').classList.contains('hidden')) {
      var div = $('tq-sent');
      if (!div) {
        div = document.createElement('div');
        div.id = 'tq-sent';
        res.parentNode.insertBefore(div, res.nextSibling);
      }
      div.className = ok ? 'ok' : 'no';
      div.textContent = msg.replace(/<[^>]*>/g, '');
    }
  }

  /* ================= expiry / lock (timed mode only) ================= */
  function expireSession() {
    var s = loadSession();
    if (!s || s.submitted) return;
    stopCountdown();
    // lock the quiz UI and show the time's-up card FIRST, so the async
    // submit confirmation below has a visible place to land in.
    document.querySelectorAll('#q-body .opt').forEach(function (b) { b.disabled = true; });
    if ($('btn-next')) $('btn-next').classList.add('hidden');
    if ($('btn-finish')) $('btn-finish').classList.add('hidden');
    if ($('quiz')) $('quiz').classList.add('hidden');
    if ($('home')) $('home').classList.add('hidden');
    if ($('results')) $('results').classList.add('hidden');
    document.querySelectorAll('.floating-bar').forEach(function (b) { b.classList.add('hidden'); });
    var durText = s.durationMin ? ('خلصت الـ ' + s.durationMin + ' دقيقة، ') : 'انتهى الوقت، ';
    var line = $('tq-timeup-line');
    if (line) {
      line.innerHTML = durText + esc(s.name) + '.<br>جاوبت صح على <b>' +
        s.score + '</b> من <b>' + TOTAL + '</b> سؤال.';
    }
    if ($('tq-timeup')) $('tq-timeup').classList.remove('hidden');
    var btn = $('tq-retry-send');
    if (btn) btn.classList.add('hidden'); // shown only if the send actually fails
    if ($('tq-timeup')) $('tq-timeup').scrollIntoView();
    submitSession('timeout');
  }

  /* ================= quiz wrapping ================= */
  function setLevelAll() {
    try { selectedLvl = 'all'; } catch (e) {}
    document.querySelectorAll('#levels .lvl').forEach(function (x) {
      x.classList.toggle('on', x.dataset.lvl === 'all');
    });
  }

  function restoreTimedProgress(s) {
    try {
      score = s.score || 0;
      answered = s.answered || 0;
      results = Object.keys(s.answers || {}).map(function (id) {
        return { id: id, ok: !!s.answers[id] };
      });
      var firstOpen = queue.findIndex(function (q) { return !(q.id in (s.answers || {})); });
      if (firstOpen === -1) {
        showResults();
        submitSession('finish');
        return;
      }
      idx = firstOpen;
      renderQ();
      var qs = $('q-score');
      if (qs) qs.textContent = 'صح: ' + score + ' / ' + answered;
    } catch (e) {}
  }

  var _startQuiz = null;
  var _finishAnswer = null;

  function wrapPageFunctions() {
    if (typeof startQuiz === 'function' && !_startQuiz) {
      _startQuiz = startQuiz;
      startQuiz = function (resume) {
        var s = loadSession();
        if (s && s.submitted) {
          noteAlreadySubmitted(s);
          return;
        }
        if (s && !s.submitted) {
          if (s.mode === 'timed') {
            var remaining = durationMs(s) - (Date.now() - s.startedAt);
            if (remaining <= 0) { expireSession(); return; }
          }
          _startQuiz(false); // fresh full queue, then jump to first unanswered
          restoreTimedProgress(s);
          startCountdown(s);
          startProgressTimer();
          return;
        }
        // no session yet: name + course number are required, then start the server clock
        var name = readName();
        var courseNumber = readCourseNumber();
        var mode = readMode();
        var durationMin = readDurationMin();
        if (!name || !courseNumber) {
          setHomeNote('اكتب <b>اسمك</b> و<b>رقمك في الكورس</b> الأول فوق زر «ابدأ الأسئلة» — الاختبار محتاجهم عشان الحضور.');
          var inp = $('tq-name');
          if (!name && inp) inp.focus();
          else { var inp2 = $('tq-num'); if (inp2) inp2.focus(); }
          return;
        }
        if (mode === 'timed' && durationMin == null) {
          setHomeNote('اختار مدة صحيحة للاختبار الموقوت: من <b>' + MIN_DURATION_MIN + '</b> لـ <b>' + MAX_DURATION_MIN + '</b> دقيقة.');
          var inp3 = $('tq-dur-custom');
          if (inp3) inp3.focus();
          return;
        }
        setLevelAll(); // an attempt always runs the full question set
        var btn = $('btn-start');
        if (btn) { btn.disabled = true; btn.textContent = 'جارٍ بدء الوقت…'; }
        postJSON({ action: 'start', name: name, courseNumber: courseNumber, mode: mode, durationMin: durationMin }).then(function (res) {
          var startedAt = (res && res.startedAt) ? res.startedAt : Date.now();
          var sess = {
            name: name, courseNumber: courseNumber,
            mode: (res && res.mode) || mode,
            durationMin: (res && res.durationMin != null) ? res.durationMin : durationMin,
            startedAt: startedAt, submitted: false,
            answers: {}, score: 0, answered: 0, total: TOTAL,
            startUnconfirmed: !(res && res.ok)
          };
          saveSession(sess);
          lockStartFields(sess);
          if (btn) { btn.disabled = false; btn.textContent = 'ابدأ الأسئلة ←'; }
          _startQuiz(false);
          startCountdown(sess);
          startProgressTimer();
          sendProgress(); // first progress row right at start
        }).catch(function () {
          // endpoint unreachable: keep going on the local clock; the server
          // will validate on submit against the client-sent startedAt.
          var startedAt = Date.now();
          var sess = {
            name: name, courseNumber: courseNumber, mode: mode, durationMin: durationMin,
            startedAt: startedAt, submitted: false,
            answers: {}, score: 0, answered: 0, total: TOTAL, startUnconfirmed: true
          };
          saveSession(sess);
          lockStartFields(sess);
          if (btn) { btn.disabled = false; btn.textContent = 'ابدأ الأسئلة ←'; }
          _startQuiz(false);
          startCountdown(sess);
          startProgressTimer();
        });
      };
    }
    if (typeof finishAnswer === 'function' && !_finishAnswer) {
      _finishAnswer = finishAnswer;
      finishAnswer = function (ok) {
        _finishAnswer(ok);
        try {
          var s = loadSession();
          if (s && !s.submitted) {
            var q = cur();
            if (q) s.answers[q.id] = !!ok;
            s.score = score;
            s.answered = answered;
            saveSession(s);
            sendProgress(); // progress on every answer
          }
        } catch (e) {}
      };
    }
  }

  /* ================= init ================= */
  function init() {
    if (typeof QUESTIONS === 'undefined' || !$('btn-start')) return; // page not ready / redesigned IDs
    injectStyles();
    injectStartFields();
    injectTimerBar();
    injectTimeUpCard();
    wrapPageFunctions();

    // btn-finish was bound to the showResults OBJECT at registration, so a
    // later listener runs after the page's own showResults: submit then.
    var bf = $('btn-finish');
    if (bf) {
      bf.addEventListener('click', function () {
        var s = loadSession();
        if (s && !s.submitted) submitSession('finish');
      });
    }

    // progress on pagehide (tab close / navigate away) via sendBeacon
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', sendProgressBeacon);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') sendProgressBeacon();
      });
    }

    var s = loadSession();
    if (!s) return;
    var inp = $('tq-name');
    if (inp) { inp.value = s.name; inp.disabled = true; }
    var inp2 = $('tq-num');
    if (inp2) { inp2.value = s.courseNumber; inp2.disabled = true; }
    lockStartFields(s);
    if (s.submitted) {
      var bs = $('btn-start'), br = $('btn-resume');
      if (bs) bs.disabled = true;
      if (br) br.classList.add('hidden');
      noteAlreadySubmitted(s);
      return;
    }
    if (s.mode === 'timed') {
      var remaining = durationMs(s) - (Date.now() - s.startedAt);
      if (remaining <= 0) {
        expireSession();
        return;
      }
      var br2 = $('btn-resume');
      if (br2) { br2.classList.remove('hidden'); br2.textContent = 'كمّل المحاولة الموقوتة'; }
      setHomeNote('عندك محاولة موقوتة شغالة — المتبقي: <b>' + fmt(remaining) + '</b>. اضغط «ابدأ الأسئلة» للمتابعة من مطرح ما وقفت.');
    } else {
      var br3 = $('btn-resume');
      if (br3) { br3.classList.remove('hidden'); br3.textContent = 'كمّل المحاولة (غير موقوتة)'; }
      setHomeNote('عندك محاولة غير موقوتة شغالة. اضغط «ابدأ الأسئلة» للمتابعة من مطرح ما وقفت.');
    }
    startCountdown(s); // keeps counting even while on the home screen (timed only)
    startProgressTimer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
