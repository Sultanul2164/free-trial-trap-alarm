const DAY = 24 * 3600 * 1000;
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- tabs ----------
function showTab(name) {
  $("viewTrials").hidden = name !== "trials";
  $("viewSettings").hidden = name !== "settings";
  $("tabTrials").classList.toggle("active", name === "trials");
  $("tabSettings").classList.toggle("active", name === "settings");
  if (name === "settings") renderSettings();
}
$("tabTrials").onclick = () => showTab("trials");
$("tabSettings").onclick = () => showTab("settings");

// ---------- trials ----------
function button(text, cls, onclick) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onclick;
  return b;
}

function makeCard(t) {
  const now = Date.now();
  const daysLeft = Math.ceil((t.endAt - now) / DAY);
  const over = !t.cancelled && daysLeft <= 0;
  const soon = !t.cancelled && !over && daysLeft <= 2;

  const card = document.createElement("div");
  card.className = "card" + (t.cancelled ? " done" : over ? " over" : soon ? " soon" : "");

  const top = document.createElement("div");
  top.className = "top";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = t.site; // textContent: never inject page-supplied text as HTML
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = t.cancelled ? "Cancelled ✓" : over ? "Trial ended" : daysLeft + (daysLeft === 1 ? " day left" : " days left");
  top.append(name, chip);

  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = over
    ? "Ended " + new Date(t.endAt).toLocaleDateString() + ". Check your card for charges."
    : "Ends " + new Date(t.endAt).toLocaleDateString();

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  const pct = Math.max(0, Math.min(1, (now - t.startAt) / (t.endAt - t.startAt)));
  fill.style.width = Math.round((t.cancelled ? 1 : pct) * 100) + "%";
  bar.append(fill);

  const actions = document.createElement("div");
  actions.className = "actions";
  if (t.cancelled) {
    actions.append(button("Undo", "", async () => { await send({ type: "SET_CANCELLED", id: t.id, value: false }); render(); }));
  } else {
    actions.append(button("I cancelled it", "primary", async () => { await send({ type: "SET_CANCELLED", id: t.id, value: true }); render(); }));
    if (!over) {
      const snoozed = t.snoozeUntil && t.snoozeUntil > now;
      actions.append(button(snoozed ? "Snoozed" : "Snooze 1 day", "", async () => { await send({ type: "SNOOZE", id: t.id }); render(); }));
    }
  }
  actions.append(button("✕", "danger", async () => { await send({ type: "DELETE_TRIAL", id: t.id }); render(); }));
  if (t.url) {
    const a = document.createElement("a");
    a.textContent = "Open site";
    a.href = t.url;
    a.target = "_blank";
    actions.append(a);
  }

  card.append(top, sub, bar, actions);
  return card;
}

async function render() {
  const { trials = [] } = await chrome.storage.local.get("trials");
  const active = trials.filter(t => !t.cancelled).sort((a, b) => a.endAt - b.endAt);
  const done = trials.filter(t => t.cancelled).sort((a, b) => b.endAt - a.endAt);

  const list = $("list");
  list.innerHTML = "";
  if (!active.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "<b>No active trials 🎉</b>Visit a signup page and I'll offer to remind you, or add one below.";
    list.append(e);
  }
  active.forEach(t => list.append(makeCard(t)));

  $("doneWrap").hidden = !done.length;
  $("doneSummary").textContent = "Cancelled (" + done.length + ")";
  $("doneList").innerHTML = "";
  done.forEach(t => $("doneList").append(makeCard(t)));
}

$("addBtn").onclick = async () => {
  const site = $("name").value.trim();
  const days = parseInt($("days").value, 10);
  if (!site || !days) return;
  await send({ type: "ADD_TRIAL", trial: { site, days } });
  $("name").value = "";
  render();
};

// ---------- settings ----------
async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { enabled: true, leadDays: 2, excluded: [], ...settings };
}
async function saveSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}

async function renderSettings() {
  const s = await getSettings();
  $("enabled").checked = s.enabled;
  $("lead").value = String(s.leadDays);

  const box = $("excludedList");
  box.innerHTML = "";
  if (!s.excluded.length) {
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "No skipped sites yet.";
    box.append(p);
  }
  s.excluded.forEach(host => {
    const row = document.createElement("div");
    row.className = "exrow";
    const span = document.createElement("span");
    span.textContent = host;
    row.append(span, button("Remove", "", async () => {
      await saveSettings({ excluded: s.excluded.filter(h => h !== host) });
      renderSettings();
    }));
    box.append(row);
  });
}

$("enabled").onchange = (e) => saveSettings({ enabled: e.target.checked });
$("lead").onchange = (e) => saveSettings({ leadDays: parseInt(e.target.value, 10) });
$("exAdd").onclick = async () => {
  let h = $("exInput").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!h) return;
  const s = await getSettings();
  if (!s.excluded.includes(h)) await saveSettings({ excluded: [...s.excluded, h] });
  $("exInput").value = "";
  renderSettings();
};

render();
