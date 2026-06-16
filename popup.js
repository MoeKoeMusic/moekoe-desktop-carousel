const fields = {
  hostStatus: document.getElementById("hostStatus"),
  moekoeStatus: document.getElementById("moekoeStatus"),
  songStatus: document.getElementById("songStatus"),
  imageStatus: document.getElementById("imageStatus"),
  error: document.getElementById("error"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  intervalSeconds: document.getElementById("intervalSeconds"),
  fadeMilliseconds: document.getElementById("fadeMilliseconds"),
  maxImages: document.getElementById("maxImages"),
  fit: document.getElementById("fit"),
  enabled: document.getElementById("enabled"),
  shuffle: document.getElementById("shuffle")
};

const buttons = {
  save: document.getElementById("saveBtn"),
  refresh: document.getElementById("refreshBtn"),
  reconnect: document.getElementById("reconnectBtn"),
  previous: document.getElementById("previousBtn"),
  next: document.getElementById("nextBtn"),
  clear: document.getElementById("clearBtn")
};

let busy = false;
let lastStatus = null;

buttons.save.addEventListener("click", saveSettings);
buttons.refresh.addEventListener("click", () => runCommand("refresh"));
buttons.reconnect.addEventListener("click", reconnect);
buttons.previous.addEventListener("click", () => runCommand("previous"));
buttons.next.addEventListener("click", () => runCommand("next"));
buttons.clear.addEventListener("click", () => runCommand("clear"));

refresh();
setInterval(refresh, 2000);

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "cover-carousel:get-status" });
  render(result || {});
}

async function reconnect() {
  setBusy(true);
  try {
    await chrome.runtime.sendMessage({ type: "cover-carousel:reconnect" });
  } finally {
    setBusy(false);
    setTimeout(refresh, 500);
  }
}

async function runCommand(action) {
  setBusy(true);
  try {
    await chrome.runtime.sendMessage({ type: "cover-carousel:command", action });
  } catch (error) {
    fields.error.textContent = error.message;
  } finally {
    setBusy(false);
    refresh();
  }
}

async function saveSettings() {
  setBusy(true);
  fields.error.textContent = "";

  const settings = {
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    intervalSeconds: Number(fields.intervalSeconds.value),
    fadeMilliseconds: Number(fields.fadeMilliseconds.value),
    maxImages: Number(fields.maxImages.value),
    fit: fields.fit.value,
    enabled: fields.enabled.checked,
    shuffle: fields.shuffle.checked
  };

  try {
    const result = await chrome.runtime.sendMessage({
      type: "cover-carousel:settings",
      settings
    });
    if (!result?.ok) fields.error.textContent = result?.message || "保存失败";
  } finally {
    setBusy(false);
    refresh();
  }
}

function render(result) {
  lastStatus = result;
  const status = result.lastStatus || {};
  const host = status.hostStatus?.host || {};

  fields.hostStatus.textContent = host.authorized ? (host.running ? "运行中" : "未启动") : "未授权";
  fields.moekoeStatus.textContent = status.cacheWatcherConnected ? "已监听" : "等待主界面";
  fields.songStatus.textContent = status.currentSongName || status.currentHash || "等待播放";
  fields.imageStatus.textContent = `${status.imageCount || 0} 张`;
  fields.error.textContent = status.lastError || result.message || "";

  const settings = status.settings || {};
  fields.apiBaseUrl.value = settings.apiBaseUrl || "http://127.0.0.1:6521";
  fields.intervalSeconds.value = settings.intervalSeconds || 7;
  fields.fadeMilliseconds.value = settings.fadeMilliseconds ?? 1200;
  fields.maxImages.value = settings.maxImages || 12;
  fields.fit.value = settings.fit || "cover";
  fields.enabled.checked = settings.enabled !== false;
  fields.shuffle.checked = settings.shuffle === true;

  const controlsEnabled = Boolean(result.bridgeConnected && host.authorized);
  Object.values(buttons).forEach((button) => {
    button.disabled = busy;
  });
  buttons.previous.disabled = busy || !controlsEnabled;
  buttons.next.disabled = busy || !controlsEnabled;
  buttons.clear.disabled = busy || !controlsEnabled;
}

function setBusy(value) {
  busy = value;
  if (lastStatus) render(lastStatus);
}
