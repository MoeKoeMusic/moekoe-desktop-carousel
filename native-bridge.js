const HOST_ID = "desktop-cover-carousel";
const SETTINGS_KEY = "desktopCoverCarouselSettings";
const WATCHER_STALE_MS = 8000;
const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://127.0.0.1:6521",
  intervalSeconds: 7,
  fadeMilliseconds: 1200,
  maxImages: 12,
  fit: "cover",
  shuffle: false,
  enabled: true
};

const port = chrome.runtime.connect({ name: "moekoe-desktop-carousel" });

let settings = { ...DEFAULT_SETTINGS };
let lastImageSignature = "";
let lastHash = "";
let watcherLastSeen = 0;

const state = {
  cacheWatcherConnected: false,
  hostRunning: false,
  currentHash: "",
  currentSongName: "",
  imageCount: 0,
  lastFetchAt: "",
  lastError: "",
  enabled: true,
  apiBaseUrl: DEFAULT_SETTINGS.apiBaseUrl
};

port.onMessage.addListener(async (message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "bridge:get-status") {
    respond(message.requestId, await getStatus());
    return;
  }

  if (message.type === "bridge:reconnect") {
    refreshWatcherStatus();
    respond(message.requestId, await getStatus());
    return;
  }

  if (message.type === "bridge:song-changed") {
    await handleCurrentSong(message.song || null);
    respond(message.requestId, await getStatus());
    return;
  }

  if (message.type === "bridge:command") {
    const result = await runCommand(message.action);
    respond(message.requestId, result);
    return;
  }

  if (message.type === "bridge:settings") {
    await updateSettings(message.settings || {});
    respond(message.requestId, await getStatus());
  }
});

init();

async function init() {
  settings = normalizeSettings(await storageGet(SETTINGS_KEY));
  state.enabled = settings.enabled;
  state.apiBaseUrl = settings.apiBaseUrl;
  emitStatus();
  setInterval(() => {
    refreshWatcherStatus();
    emitStatus();
  }, 3000);
}

async function handleCurrentSong(song) {
  watcherLastSeen = Date.now();
  refreshWatcherStatus();

  if (!song || typeof song !== "object") {
    keepCurrentBackground();
    return;
  }

  const hash = String(song.hash || "");
  if (!hash || hash.startsWith("local_")) {
    keepCurrentBackground(song.displayName || song.name || "");
    return;
  }

  if (hash === lastHash) return;

  lastHash = hash;
  state.currentHash = hash;
  state.currentSongName = song.displayName || song.name || "";
  await loadSongImages(hash);
}

function keepCurrentBackground(songName = "") {
  lastHash = "";
  state.currentHash = "";
  state.currentSongName = songName;
  emitStatus();
}

function refreshWatcherStatus() {
  state.cacheWatcherConnected = watcherLastSeen > 0 && Date.now() - watcherLastSeen < WATCHER_STALE_MS;
}

async function loadSongImages(hash) {
  if (!settings.enabled) return;

  try {
    const images = await fetchSongImages(hash);
    const signature = images.join("\n");
    state.imageCount = images.length;
    state.lastFetchAt = new Date().toLocaleString();
    state.lastError = "";

    if (!images.length) {
      state.lastError = "当前歌曲没有可用封面，保留上一首桌面背景";
      emitStatus();
      return;
    }

    if (signature !== lastImageSignature) {
      lastImageSignature = signature;
      await sendHost({
        action: "set-images",
        images,
        intervalSeconds: settings.intervalSeconds,
        fadeMilliseconds: settings.fadeMilliseconds,
        fit: settings.fit,
        shuffle: settings.shuffle
      });
    }
  } catch (error) {
    state.lastError = error.message;
  }

  emitStatus();
}

async function fetchSongImages(hash) {
  const url = `${settings.apiBaseUrl.replace(/\/+$/, "")}/images?hash=${encodeURIComponent(hash)}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`封面接口请求失败: ${response.status}`);
  }

  const payload = await response.json();
  return extractImages(payload).slice(0, settings.maxImages);
}

function extractImages(payload) {
  const images = [];
  const groups = Array.isArray(payload?.data) ? payload.data : [];

  groups.forEach((group) => {
    const authors = Array.isArray(group?.author) ? group.author : [];
    const albums = Array.isArray(group?.album) ? group.album : [];

    authors.forEach((author) => {
      images.push(...collectImageUrls(author?.imgs));
    });
    albums.forEach((album) => {
      images.push(...collectImageUrls(album?.imgs));
    });
  });

  return [...new Set(images)];
}

function collectImageUrls(imgs) {
  const urls = [];
  const visit = (value) => {
    if (!value) return;

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value === "object") {
      const url = normalizeImageUrl(
        value.sizable_portrait ||
        value.sizable_cover ||
        value.url ||
        value.img ||
        value.cover ||
        value.portrait
      );

      if (url) {
        urls.push(url);
        return;
      }

      Object.values(value).forEach(visit);
    }
  };

  visit(imgs);
  return urls;
}

function normalizeImageUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "";
  return url.replace(/\{size\}/g, "640");
}

async function runCommand(action) {
  if (action === "next" || action === "previous" || action === "clear") {
    return sendHost({ action });
  }

  if (action === "refresh") {
    if (state.currentHash) {
      lastImageSignature = "";
      await loadSongImages(state.currentHash);
    }
    return getStatus();
  }

  throw new Error("未知操作");
}

async function updateSettings(partial) {
  settings = normalizeSettings({ ...settings, ...partial });
  await storageSet({ [SETTINGS_KEY]: settings });

  state.enabled = settings.enabled;
  state.apiBaseUrl = settings.apiBaseUrl;

  if (!settings.enabled) {
    await sendHost({ action: "clear" });
    return;
  }

  if (state.currentHash) {
    lastImageSignature = "";
    await loadSongImages(state.currentHash);
  }
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    apiBaseUrl: typeof value.apiBaseUrl === "string" && /^https?:\/\//i.test(value.apiBaseUrl)
      ? value.apiBaseUrl.replace(/\/+$/, "")
      : DEFAULT_SETTINGS.apiBaseUrl,
    intervalSeconds: clampInt(value.intervalSeconds, 3, 60, DEFAULT_SETTINGS.intervalSeconds),
    fadeMilliseconds: clampInt(value.fadeMilliseconds, 0, 5000, DEFAULT_SETTINGS.fadeMilliseconds),
    maxImages: clampInt(value.maxImages, 1, 30, DEFAULT_SETTINGS.maxImages),
    fit: value.fit === "contain" ? "contain" : "cover",
    shuffle: value.shuffle === true,
    enabled: value.enabled !== false
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function sendHost(payload) {
  const result = await window.electronAPI.nativeHost.send(HOST_ID, payload);
  if (!result?.success) {
    throw new Error(result?.message || "本地程序未授权或未启动");
  }

  const status = await window.electronAPI.nativeHost.getStatus(HOST_ID);
  state.hostRunning = status?.host?.running === true;
  return result;
}

async function getStatus() {
  let hostStatus = null;
  try {
    hostStatus = await window.electronAPI.nativeHost.getStatus(HOST_ID);
  } catch (error) {
    hostStatus = { success: false, message: error.message };
  }

  state.hostRunning = hostStatus?.host?.running === true;

  return {
    ...state,
    settings: { ...settings },
    hostStatus
  };
}

async function emitStatus() {
  port.postMessage({
    type: "bridge:status",
    payload: await getStatus()
  });
}

function respond(requestIdValue, result) {
  port.postMessage({
    type: "bridge:response",
    requestId: requestIdValue,
    result
  });
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (items) => resolve(items[key]));
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });
}
