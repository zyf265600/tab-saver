// Slider positions map to these minute values (not linear, so short times are easy to pick).
const STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

const $ = (id) => document.getElementById(id);

// Shown when Chrome has no favicon for a site.
const FALLBACK_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8e6cf2" stroke-width="2">' +
  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>'
);
function setFavicon(img, domain) {
  img.onerror = () => { img.onerror = null; img.src = FALLBACK_ICON; };
  img.src = faviconUrl(domain);
}
const slider = $("timeSlider");
const domainInput = $("domainInput");
const errorMsg = $("errorMsg");

let settings = { ...DEFAULT_SETTINGS };
let currentTabDomain = "";

function formatMinutes(min) {
  if (min < 60) return { value: String(min), unit: "分钟" };
  const hours = min / 60;
  return { value: Number.isInteger(hours) ? String(hours) : hours.toFixed(1), unit: "小时" };
}

function closestStepIndex(min) {
  let best = 0;
  STEPS.forEach((step, i) => {
    if (Math.abs(step - min) < Math.abs(STEPS[best] - min)) best = i;
  });
  return best;
}

function faviconUrl(domain) {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", "https://" + domain);
  url.searchParams.set("size", "32");
  return url.toString();
}

let savedTimer;
function flashSaved() {
  const badge = $("savedBadge");
  badge.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => badge.classList.remove("show"), 1200);
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
}

/* ---------- Time ---------- */
function renderTime() {
  const index = Number(slider.value);
  const minutes = STEPS[index];
  const { value, unit } = formatMinutes(minutes);
  $("timeValue").textContent = value;
  $("timeUnit").textContent = unit;
  $("timeHint").innerHTML = `标签页超过 <b>${value} ${unit}</b>没有被查看，就会自动休眠。`;
  slider.style.setProperty("--fill", (index / (STEPS.length - 1)) * 100 + "%");
}

slider.addEventListener("input", renderTime);
slider.addEventListener("change", async () => {
  await save({ idleMinutes: STEPS[Number(slider.value)] });
  flashSaved();
});

/* ---------- Whitelist ---------- */
function renderWhitelist() {
  const list = $("wlList");
  list.replaceChildren();

  for (const domain of settings.whitelist) {
    const li = document.createElement("li");
    li.className = "wl-item";

    const icon = document.createElement("img");
    icon.className = "favicon";
    setFavicon(icon, domain);
    icon.alt = "";

    const name = document.createElement("span");
    name.className = "wl-domain";
    name.textContent = domain;

    const remove = document.createElement("button");
    remove.className = "btn-remove";
    remove.title = "移出白名单";
    remove.setAttribute("aria-label", `移除 ${domain}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.addEventListener("click", () => removeDomain(domain));

    li.append(icon, name, remove);
    list.append(li);
  }

  $("wlCount").textContent = settings.whitelist.length;
  $("wlEmpty").hidden = settings.whitelist.length > 0;
  $("addCurrent").hidden = !currentTabDomain || settings.whitelist.includes(currentTabDomain);
}

function showError(text) {
  errorMsg.textContent = text;
  domainInput.classList.toggle("invalid", Boolean(text));
}

async function addDomain(raw) {
  const domain = normalizeDomain(raw);
  if (!domain) {
    showError("请输入有效的网站地址，例如 github.com");
    return false;
  }
  if (settings.whitelist.includes(domain)) {
    showError(`${domain} 已经在白名单里了`);
    return false;
  }
  showError("");
  await save({ whitelist: [domain, ...settings.whitelist] });
  renderWhitelist();
  refreshCounts();
  return true;
}

async function removeDomain(domain) {
  await save({ whitelist: settings.whitelist.filter((d) => d !== domain) });
  renderWhitelist();
  refreshCounts();
}

$("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await addDomain(domainInput.value)) domainInput.value = "";
});

domainInput.addEventListener("input", () => showError(""));

$("addCurrent").addEventListener("click", () => addDomain(currentTabDomain));

/* ---------- One-click sleep ---------- */
let toastTimer;
function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

async function refreshCounts() {
  const [windowTabs, allTabs] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.query({})
  ]);
  const sleepable = (tabs) => tabs.filter((t) => !isProtected(t, settings.whitelist)).length;
  const windowCount = sleepable(windowTabs);
  const allCount = sleepable(allTabs);

  $("windowSub").textContent = windowCount ? `可休眠 ${windowCount} 个` : "没有可休眠的";
  $("allSub").textContent = allCount ? `可休眠 ${allCount} 个` : "没有可休眠的";
  $("sleepWindow").disabled = windowCount === 0;
  $("sleepAll").disabled = allCount === 0;

  const asleep = (tabs) => tabs.filter((t) => t.discarded).length;
  const windowAsleep = asleep(windowTabs);
  const allAsleep = asleep(allTabs);
  $("wakeWindowSub").textContent = windowAsleep ? `可唤醒 ${windowAsleep} 个` : "没有休眠的";
  $("wakeAllSub").textContent = allAsleep ? `可唤醒 ${allAsleep} 个` : "没有休眠的";
  $("wakeWindow").disabled = windowAsleep === 0;
  $("wakeAll").disabled = allAsleep === 0;
  $("sleepingCount").textContent = allAsleep;
}

async function sleepNow(query) {
  const tabs = await chrome.tabs.query(query);
  const count = await sleepTabs(tabs, settings.whitelist);
  showToast(count ? `已休眠 ${count} 个标签页` : "没有可以休眠的标签页");
  await refreshCounts();
}

$("sleepWindow").addEventListener("click", () => sleepNow({ currentWindow: true }));
$("sleepAll").addEventListener("click", () => sleepNow({}));

// Reloading a discarded tab loads it again in the background, without switching to it.
async function wakeNow(query) {
  const tabs = await chrome.tabs.query({ ...query, discarded: true });
  const results = await Promise.allSettled(tabs.map((tab) => chrome.tabs.reload(tab.id)));
  const count = results.filter((r) => r.status === "fulfilled").length;
  showToast(count ? `已唤醒 ${count} 个标签页` : "没有休眠的标签页");
  await refreshCounts();
}

$("wakeWindow").addEventListener("click", () => wakeNow({ currentWindow: true }));
$("wakeAll").addEventListener("click", () => wakeNow({}));

/* ---------- Init ---------- */
async function init() {
  settings = await loadSettings();

  slider.max = String(STEPS.length - 1);
  slider.value = String(closestStepIndex(settings.idleMinutes));
  renderTime();

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url && /^https?:/.test(activeTab.url)) {
    currentTabDomain = normalizeDomain(activeTab.url);
    $("currentDomain").textContent = currentTabDomain;
    setFavicon($("currentFavicon"), currentTabDomain);
  }
  renderWhitelist();
  await refreshCounts();
}

init();
