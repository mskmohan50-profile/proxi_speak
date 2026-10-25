document.addEventListener('DOMContentLoaded', () => {
  const radarCanvas = document.getElementById('radarCanvas');
  const spectrumCanvas = document.getElementById('spectrumCanvas');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');
  const pingValue = document.getElementById('pingValue');
  const activePeersCount = document.getElementById('activePeersCount');
  const cullingSavingsVal = document.getElementById('cullingSavings');

  const hudCoords = document.getElementById('hudCoords');
  const hudHeading = document.getElementById('hudHeading');
  const hudZone = document.getElementById('hudZone');
  const hudAudibleCount = document.getElementById('hudAudibleCount');

  const btnMic = document.getElementById('btnMic');
  const btnMute = document.getElementById('btnMute');
  const btnDeafen = document.getElementById('btnDeafen');
  const btnTestTone = document.getElementById('btnTestTone');
  const btnToggleBots = document.getElementById('btnToggleBots');
  const rangeSlider = document.getElementById('rangeSlider');
  const rangeValue = document.getElementById('rangeValue');
  const modelSelect = document.getElementById('modelSelect');
  const rolloffSlider = document.getElementById('rolloffSlider');
  const rolloffValue = document.getElementById('rolloffValue');
  const peersContainer = document.getElementById('peersContainer');

  const voiceStatus = document.getElementById('voiceStatus');
  const usageEls = {
    session: document.getElementById('usageSession'),
    up: document.getElementById('usageUp'),
    down: document.getElementById('usageDown'),
    streamsIn: document.getElementById('usageStreamsIn'),
    pktsOut: document.getElementById('usagePktsOut'),
    total: document.getElementById('usageTotal'),
    humans: document.getElementById('usageHumans'),
    graph: document.getElementById('usageGraph')
  };
  const chatLog = document.getElementById('chatLog');
  const chatInput = document.getElementById('chatInput');
  const chatGlobal = document.getElementById('chatGlobal');
  const btnChatSend = document.getElementById('btnChatSend');
  const profileName = document.getElementById('profileName');
  const profileColor = document.getElementById('profileColor');
  const btnProfileSave = document.getElementById('btnProfileSave');
  const helpModal = document.getElementById('helpModal');

  const metricZoneType = document.getElementById('metricZoneType');
  const metricReverb = document.getElementById('metricReverb');
  const metricCutoff = document.getElementById('metricCutoff');

  const audioEngine = new window.AudioEngine();
  let spatialMap = null;
  let network = null;

  const localUser = {
    id: `usr-${Math.floor(1000 + Math.random() * 9000)}`,
    username: `Agent_${Math.floor(100 + Math.random() * 900)}`,
    avatarColor: '#06b6d4',
    x: 0,
    y: 0,
    z: 0,
    heading: 90, 
    audioRange: 35,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false
  };

  try {
    const saved = JSON.parse(localStorage.getItem('proxispeak.profile') || 'null');
    if (saved && typeof saved.username === 'string' && saved.username.trim()) localUser.username = saved.username.slice(0, 24);
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved.avatarColor || '')) localUser.avatarColor = saved.avatarColor;
  } catch (e) { /* ignore */ }
  profileName.value = localUser.username;
  profileColor.value = localUser.avatarColor;

  const sessionStart = Date.now();
  let audibleHumans = 0;      // humans currently in earshot (voice is only uploaded when > 0)
  let humansOnline = 1;
  const voiceSendTimes = [];  // timestamps of recent voice uploads
  const streamSenders = new Map(); // senderId -> last time a voice block arrived
  const usageHistory = [];    // [down kbps, up kbps] samples for the graph
  let lastUsageSample = { t: performance.now(), sent: 0, recv: 0, chunksOut: 0 };

  // Keyboard Movement State (frame-rate independent: units are per second)
  const keysPressed = {};
  const moveSpeed = 15; // meters per second
  const turnSpeed = 180; // degrees per second
  let lastFrameTime = performance.now();

  // Speaking state: push-to-talk and voice-activity detection are tracked separately
  let pttHeld = false;
  let vadActive = false;

  const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  }

  // Browsers keep the AudioContext suspended until a user gesture; unlock it on the first one
  async function unlockAudio() {
    await audioEngine.init();
    await audioEngine.resume();
    audioEngine.updateListener(localUser.x, localUser.y, localUser.z, localUser.heading);
  }
  ['pointerdown', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, () => { unlockAudio(); }, { once: true });
  });

  // Recompute the effective speaking flag and tell the server only when it changes
  function updateSpeaking() {
    const speaking = (pttHeld || vadActive) && !localUser.isMuted;
    if (speaking !== localUser.isSpeaking) {
      localUser.isSpeaking = speaking;
      network.sendSpeakState(speaking, localUser.isMuted, localUser.isDeafened);
    }
  }

  // Initialize Canvas Map
  spatialMap = new window.SpatialMap(radarCanvas, (worldX, worldY, newHeading) => {
    // Click navigation handler
    localUser.x = Number(worldX.toFixed(2));
    localUser.y = Number(worldY.toFixed(2));
    localUser.heading = Number(newHeading.toFixed(1));
    onLocalStateChanged();
  });

  spatialMap.setSelf(localUser);
  window.spatialMapInstance = spatialMap; // used by the +/- zoom buttons in index.html

  // Stream mic blocks to the server only while speaking and someone human can actually hear us
  audioEngine.onMicChunk = (b64, rate) => {
    if (!localUser.isSpeaking || localUser.isMuted || audibleHumans === 0) return;
    network.sendAudio(b64, rate);
    voiceSendTimes.push(performance.now());
  };

  // Initialize Network Signaling
  network = new window.NetworkClient({
    onConnected: () => {
      connectionDot.classList.add('connected');
      if (connectionText) connectionText.textContent = 'Signaling: Live';
      network.sendJoin({ ...localUser, peerId: localUser.id });
    },
    onDisconnected: () => {
      connectionDot.classList.remove('connected');
      if (connectionText) connectionText.textContent = 'Signaling: Reconnecting...';
    },
    onWelcome: (msg) => {
      localUser.id = msg.selfId;
      spatialMap.setSelf(localUser);
      spatialMap.setZones(msg.zones);
      spatialMap.updatePeers(msg.allPeers);
      humansOnline = msg.allPeers.filter((p) => !p.isBot).length;
      if (msg.cullingStats) {
        cullingSavingsVal.textContent = `${msg.cullingStats.cullingRatioPercent}%`;
      }
      loadBeacons();
    },
    onAudibleUpdate: (msg) => {
      // Update local acoustic profile
      if (msg.currentZone) {
        hudZone.textContent = msg.currentZone.name;
        metricZoneType.textContent = msg.currentZone.type.toUpperCase();
        metricReverb.textContent = `${((msg.currentZone.reverb_level || 0) * 100).toFixed(0)}%`;
        metricCutoff.textContent = `${Number(msg.currentZone.cutoff_freq || 20000).toLocaleString()} Hz`;
        audioEngine.setAcousticEnvironment(msg.currentZone);
      } else {
        hudZone.textContent = 'Open Space (Free Air)';
        metricZoneType.textContent = 'FREE-FIELD';
        metricReverb.textContent = '0%';
        metricCutoff.textContent = '20,000 Hz';
        audioEngine.setAcousticEnvironment(null);
      }

      hudAudibleCount.textContent = msg.audiblePeers ? msg.audiblePeers.length : 0;
      audibleHumans = (msg.audiblePeers || []).filter((item) => !item.peer.isBot).length;
      if (msg.cullingStats) {
        cullingSavingsVal.textContent = `${msg.cullingStats.cullingRatioPercent}%`;
      }

      // Update audible peer audio nodes
      updateAudiblePeersList(msg.audiblePeers || []);
    },
    onPeerMoved: (msg) => {
      const p = spatialMap.peers.get(msg.peerId);
      if (p) {
        p.x = msg.x;
        p.y = msg.y;
        p.heading = msg.heading;
      }
    },
    onPeerSpeakingUpdate: (msg) => {
      const p = spatialMap.peers.get(msg.peerId);
      if (p) {
        p.isSpeaking = msg.isSpeaking;
        p.isMuted = msg.isMuted;
      }
    },
    onZoneAdded: (zone) => {
      if (!spatialMap.zones.some((z) => z.id === zone.id)) {
        spatialMap.setZones([...spatialMap.zones, zone]);
      }
    },
    onPeerJoined: (peer) => {
      spatialMap.peers.set(peer.id, peer);
      activePeersCount.textContent = spatialMap.peers.size + 1;
      if (!peer.isBot) {
        humansOnline++;
        addChatLine({ system: true, text: `${peer.username} joined` });
      }
    },
    onPeerProfile: (msg) => {
      const p = spatialMap.peers.get(msg.peerId);
      if (p) {
        p.username = msg.username;
        p.avatarColor = msg.avatarColor;
      }
    },
    onAudioStream: (msg) => {
      streamSenders.set(msg.senderId, performance.now());
      const p = spatialMap.peers.get(msg.senderId);
      if (p) audioEngine.playVoiceChunk(msg.senderId, msg.audioChunk, msg.sampleRate, p, msg.acousticFilter);
    },
    onChat: (msg) => {
      addChatLine(msg);
      spatialMap.addBubble(msg.senderId, msg.text);
    },
    onPeerLeft: (peerId) => {
      const leaving = spatialMap.peers.get(peerId);
      if (leaving && !leaving.isBot) {
        humansOnline = Math.max(1, humansOnline - 1);
        addChatLine({ system: true, text: `${leaving.username} left` });
      }
      streamSenders.delete(peerId);
      audioEngine.setPeerLocallyMuted(peerId, false);
      spatialMap.peers.delete(peerId);
      audioEngine.removePeerChannel(peerId);
      activePeersCount.textContent = spatialMap.peers.size + 1;
    },
    onBotsUpdate: (bots) => {
      for (const b of bots) {
        spatialMap.peers.set(b.id, b);
        // If audible, keep the 3D audio panner in sync with the bot's live position
        if (spatialMap.audiblePeerIds.has(b.id)) {
          audioEngine.getOrCreatePeerChannel(b.id, true, {
            audioFrequency: b.audioFrequency,
            soundPattern: b.soundPattern
          });
          audioEngine.updatePeerSpatialState(b.id, b);
        }
      }
      activePeersCount.textContent = spatialMap.peers.size + 1;
    },
    onBeaconPulse: (beacon) => {
      const dist = Math.hypot(beacon.x - localUser.x, beacon.y - localUser.y);
      if (dist <= beacon.radius) {
        audioEngine.playBeaconChime(beacon);
      }
    },
    onPing: (ms) => {
      pingValue.textContent = `${ms}ms`;
    }
  });

  network.connect();

  async function loadBeacons() {
    try {
      const res = await fetch('/api/beacons');
      const beacons = await res.json();
      spatialMap.setBeacons(beacons);
    } catch (e) {
      console.warn('Could not fetch beacons:', e);
    }
  }

  // Update audible peers UI list and 3D audio graph
  function updateAudiblePeersList(audible) {
    spatialMap.updatePeers(Array.from(spatialMap.peers.values()), audible);
    audioEngine.syncAudiblePeers(new Set(audible.map((item) => item.peer.id)));

    if (audible.length === 0) {
      peersContainer.innerHTML = '<div class="empty-state">No peers in audible range.<br>Approach agents or bots to listen.</div>';
      return;
    }

    let html = '';
    for (const item of audible) {
      const p = item.peer;
      const dist = item.distance.toFixed(1);
      const gainPercent = Math.min(100, Math.round(item.netGain * 100));

      // Ensure 3D audio channel exists
      audioEngine.getOrCreatePeerChannel(p.id, p.isBot, {
        audioFrequency: p.audioFrequency,
        soundPattern: p.soundPattern
      });
      audioEngine.updatePeerSpatialState(p.id, p, item.acousticFilter);

      const locallyMuted = audioEngine.locallyMuted.has(p.id);
      const liveTag = audioEngine.isReceivingVoice(p.id) ? '<span class="live-tag">LIVE</span>' : '';
      html += `
        <div class="peer-card ${p.isSpeaking || p.isBot ? 'speaking' : ''}">
          <div class="peer-info">
            <span class="peer-dot" style="background: ${p.avatarColor || '#ec4899'}"></span>
            <div>
              <div class="peer-name">${escapeHtml(p.username)} ${p.isBot ? '🤖' : ''}${liveTag}</div>
              <div style="font-size: 0.7rem; color: #9ca3af;">${dist}m · ${item.acousticFilter ? escapeHtml(item.acousticFilter.speakerZone || 'Normal') : 'Normal'}</div>
            </div>
          </div>
          <div class="peer-actions">
            <div class="peer-audio-bars">
              <span style="font-size: 0.75rem; font-family: monospace;">${gainPercent}%</span>
              <div class="gain-progress-bar">
                <div class="gain-fill" style="width: ${gainPercent}%"></div>
              </div>
            </div>
            <button class="peer-mute ${locallyMuted ? 'on' : ''}" data-peer-id="${escapeHtml(p.id)}" title="${locallyMuted ? 'Unmute for me' : 'Mute for me'}">${locallyMuted ? '🔇' : '🔊'}</button>
          </div>
        </div>
      `;
    }
    peersContainer.innerHTML = html;
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    keysPressed[e.code] = true;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!pttHeld) {
        pttHeld = true;
        updateSpeaking();
      }
    }

    if (e.code === 'Enter' && !e.repeat) {
      e.preventDefault();
      chatInput.focus();
      return;
    }

    if (!e.repeat) {
      if (e.code === 'KeyM') btnMute.click();
      if (e.code === 'KeyF') btnDeafen.click();
    }
  });

  window.addEventListener('keyup', (e) => {
    keysPressed[e.code] = false;

    if (e.code === 'Space') {
      pttHeld = false;
      updateSpeaking();
    }
  });

  window.addEventListener('blur', () => {
    for (const k of Object.keys(keysPressed)) keysPressed[k] = false;
    pttHeld = false;
    updateSpeaking();
  });

  function processMovement(dt) {
    let moved = false;
    const rad = (localUser.heading * Math.PI) / 180;

    if (keysPressed['KeyW'] || keysPressed['ArrowUp']) {
      localUser.x += Math.cos(rad) * moveSpeed * dt;
      localUser.y += Math.sin(rad) * moveSpeed * dt;
      moved = true;
    }

    if (keysPressed['KeyS'] || keysPressed['ArrowDown']) {
      localUser.x -= Math.cos(rad) * moveSpeed * dt;
      localUser.y -= Math.sin(rad) * moveSpeed * dt;
      moved = true;
    }
    if (keysPressed['KeyA'] || keysPressed['ArrowLeft']) {
      localUser.heading = (localUser.heading + turnSpeed * dt) % 360;
      moved = true;
    }
    if (keysPressed['KeyD'] || keysPressed['ArrowRight']) {
      localUser.heading = (localUser.heading - turnSpeed * dt + 360) % 360;
      moved = true;
    }

    if (moved) {
      localUser.x = Number(localUser.x.toFixed(2));
      localUser.y = Number(localUser.y.toFixed(2));
      localUser.heading = Number(localUser.heading.toFixed(1));
      onLocalStateChanged();
    }
  }

  function onLocalStateChanged() {
    spatialMap.setSelf(localUser);
    audioEngine.updateListener(localUser.x, localUser.y, localUser.z, localUser.heading);
    network.sendMove(localUser.x, localUser.y, localUser.z, localUser.heading, localUser.audioRange);

    // Update HUD
    hudCoords.textContent = `${localUser.x}m, ${localUser.y}m`;
    hudHeading.textContent = `${Number(localUser.heading).toFixed(1)}°`;
  }

  // UI Event Handlers
  btnMic.addEventListener('click', async () => {
    const success = await audioEngine.setupMicrophone();
    if (success) {
      btnMic.classList.add('active-mic');
      btnMic.innerHTML = '🎤 Mic Active';
    }
  });

  btnMute.addEventListener('click', () => {
    const muted = audioEngine.toggleMute();
    localUser.isMuted = muted;
    btnMute.classList.toggle('muted', muted);
    btnMute.innerHTML = muted ? '🔇 Muted' : '🎙️ Mute';
    if (muted) vadActive = false;
    updateSpeaking();
    network.sendSpeakState(localUser.isSpeaking, localUser.isMuted, localUser.isDeafened);
  });

  btnDeafen.addEventListener('click', () => {
    const deafened = audioEngine.toggleDeafen();
    localUser.isDeafened = deafened;
    btnDeafen.classList.toggle('muted', deafened);
    btnDeafen.innerHTML = deafened ? '🔇 Deafened' : '🎧 Deafen';
    network.sendSpeakState(localUser.isSpeaking, localUser.isMuted, localUser.isDeafened);
  });

  btnTestTone.addEventListener('click', async () => {
    await audioEngine.init();
    await audioEngine.resume();
    // Emit a test ping directly at current position
    audioEngine.playBeaconChime({
      id: 'test-ping',
      x: localUser.x + 4,
      y: localUser.y + 4,
      radius: 30,
      frequency: 587.33
    });
  });

  let botsActive = true;
  btnToggleBots.addEventListener('click', async () => {
    botsActive = !botsActive;
    btnToggleBots.textContent = botsActive ? 'Pause Bots' : 'Resume Bots';
    btnToggleBots.classList.toggle('btn-primary', botsActive);
    await fetch('/api/bots/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: botsActive })
    });
  });

  rangeSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    localUser.audioRange = val;
    rangeValue.textContent = `${val}m`;
    audioEngine.setMaxDistance(Math.max(45, val));
    onLocalStateChanged();
  });

  modelSelect.addEventListener('change', (e) => {
    audioEngine.setDistanceModel(e.target.value);
  });

  rolloffSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    rolloffValue.textContent = val.toFixed(1);
    audioEngine.setRolloffFactor(val);
  });

  // ---- Proximity chat ----
  function addChatLine(msg) {
    const empty = chatLog.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'chat-msg' + (msg.system ? ' system' : '');
    if (msg.system) {
      row.textContent = msg.text;
    } else {
      const who = document.createElement('span');
      who.className = 'who';
      who.style.color = msg.avatarColor || '#06b6d4';
      who.textContent = (msg.senderId === localUser.id ? 'You' : msg.username) + ': ';
      const body = document.createElement('span');
      body.textContent = msg.text; // textContent keeps chat text from ever being parsed as HTML
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = msg.scope === 'global' ? 'all' : 'nearby';
      row.append(who, body, tag);
    }
    chatLog.appendChild(row);
    while (chatLog.children.length > 100) chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    network.sendChat(text, chatGlobal.checked);
    chatInput.value = '';
  }
  btnChatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape') chatInput.blur();
  });

  // ---- Per-listener mute of a single peer (delegated so list re-renders don't lose clicks) ----
  peersContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.peer-mute');
    if (!btn) return;
    const id = btn.dataset.peerId;
    audioEngine.setPeerLocallyMuted(id, !audioEngine.locallyMuted.has(id));
  });

  // ---- Profile ----
  function saveProfile() {
    const name = profileName.value.trim().slice(0, 24) || localUser.username;
    localUser.username = name;
    localUser.avatarColor = profileColor.value;
    profileName.value = name;
    spatialMap.setSelf(localUser);
    network.sendProfile(localUser.username, localUser.avatarColor);
    try {
      localStorage.setItem('proxispeak.profile', JSON.stringify({ username: name, avatarColor: localUser.avatarColor }));
    } catch (e) { /* storage unavailable */ }
  }
  btnProfileSave.addEventListener('click', saveProfile);
  profileName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } });

  // ---- Help modal ----
  document.getElementById('btnHelp').addEventListener('click', () => helpModal.classList.remove('hidden'));
  document.getElementById('btnHelpClose').addEventListener('click', () => helpModal.classList.add('hidden'));
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });

  // ---- Real-time usage panel (refreshed once per second) ----
  const fmtBytes = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

  function drawUsageGraph() {
    const c = usageEls.graph;
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    g.fillStyle = '#030712';
    g.fillRect(0, 0, w, h);
    const max = Math.max(32, ...usageHistory.map((s) => Math.max(s[0], s[1])));
    const draw = (idx, color) => {
      g.beginPath();
      usageHistory.forEach((s, i) => {
        const x = (i / 59) * w;
        const y = h - (s[idx] / max) * (h - 4) - 2;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.stroke();
    };
    draw(0, '#06b6d4'); // download
    draw(1, '#f59e0b'); // upload
  }

  setInterval(() => {
    const now = performance.now();
    const dtSec = Math.max(0.001, (now - lastUsageSample.t) / 1000);
    const downKbps = ((network.bytesReceived - lastUsageSample.recv) * 8) / 1000 / dtSec;
    const upKbps = ((network.bytesSent - lastUsageSample.sent) * 8) / 1000 / dtSec;
    const chunksOut = (network.audioChunksSent - lastUsageSample.chunksOut) / dtSec;
    lastUsageSample = { t: now, sent: network.bytesSent, recv: network.bytesReceived, chunksOut: network.audioChunksSent };

    usageHistory.push([downKbps, upKbps]);
    if (usageHistory.length > 60) usageHistory.shift();

    let streamsIn = 0;
    for (const [id, t] of streamSenders) {
      if (now - t < 1000) streamsIn++; else streamSenders.delete(id);
    }

    const secs = Math.floor((Date.now() - sessionStart) / 1000);
    usageEls.session.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    usageEls.up.textContent = `${upKbps.toFixed(0)} kbps`;
    usageEls.down.textContent = `${downKbps.toFixed(0)} kbps`;
    usageEls.streamsIn.textContent = streamsIn;
    usageEls.pktsOut.textContent = `${chunksOut.toFixed(0)}/s`;
    usageEls.total.textContent = fmtBytes(network.bytesSent + network.bytesReceived);
    usageEls.humans.textContent = humansOnline;
    drawUsageGraph();

    // Voice status line
    let state = 'idle';
    let text = 'Mic off · enable it to talk to people nearby';
    if (audioEngine.micAnalyser) {
      if (localUser.isMuted) { state = 'muted'; text = 'Muted · nobody can hear you'; }
      else if (localUser.isSpeaking && audibleHumans > 0) { state = 'live'; text = `Transmitting to ${audibleHumans} nearby ${audibleHumans === 1 ? 'person' : 'people'}`; }
      else if (localUser.isSpeaking) { state = 'live'; text = 'Speaking · nobody in range yet'; }
      else if (streamsIn > 0) { state = 'rx'; text = `Receiving ${streamsIn} voice ${streamsIn === 1 ? 'stream' : 'streams'}`; }
      else { state = 'idle'; text = 'Mic ready · speak or hold Space'; }
    } else if (streamsIn > 0) {
      state = 'rx'; text = `Receiving ${streamsIn} voice ${streamsIn === 1 ? 'stream' : 'streams'}`;
    }
    voiceStatus.className = `voice-status ${state}`;
    voiceStatus.textContent = text;
  }, 1000);

  // Microphone FFT Visualizer Drawing Loop
  const specCtx = spectrumCanvas.getContext('2d');
  function drawSpectrum() {
    const { volume, fft } = audioEngine.getMicLevel();
    spatialMap.setSelfLevel(volume);
    const w = spectrumCanvas.width;
    const h = spectrumCanvas.height;

    specCtx.fillStyle = '#030712';
    specCtx.fillRect(0, 0, w, h);

    const barWidth = (w / fft.length) * 1.5;
    let x = 0;

    for (let i = 0; i < fft.length; i++) {
      const barHeight = (fft[i] / 255) * h;
      specCtx.fillStyle = `hsl(${180 + i * 2}, 90%, 55%)`;
      specCtx.fillRect(x, h - barHeight, barWidth - 1, barHeight);
      x += barWidth;
    }

    // Voice Activity Detection (VAD) auto-speak - only while a mic is actually connected
    if (audioEngine.micAnalyser) {
      if (volume > 0.25) vadActive = true;
      else if (volume <= 0.15) vadActive = false;
      updateSpeaking();
    }
  }

  // Master Render Loop (60 FPS)
  function mainLoop(now) {
    const dt = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    processMovement(dt);
    spatialMap.render();
    drawSpectrum();
    requestAnimationFrame(mainLoop);
  }

  requestAnimationFrame((t) => { lastFrameTime = t; mainLoop(t); });
});