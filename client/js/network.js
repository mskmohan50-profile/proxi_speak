class NetworkClient {
  constructor(handlers = {}) {
    this.ws = null;
    this.handlers = handlers;
    this.isConnected = false;
    this.selfId = null;
    this.pingMs = 0;
    this.pingInterval = null;
    this.lastPingSent = 0;
    this.lastMoveSent = 0;
    this.moveThrottleMs = 40;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.audioChunksSent = 0;
    this.audioChunksReceived = 0;
    this.pendingMove = null;
    this.moveTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    const rawSend = this.ws.send.bind(this.ws);

    this.ws.send = (data) => {
      this.bytesSent += typeof data === 'string'
        ? data.length
        : (data.byteLength || 0);
      rawSend(data);
    };

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log('[Network] Connected to ProxiSpeak signaling server');

      if (this.handlers.onConnected) {
        this.handlers.onConnected();
      }

      this.startPing();
    };

    this.ws.onclose = () => {
      this.isConnected = false;

      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      console.warn('[Network] Disconnected from server. Reconnecting in 2s...');

      if (this.handlers.onDisconnected) {
        this.handlers.onDisconnected();
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }

      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('[Network] Socket error:', err);
    };

    this.ws.onmessage = (event) => {
      try {
        this.bytesReceived += typeof event.data === 'string'
          ? event.data.length
          : (event.data.byteLength || 0);

        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'WELCOME':
            this.selfId = msg.selfId;
            if (this.handlers.onWelcome) {
              this.handlers.onWelcome(msg);
            }
            break;

          case 'AUDIBLE_UPDATE':
            if (this.handlers.onAudibleUpdate) {
              this.handlers.onAudibleUpdate(msg);
            }
            break;

          case 'PEER_MOVED':
            if (this.handlers.onPeerMoved) {
              this.handlers.onPeerMoved(msg);
            }
            break;

          case 'PEER_JOINED':
            if (this.handlers.onPeerJoined) {
              this.handlers.onPeerJoined(msg.peer);
            }
            break;

          case 'PEER_LEFT':
            if (this.handlers.onPeerLeft) {
              this.handlers.onPeerLeft(msg.peerId);
            }
            break;

          case 'BOT_POSITIONS_UPDATE':
            if (this.handlers.onBotsUpdate) {
              this.handlers.onBotsUpdate(msg.bots);
            }
            break;

          case 'BEACON_PULSE':
            if (this.handlers.onBeaconPulse) {
              this.handlers.onBeaconPulse(msg.beacon);
            }
            break;

          case 'PEER_SPEAKING_UPDATE':
            if (this.handlers.onPeerSpeakingUpdate) {
              this.handlers.onPeerSpeakingUpdate(msg);
            }
            break;

          case 'PEER_AUDIO_STREAM':
            this.audioChunksReceived++;
            if (this.handlers.onAudioStream) {
              this.handlers.onAudioStream(msg);
            }
            break;

          case 'CHAT_MESSAGE':
            if (this.handlers.onChat) {
              this.handlers.onChat(msg);
            }
            break;

          case 'PEER_PROFILE':
            if (this.handlers.onPeerProfile) {
              this.handlers.onPeerProfile(msg);
            }
            break;

          case 'ZONE_ADDED':
            if (this.handlers.onZoneAdded) {
              this.handlers.onZoneAdded(msg.zone);
            }
            break;

          case 'PONG':
            this.pingMs = Math.max(1, Date.now() - this.lastPingSent);
            if (this.handlers.onPing) {
              this.handlers.onPing(this.pingMs);
            }
            break;
        }
      } catch (err) {
        console.error('[Network] Error parsing message:', err);
      }
    };
  }

  startPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (
        this.isConnected &&
        this.ws &&
        this.ws.readyState === WebSocket.OPEN
      ) {
        this.lastPingSent = Date.now();
        this.ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, 3000);
  }

  sendJoin(userData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'JOIN',
        ...userData
      }));
    }
  }

  sendMove(x, y, z, heading, audioRange) {
    this.pendingMove = { x, y, z, heading, audioRange };

    const now = Date.now();
    const wait = this.moveThrottleMs - (now - this.lastMoveSent);

    if (wait <= 0) {
      this.flushMove();
    } else if (!this.moveTimer) {
      this.moveTimer = setTimeout(() => this.flushMove(), wait);
    }
  }

  flushMove() {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }

    if (!this.pendingMove) return;

    const m = this.pendingMove;
    this.pendingMove = null;
    this.lastMoveSent = Date.now();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'MOVE',
        ...m
      }));
    }
  }

  sendAudio(audioChunk, sampleRate) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.audioChunksSent++;

      this.ws.send(JSON.stringify({
        type: 'AUDIO_DATA_PACKET',
        audioChunk,
        sampleRate
      }));
    }
  }

  sendChat(text, global = false) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'CHAT',
        text,
        global
      }));
    }
  }

  sendProfile(username, avatarColor) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'PROFILE',
        username,
        avatarColor
      }));
    }
  }

  sendSpeakState(isSpeaking, isMuted, isDeafened) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'SPEAK_STATE',
        isSpeaking,
        isMuted,
        isDeafened
      }));
    }
  }
}

window.NetworkClient = NetworkClient;