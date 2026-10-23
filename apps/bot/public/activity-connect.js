/**
 * Discord Activity audio connector.
 *
 * The Activity runs inside Discord's iframe on a proxied origin, so it cannot
 * present our session cookie. Instead it asks the panel for permission:
 *
 *   1. this script POSTs /api/activity/pair and shows a 6-character code;
 *   2. the owner opens the panel key dialog, presses "Connect Activity" and
 *      types that code;
 *   3. the script polls, receives a short-lived view invite, and hands it to
 *      the visualizer socket, which then receives PCM like /listen does.
 *
 * The invite is view-scoped (no controls) and stays in sessionStorage so a
 * reload inside the same Activity session reconnects without pairing again.
 */
(function () {
  'use strict';
  if (!window.__VZ_ACTIVITY__) return;

  var STORE = 'vz-act-invite';
  var ui = null;
  var btn = null;
  var msg = null;
  var pollTimer = null;
  var pendingCode = null;

  function wsUrlFor(token) {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/ws?invite=' + encodeURIComponent(token);
  }

  function applyInvite(token) {
    window.__VZ_WS__ = wsUrlFor(token);
    if (typeof window.__vzReconnect === 'function') window.__vzReconnect();
  }

  // A previous pairing in this Activity session: reconnect straight away.
  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && saved.token && saved.exp > Date.now()) applyInvite(saved.token);
  } catch (e) {
    /* private mode / bad json */
  }

  function setMsg(text) {
    if (msg) msg.textContent = text;
  }

  var pill = null;
  var HIDE_KEY = 'vz-act-hidden';

  function build() {
    if (ui || !document.body) return;
    ui = document.createElement('div');
    ui.style.cssText =
      'position:fixed;left:14px;bottom:14px;z-index:2147483000;max-width:330px;padding:12px 14px;' +
      'border-radius:12px;background:rgba(13,16,22,.94);border:1px solid #222835;color:#e9edf6;' +
      'font:13px/1.45 system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5)';
    ui.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<b style="letter-spacing:.08em;font-size:11px;text-transform:uppercase;color:#8b97ad">Hi-fi audio</b>' +
      '<button type="button" class="vz-x" aria-label="Hide" title="Hide" style="flex:0 0 auto;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:1px solid #2b3446;background:#1a1f2b;color:#c7d2e5;font:600 15px/1 system-ui;cursor:pointer">\u00d7</button>' +
      '</div>' +
      '<div class="vz-m" style="margin:6px 0 10px">This Activity shows visuals only. Connect it to hear the stream.</div>' +
      '<button type="button" class="vz-go" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid #2c5a50;background:linear-gradient(180deg,#1b3733,#132520);color:#d9fff4;font-weight:600;cursor:pointer">Connect audio</button>' +
      '<div style="margin-top:8px;color:#5f6b80;font-size:11px">Visuals keep working either way.</div>';
    document.body.appendChild(ui);
    btn = ui.querySelector('.vz-go');
    msg = ui.querySelector('.vz-m');
    btn.onclick = start;
    ui.querySelector('.vz-x').onclick = hide;

    // Collapsed pill: always available once dismissed, so audio can be enabled
    // later without reloading the Activity.
    pill = document.createElement('button');
    pill.type = 'button';
    pill.textContent = 'Audio';
    pill.setAttribute('aria-label', 'Hi-fi audio');
    pill.style.cssText =
      'position:fixed;left:14px;bottom:14px;z-index:2147483000;padding:8px 14px;border-radius:999px;' +
      'border:1px solid #2c5a50;background:rgba(13,16,22,.92);color:#7ee0c2;font:600 11px/1 system-ui;' +
      'letter-spacing:.1em;text-transform:uppercase;cursor:pointer;display:none';
    pill.onclick = show;
    document.body.appendChild(pill);

    var wasHidden = false;
    try {
      wasHidden = sessionStorage.getItem(HIDE_KEY) === '1';
    } catch (e) {
      /* storage blocked: start expanded */
    }
    if (wasHidden) hide();
  }

  function hide() {
    if (ui) ui.style.display = 'none';
    if (pill) pill.style.display = '';
    try {
      sessionStorage.setItem(HIDE_KEY, '1');
    } catch (e) {
      /* ignore */
    }
  }

  function show() {
    if (ui) ui.style.display = '';
    if (pill) pill.style.display = 'none';
    try {
      sessionStorage.removeItem(HIDE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  /** POST the pair request; the Discord proxy may refuse it, so retry the
   *  absolute public origin (CORS is open for this unauthenticated endpoint). */
  function requestPair() {
    var first = fetch('/api/activity/pair', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    return first.catch(function () {
      var origin = (window.__VZ_STATE__ && window.__VZ_STATE__.origin) || '';
      if (!origin || origin === location.origin) throw new Error('unreachable');
      return fetch(origin + '/api/activity/pair', { method: 'POST' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    });
  }

  function start() {
    btn.disabled = true;
    setMsg('Creating a code...');
    requestPair()
      .then(function (d) {
        if (!d || !d.code) throw new Error('no code');
        pendingCode = d.code;
        msg.innerHTML =
          'In the <b>Vaporzr panel</b>, open the key dialog and press <b>Connect Activity</b>, then enter:' +
          '<div style="margin:8px 0;font:700 20px/1 ui-monospace,monospace;letter-spacing:.28em;color:#7ee0c2">' +
          String(d.code) +
          '</div>Waiting for approval...';
        poll();
      })
      .catch(function (err) {
        btn.disabled = false;
        setMsg(
          'Could not reach the bot' + (err && err.message ? ' (' + err.message + ')' : '') + '. Tap Hide and retry.',
        );
      });
  }

  function poll() {
    if (!pendingCode) return;
    fetch('/api/activity/pair/' + encodeURIComponent(pendingCode))
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d && d.status === 'approved' && d.invite) {
          try {
            sessionStorage.setItem(STORE, JSON.stringify({ token: d.invite, exp: Date.now() + 20 * 60 * 1000 }));
          } catch (e) {
            /* ignore */
          }
          applyInvite(d.invite);
          setMsg('Connected - audio is live here.');
          if (btn) btn.remove();
          setTimeout(function () {
            if (ui) ui.remove();
            ui = null;
            if (pill) pill.remove();
            pill = null;
            try {
              sessionStorage.removeItem(HIDE_KEY);
            } catch (e) {
              /* ignore */
            }
          }, 2500);
          return;
        }
        if (d && d.status === 'expired') {
          setMsg('That code expired. Press Connect again.');
          if (btn) btn.disabled = false;
          return;
        }
        pollTimer = setTimeout(poll, 2500);
      })
      .catch(function () {
        pollTimer = setTimeout(poll, 4000);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
