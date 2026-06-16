const CURRENT_SONG_KEY = "current_song";
const CHECK_INTERVAL = 1000;
const HEARTBEAT_INTERVAL = 5000;

let lastRaw = "";
let lastHeartbeatAt = 0;

checkCurrentSong();
setInterval(checkCurrentSong, CHECK_INTERVAL);

window.addEventListener("storage", (event) => {
  if (event.key === CURRENT_SONG_KEY) {
    checkCurrentSong(true);
  }
});

function checkCurrentSong(force = false) {
  const raw = localStorage.getItem(CURRENT_SONG_KEY) || "";
  const now = Date.now();
  const heartbeat = now - lastHeartbeatAt >= HEARTBEAT_INTERVAL;

  if (!force && raw === lastRaw && !heartbeat) return;

  lastRaw = raw;
  lastHeartbeatAt = now;
  sendSong(raw);
}

function sendSong(raw) {
  let song = null;

  try {
    song = raw ? JSON.parse(raw) : null;
  } catch {
    song = null;
  }

  chrome.runtime.sendMessage({
    type: "cover-carousel:song-changed",
    song
  }).catch(() => {});
}
