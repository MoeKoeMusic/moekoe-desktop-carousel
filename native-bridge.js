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
let lastSongSignature = "";
let watcherLastSeen = 0;

const state = {
  cacheWatcherConnected: false,
  hostRunning: false,
  currentHash: "",
  currentSongName: "",
  currentAuthor: "",
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

  const author = String(song.author || "").trim();
  if (!author) {
    keepCurrentBackground(song.displayName || song.name || "");
    return;
  }

  const hash = String(song.hash || "");
  const signature = `${hash}\n${author}`;
  if (signature === lastSongSignature) return;

  lastSongSignature = signature;
  state.currentHash = hash;
  state.currentSongName = song.displayName || song.name || "";
  state.currentAuthor = author;
  await loadSongImages(author);
}

function keepCurrentBackground(songName = "") {
  lastSongSignature = "";
  state.currentHash = "";
  state.currentSongName = songName;
  state.currentAuthor = "";
  emitStatus();
}

function refreshWatcherStatus() {
  state.cacheWatcherConnected = watcherLastSeen > 0 && Date.now() - watcherLastSeen < WATCHER_STALE_MS;
}

async function loadSongImages(author) {
  if (!settings.enabled) return;

  try {
    const images = await fetchAuthorImages(author);
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

async function fetchAuthorImages(author) {
  const authorId = await fetchAuthorId(author);
  const params = new URLSearchParams({
    fields_pack: "allimages",
    authorimg_type: "2,3",
    entity_id: authorId
  });
  const url = `https://openapicdnretry.kugou.com/kmr/v1/author/extend?${params}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`封面接口请求失败: ${response.status}`);
  }

  const payload = await response.json();
  return extractAuthorImages(payload).slice(0, settings.maxImages);
}

async function fetchAuthorId(author) {
  const params = new URLSearchParams({
    keywords: author,
    type: "author"
  });
  const url = `${settings.apiBaseUrl.replace(/\/+$/, "")}/search?${params}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`歌手接口请求失败: ${response.status}`);
  }

  const payload = await response.json();
  const authors = Array.isArray(payload?.data?.lists) ? payload.data.lists : [];
  const matched = authors.find((item) => item?.AuthorName === author) || authors[0];
  const authorId = matched?.AuthorId || matched?.author_id || matched?.id;

  if (!authorId) {
    throw new Error(`未找到歌手: ${author}`);
  }

  return String(authorId);
}

function extractAuthorImages(payload) {
  const images = [];
  const groups = Array.isArray(payload?.data) ? payload.data : [];

  groups.forEach((group) => {
    images.push(...collectImageUrls(group?.imgs));
    images.push(...collectImageUrls(group?.base?.avatar));
  });

  return [...new Set(images)];
}

function collectImageUrls(imgs) {
  const urls = [];
  const visit = (value) => {
    if (!value) return;

    if (typeof value === "string") {
      const url = normalizeImageUrl(value);
      if (url) urls.push(url);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value === "object") {
      const url = normalizeImageUrl(
        value.file ||
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
    if (state.currentAuthor) {
      lastImageSignature = "";
      await loadSongImages(state.currentAuthor);
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

  if (state.currentAuthor) {
    lastImageSignature = "";
    await loadSongImages(state.currentAuthor);
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
