const SIGNALING_BASE = 'https://mcrc.cypphi.dev/api/remoteview';
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];
const SESSION_TTL_MS = 60_000;

const els = {
  sessionId: document.getElementById('sessionId'),
  authToken: document.getElementById('authToken'),
  expiresIn: document.getElementById('expiresIn'),
  status: document.getElementById('status'),
  hint: document.getElementById('hintText'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  video: document.getElementById('remoteVideo'),
  videoOverlay: document.getElementById('videoOverlay'),
};

const state = {
  sessionId: null,
  authToken: null,
  expiresAt: null,
  countdownTimer: null,
};

class RemoteViewClient {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.peer = null;
    this.pendingCandidates = [];
  }

  async connect({ sessionId, authToken }) {
    this.disconnect();
    this.peer = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    this.peer.addEventListener('track', event => {
      if (event.streams?.length) {
        this.videoEl.srcObject = event.streams[0];
      }
    });
    this.peer.addEventListener('connectionstatechange', () => {
      console.debug('[RemoteView] connection state', this.peer.connectionState);
    });

    const offerPayload = await requestOffer(sessionId, authToken);
    if (!offerPayload?.offer) {
      throw new Error('Missing SDP offer from signaling server.');
    }

    const iceServers = normalizeIceServers(offerPayload.iceServers) || DEFAULT_ICE_SERVERS;
    this.peer.setConfiguration({ iceServers });

    await this.peer.setRemoteDescription(new RTCSessionDescription(offerPayload.offer));
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);

    await sendAnswer(sessionId, authToken, answer);
  }

  disconnect() {
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.getSenders().forEach(sender => sender.track?.stop());
      this.peer.close();
      this.peer = null;
      this.videoEl.srcObject = null;
    }
  }
}

async function requestOffer(sessionId, authToken) {
  const response = await fetch(`${SIGNALING_BASE}/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, authToken }),
  });

  if (!response.ok) {
    const message = await safeJson(response);
    throw new Error(message?.error || 'Failed to request offer');
  }

  return response.json();
}

async function sendAnswer(sessionId, authToken, answer) {
  const response = await fetch(`${SIGNALING_BASE}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, authToken, answer }),
  });

  if (!response.ok) {
    const message = await safeJson(response);
    throw new Error(message?.error || 'Failed to send answer');
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

function normalizeIceServers(servers) {
  if (!Array.isArray(servers) || !servers.length) {
    return null;
  }
  return servers.map(entry =>
    typeof entry === 'string'
      ? { urls: entry }
      : entry
  );
}

function parseInitialState() {
  const params = new URLSearchParams(window.location.search);
  state.sessionId = params.get('session')?.trim() || null;
  state.authToken = params.get('auth')?.trim() || null;

  const expiresParam = params.get('expires');
  if (expiresParam) {
    const parsed = Number(expiresParam);
    state.expiresAt = Number.isFinite(parsed) && parsed > Date.now()
      ? parsed
      : Date.now() + SESSION_TTL_MS;
  } else {
    state.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  updateUiState();
}

function updateUiState() {
  els.sessionId.textContent = state.sessionId || '—';
  els.authToken.textContent = state.authToken ? maskToken(state.authToken) : '—';

  const ready = Boolean(state.sessionId && state.authToken);
  els.connectBtn.disabled = !ready;
  els.hint.textContent = ready
    ? 'Ready to connect. Links expire automatically after one minute.'
    : 'Paste a valid Remote View link (with session + auth) to begin.';

  updateCountdown();
}

function maskToken(token) {
  if (token.length <= 6) return token;
  return `${token.slice(0, 3)}•••${token.slice(-3)}`;
}

function updateCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
  }

  const update = () => {
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    els.expiresIn.textContent = `${seconds}s`;
    if (remaining <= 0) {
      els.connectBtn.disabled = true;
      els.status.textContent = 'Link expired – request a fresh /remoteview link.';
      clearInterval(state.countdownTimer);
    }
  };

  update();
  state.countdownTimer = setInterval(update, 1000);
}

const client = new RemoteViewClient(els.video);

els.connectBtn.addEventListener('click', async () => {
  if (!state.sessionId || !state.authToken) {
    return;
  }

  setStatus('Requesting offer…');
  els.connectBtn.disabled = true;
  els.disconnectBtn.disabled = false;
  els.videoOverlay.textContent = 'Connecting…';
  try {
    await client.connect({ sessionId: state.sessionId, authToken: state.authToken });
    setStatus('Connected');
    els.videoOverlay.textContent = '';
    els.videoOverlay.style.display = 'none';
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Failed to connect');
    els.connectBtn.disabled = false;
    els.disconnectBtn.disabled = true;
    els.videoOverlay.style.display = 'flex';
    els.videoOverlay.textContent = 'Failed – check console';
  }
});

els.disconnectBtn.addEventListener('click', () => {
  client.disconnect();
  setStatus('Disconnected');
  els.disconnectBtn.disabled = true;
  els.connectBtn.disabled = state.expiresAt <= Date.now();
  els.videoOverlay.style.display = 'flex';
  els.videoOverlay.textContent = 'Waiting for stream…';
});

function setStatus(text) {
  els.status.textContent = text;
}

parseInitialState();
