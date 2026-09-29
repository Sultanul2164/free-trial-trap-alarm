// Free-Trial Trap Alarm - content script. Everything runs locally in your browser.
(() => {
  const isTop = window.top === window; // false when inside an embedded frame

  const URL_HINT = /(checkout|signup|sign-up|register|subscribe|subscription|trial|billing|payment|plans?|start)/i;

  // Sites where scanning makes no sense (private apps). Users can add more in Settings.
  const BUILTIN_EXCLUDED = [
    "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
    "web.whatsapp.com", "messenger.com", "docs.google.com", "drive.google.com",
    "calendar.google.com", "teams.microsoft.com", "app.slack.com"
  ];

  // ---------- settings (loaded once, kept fresh) ----------
  let settings = { enabled: true, excluded: [] };
  const ready = (async () => {
    try {
      const r = await chrome.storage.local.get("settings");
      settings = { ...settings, ...(r.settings || {}) };
      chrome.storage.onChanged.addListener((ch) => {
        if (ch.settings) settings = { enabled: true, excluded: [], ...(ch.settings.newValue || {}) };
      });
    } catch (e) {}
  })();

  const cleanHost = (h) => h.replace(/^www\./, "").toLowerCase();
  function isExcluded(host) {
    const h = cleanHost(host);
    return BUILTIN_EXCLUDED.concat(settings.excluded || []).some(d => h === d || h.endsWith("." + d));
  }

  // ---------- reading the trial length ----------
  const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, twelve: 12 };
  const U = "(day|week|month|year)s?";
  const N = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|ten|twelve)";
  const toDays = (n, unit) => {
    const num = /^\d/.test(n) ? +n : (WORD_NUM[n.toLowerCase()] || 1);
    return Math.min(365, num * UNIT_DAYS[unit.toLowerCase()]);
  };

  function detectDays(text) {
    let m;
    if ((m = text.match(new RegExp(N + "[\\s-]*" + U + "\\s+(?:free\\s+)?trial", "i")))) return toDays(m[1], m[2]);
    if ((m = text.match(new RegExp("free\\s+for\\s+(?:the\\s+first\\s+)?" + N + "\\s*" + U, "i")))) return toDays(m[1], m[2]);
    if ((m = text.match(new RegExp(N + "[\\s-]*" + U + "\\s+free", "i")))) return toDays(m[1], m[2]);
    if ((m = text.match(new RegExp("(?:redeem|claim|enjoy|get|start)\\s+(?:your\\s+)?" + N + "[\\s-]*" + U + "\\s+(?:of|free)", "i")))) return toDays(m[1], m[2]);
    if ((m = text.match(/(?:first|1st)\s+(day|week|month|year)\s+free/i))) return toDays("1", m[1]);
    if ((m = text.match(/free\s+(week|month|year)\b/i))) return toDays("1", m[1]);
    if (/free\s+trial/i.test(text)) return 7; // trial found, length unknown: user can edit
    return null;
  }

  // Modals are usually attached at the END of the page, so read dialogs directly
  // plus both the start and the end of the page text.
  function getPageText() {
    const parts = [];
    document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog').forEach(d => parts.push(d.innerText || ""));
    const body = document.body?.innerText || "";
    parts.push(body.slice(0, 30000), body.slice(-20000));
    return parts.join("\n");
  }

  function looksLikeSignup(text) {
    if (URL_HINT.test(location.href)) return true;
    if (document.querySelector('input[type="password"], input[autocomplete^="cc-"]')) return true;
    return /(card number|security code|\bcvc\b|\bcvv\b|expiry date|due today|cancel any ?time|billing)/i.test(text);
  }

  // ---------- checking the page ----------
  let running = false;
  let notified = false;

  async function check() {
    if (running || document.getElementById("ftta-root")) return;
    running = true;
    try { await doCheck(); } finally { running = false; }
  }

  async function doCheck() {
    await ready;
    if (isTop && (!settings.enabled || isExcluded(location.hostname))) return;
    if (!isTop && (window.innerWidth < 300 || window.innerHeight < 200)) return; // ignore tiny frames
    const text = getPageText();
    const days = detectDays(text);
    if (days === null || !looksLikeSignup(text)) return;

    if (isTop) {
      await promptIfNew(days);
    } else if (!notified) {
      notified = true; // embedded frame: ask the main page to show the box
      try { chrome.runtime.sendMessage({ type: "FRAME_TRIAL", days }).catch(() => {}); } catch (e) {}
    }
  }

  async function promptIfNew(days) {
    await ready;
    const host = location.hostname;
    if (!settings.enabled || isExcluded(host)) return;
    const { trials = [], dismissed = {} } = await chrome.storage.local.get(["trials", "dismissed"]);
    const active = trials.some(t => t.host === host && !t.cancelled && t.endAt > Date.now());
    if (active || (dismissed[host] && dismissed[host] > Date.now())) return;
    showBanner(days, host);
  }

  if (isTop) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "SHOW_TRIAL_BANNER") promptIfNew(msg.days);
    });
  }

  // ---------- the yellow box ----------
  function showBanner(days, host) {
    if (document.getElementById("ftta-root")) return;
    const root = document.createElement("div");
    root.id = "ftta-root";
    const shadow = root.attachShadow({ mode: "open" }); // keeps the site's CSS out
    shadow.innerHTML = `
      <style>
        .box{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:290px;
          background:#fff;color:#222;border:2px solid #f59e0b;border-radius:12px;
          padding:14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)}
        h4{margin:0 0 6px;font-size:15px}
        input{width:56px;padding:4px;border:1px solid #bbb;border-radius:6px}
        .row{margin:10px 0;display:flex;gap:8px;align-items:center}
        button{cursor:pointer;border:0;border-radius:8px;padding:7px 12px;font-size:13px}
        .go{background:#f59e0b;color:#fff;font-weight:600}
        .no{background:#eee}
        .never{background:none;color:#777;text-decoration:underline;padding:7px 4px;font-size:12px}
      </style>
      <div class="box">
        <h4>⏰ Free trial detected</h4>
        <div>Want a reminder before you get charged?</div>
        <div class="row">Trial length: <input id="d" type="number" min="1" max="365" value="${days}"> days</div>
        <div class="row">
          <button class="go" id="go">Remind me</button>
          <button class="no" id="no">Not now</button>
          <button class="never" id="never">Never here</button>
        </div>
      </div>`;
    document.documentElement.appendChild(root);

    shadow.getElementById("go").onclick = async () => {
      const d = Math.max(1, parseInt(shadow.getElementById("d").value, 10) || days);
      await chrome.runtime.sendMessage({
        type: "ADD_TRIAL",
        trial: { site: cleanHost(host), host, url: location.href, days: d }
      });
      root.remove();
    };
    shadow.getElementById("no").onclick = async () => {
      const { dismissed = {} } = await chrome.storage.local.get("dismissed");
      dismissed[host] = Date.now() + 24 * 3600 * 1000; // don't ask again on this site for a day
      await chrome.storage.local.set({ dismissed });
      root.remove();
    };
    shadow.getElementById("never").onclick = async () => {
      const { settings: st = {} } = await chrome.storage.local.get("settings");
      const ex = new Set(st.excluded || []);
      ex.add(cleanHost(host));
      await chrome.storage.local.set({ settings: { ...st, excluded: [...ex] } });
      root.remove();
    };
  }

  // ---------- keep watching (popups can open after load) ----------
  let timer = null;
  let lastRun = 0;
  const schedule = () => {
    if (timer) return; // a check is already queued
    const wait = Math.max(800, 1500 - (Date.now() - lastRun));
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      check();
    }, wait);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  check();
})();
