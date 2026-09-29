const DAY = 24 * 3600 * 1000;
const DEFAULT_SETTINGS = { enabled: true, leadDays: 2, excluded: [] };

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}
async function getTrials() {
  const { trials = [] } = await chrome.storage.local.get("trials");
  return trials;
}
const saveTrials = (trials) => chrome.storage.local.set({ trials });

// When to warn: leadDays before the end, but never earlier than makes sense for short trials
function warnAt(t, s) {
  const lead = Math.min(s.leadDays, Math.max(1, t.days - 1));
  return t.endAt - lead * DAY;
}

function clearAlarms(id) {
  ["warn", "end", "snooze"].forEach(k => chrome.alarms.clear(id + "|" + k));
}

// ---------- notifications ----------
function notify(t, kind, title, message) {
  chrome.notifications.create(t.id + "|" + kind, {
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message,
    requireInteraction: true,
    buttons: [{ title: "I cancelled it" }, { title: "Snooze 1 day" }]
  });
}
const endDate = (t) => new Date(t.endAt).toLocaleDateString();
const notifyWarn = (t) => notify(t, "warn", "Trial ending soon: " + t.site,
  "Ends " + endDate(t) + ". Cancel now to avoid being charged.");
const notifyEnd = (t) => notify(t, "end", "Trial ended: " + t.site,
  "Check whether you were charged, and cancel if you don't want it.");
const notifySnooze = (t) => notify(t, "snooze", "Reminder: " + t.site,
  "Your trial ends " + endDate(t) + ". Still want it?");

// ---------- scheduling ----------
// Alarms can be cleared when the browser restarts, so we rebuild them every time.
async function rescheduleAll() {
  const s = await getSettings();
  const trials = await getTrials();
  const now = Date.now();
  let changed = false;

  for (const t of trials) {
    if (t.cancelled) { clearAlarms(t.id); continue; }

    if (!t.warned) {
      const w = warnAt(t, s);
      if (w <= now && t.endAt > now) { notifyWarn(t); t.warned = true; changed = true; }
      else if (w > now) chrome.alarms.create(t.id + "|warn", { when: w });
    }
    if (!t.ended) {
      if (t.endAt <= now) { notifyEnd(t); t.ended = true; changed = true; }
      else chrome.alarms.create(t.id + "|end", { when: t.endAt });
    }
    if (t.snoozeUntil) {
      if (t.snoozeUntil > now) chrome.alarms.create(t.id + "|snooze", { when: t.snoozeUntil });
      else { notifySnooze(t); delete t.snoozeUntil; changed = true; }
    }
  }
  if (changed) await saveTrials(trials);
}

chrome.runtime.onInstalled.addListener(rescheduleAll);
chrome.runtime.onStartup.addListener(rescheduleAll);
chrome.storage.onChanged.addListener((ch) => { if (ch.settings) rescheduleAll(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [id, kind] = alarm.name.split("|");
  const trials = await getTrials();
  const t = trials.find(x => x.id === id);
  if (!t || t.cancelled) return;
  if (kind === "warn" && !t.warned) { notifyWarn(t); t.warned = true; }
  else if (kind === "end" && !t.ended) { notifyEnd(t); t.ended = true; }
  else if (kind === "snooze" && t.snoozeUntil) { notifySnooze(t); delete t.snoozeUntil; }
  await saveTrials(trials);
});

// ---------- actions ----------
async function setCancelled(id, value) {
  const trials = await getTrials();
  const t = trials.find(x => x.id === id);
  if (!t) return;
  t.cancelled = value;
  if (value) { delete t.snoozeUntil; clearAlarms(id); }
  await saveTrials(trials);
  if (!value) await rescheduleAll();
}

async function snooze(id) {
  const trials = await getTrials();
  const t = trials.find(x => x.id === id);
  if (!t || t.cancelled) return;
  const now = Date.now();
  const when = Math.min(now + DAY, t.endAt - 30 * 60 * 1000); // never snooze past the end
  if (when <= now + 60 * 1000) return; // too close to the end to snooze
  t.snoozeUntil = when;
  await saveTrials(trials);
  chrome.alarms.create(id + "|snooze", { when });
}

chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
  const id = nid.split("|")[0];
  if (index === 0) await setCancelled(id, true);
  else await snooze(id);
  chrome.notifications.clear(nid);
});

chrome.notifications.onClicked.addListener(async (nid) => {
  const id = nid.split("|")[0];
  const t = (await getTrials()).find(x => x.id === id);
  if (t && t.url) chrome.tabs.create({ url: t.url });
  chrome.notifications.clear(nid);
});

// ---------- messages from the popup and pages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A trial was spotted inside an embedded frame: pass it to the tab's main page
  if (msg.type === "FRAME_TRIAL") {
    if (sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, { type: "SHOW_TRIAL_BANNER", days: msg.days }, { frameId: 0 })
        .catch(() => {});
    }
    return;
  }
  (async () => {
    if (msg.type === "ADD_TRIAL") {
      const trials = await getTrials();
      const now = Date.now();
      trials.push({
        id: crypto.randomUUID(),
        site: msg.trial.site, host: msg.trial.host || "", url: msg.trial.url || "",
        days: msg.trial.days, startAt: now, endAt: now + msg.trial.days * DAY,
        warned: false, ended: false, cancelled: false
      });
      await saveTrials(trials);
      await rescheduleAll();
    } else if (msg.type === "DELETE_TRIAL") {
      clearAlarms(msg.id);
      await saveTrials((await getTrials()).filter(t => t.id !== msg.id));
    } else if (msg.type === "SET_CANCELLED") {
      await setCancelled(msg.id, msg.value);
    } else if (msg.type === "SNOOZE") {
      await snooze(msg.id);
    }
    sendResponse({ ok: true });
  })();
  return true; // keep the channel open for the async reply
});
