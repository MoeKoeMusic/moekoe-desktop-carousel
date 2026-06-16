let bridgePort = null;
let requestId = 0;
let lastStatus = null;
const pending = new Map();
const REQUEST_TIMEOUT = 5000;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "moekoe-desktop-carousel") return;

  bridgePort = port;

  port.onDisconnect.addListener(() => {
    if (bridgePort === port) bridgePort = null;
  });

  port.onMessage.addListener((message) => {
    if (message?.type === "bridge:status") {
      lastStatus = message.payload || null;
      return;
    }

    if (message?.type === "bridge:response") {
      const request = pending.get(message.requestId);
      if (!request) return;

      pending.delete(message.requestId);
      clearTimeout(request.timer);
      request.resolve(message.result);
    }
  });

  sendBridgeRequest("bridge:get-status").catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, message: "消息格式不正确" });
    return;
  }

  if (message.type === "cover-carousel:get-status") {
    getStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "cover-carousel:song-changed") {
    sendBridgeRequest("bridge:song-changed", { song: message.song || null })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "cover-carousel:reconnect") {
    sendBridgeRequest("bridge:reconnect")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "cover-carousel:command") {
    sendBridgeRequest("bridge:command", { action: message.action })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "cover-carousel:settings") {
    sendBridgeRequest("bridge:settings", { settings: message.settings || {} })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  sendResponse({ ok: false, message: "未知消息类型" });
});

async function getStatus() {
  if (!bridgePort) {
    return {
      bridgeConnected: false,
      lastStatus
    };
  }

  const status = await sendBridgeRequest("bridge:get-status");
  lastStatus = status || lastStatus;

  return {
    bridgeConnected: true,
    lastStatus
  };
}

function sendBridgeRequest(type, payload = {}) {
  if (!bridgePort) {
    return Promise.reject(new Error("桥接页尚未连接，请先在插件管理页授权本地程序"));
  }

  const id = ++requestId;
  bridgePort.postMessage({
    type,
    requestId: id,
    ...payload
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("桥接页响应超时"));
    }, REQUEST_TIMEOUT);

    pending.set(id, { resolve, reject, timer });
  });
}
