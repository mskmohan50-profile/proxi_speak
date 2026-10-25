const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const db = require('./db');
const SpatialEngine = require('./spatialEngine');
const ZoneManager = require('./zoneManager');
const MockBotSimulator = require('./mockBots');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve Client Web Application
app.use(express.static(path.join(__dirname, '..', 'client')));
// Serve Presentation and Documentation for easy browser access
app.use('/presentation', express.static(path.join(__dirname, '..', 'presentation')));
app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));
app.use('/evaluation', express.static(path.join(__dirname, '..', 'evaluation')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

const spatialEngine = new SpatialEngine({ cellSize: 25.0 });
const zoneManager = new ZoneManager(db);

// Map of active WebSocket clients: ws -> peerId
const clients = new Map();
// Map of peerId -> ws
const peerSockets = new Map();

// Helper to broadcast JSON to all or selected clients
function broadcast(message, excludeWs = null) {
  const payload = JSON.stringify(message);
  for (const [ws] of clients) {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Build and send the audible-neighbour telemetry for one connected peer
function sendAudibleUpdate(ws, peerId, cullingStats) {
  if (ws.readyState !== ws.OPEN) return;
  const peer = spatialEngine.getPeer(peerId);
  if (!peer) return;

  const zone = zoneManager.getZoneAt(peer.x, peer.y);
  const enrichedAudible = spatialEngine.getAudiblePeersFor(peerId).map((n) => ({
    ...n,
    acousticFilter: zoneManager.getAcousticFilterBetween(
      { x: n.peer.x, y: n.peer.y },
      { x: peer.x, y: peer.y }
    )
  }));

  ws.send(JSON.stringify({
    type: 'AUDIBLE_UPDATE',
    selfPos: { x: peer.x, y: peer.y, z: peer.z, heading: peer.heading },
    currentZone: zone,
    audiblePeers: enrichedAudible,
    cullingStats: cullingStats || spatialEngine.computeMeshCullingStats()
  }));
}

// Bot Simulator instance
const botSimulator = new MockBotSimulator(spatialEngine, (msg) => {
  broadcast(msg);
});

// REST API Endpoints
app.get('/api/status', (req, res) => {
  const cullingStats = spatialEngine.computeMeshCullingStats();
  res.json({
    status: 'online',
    system: 'ProxiSpeak Geospatial Audio Ecosystem',
    activePeers: spatialEngine.getAllPeers().length,
    activeSockets: clients.size,
    zonesCount: zoneManager.getAllZones().length,
    cullingStats,
    uptimeSec: Math.floor(process.uptime()),
    memoryUsageMB: (process.memoryUsage().rss / (1024 * 1024)).toFixed(2)
  });
});

app.get('/api/zones', (req, res) => {
  res.json(zoneManager.getAllZones());
});

app.post('/api/zones', async (req, res) => {
  try {
    const created = await zoneManager.addZone(req.body);
    broadcast({ type: 'ZONE_ADDED', zone: created });
    res.json({ success: true, zone: created });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/beacons', async (req, res) => {
  const beacons = await db.getAllBeacons();
  res.json(beacons);
});

app.get('/api/peers', (req, res) => {
  res.json(spatialEngine.getAllPeers());
});

app.post('/api/bots/toggle', (req, res) => {
  const { enabled } = req.body;
  if (enabled && !botSimulator.timer) {
    botSimulator.start();
  } else if (!enabled && botSimulator.timer) {
    botSimulator.stop();
  }
  res.json({ botsActive: !!botSimulator.timer, botCount: botSimulator.getAllBots().length });
});

// WebSocket Event Handling
wss.on('connection', (ws) => {
  let peerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'JOIN': {
          // Re-joining on the same socket: drop the previous identity first
          if (peerId && peerSockets.get(peerId) === ws) {
            spatialEngine.removePeer(peerId);
            peerSockets.delete(peerId);
          }

          let requestedId = typeof msg.peerId === 'string' ? msg.peerId.slice(0, 64) : '';
          const taken = requestedId && peerSockets.has(requestedId) && peerSockets.get(requestedId) !== ws;
          peerId = (!requestedId || taken) ? `user-${Date.now()}-${Math.floor(Math.random() * 1000)}` : requestedId;
          clients.set(ws, peerId);
          peerSockets.set(peerId, ws);

          const color = typeof msg.avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.avatarColor)
            ? msg.avatarColor : '#6366f1';

          const peer = spatialEngine.updatePeer(peerId, {
            username: String(msg.username || 'Anonymous').slice(0, 24),
            avatarColor: color,
            x: finite(msg.x),
            y: finite(msg.y),
            z: finite(msg.z),
            heading: finite(msg.heading),
            audioRange: finite(msg.audioRange, 35.0),
            isMuted: !!msg.isMuted,
            isDeafened: !!msg.isDeafened,
            isSpeaking: false
          });

          db.logEvent('USER_JOIN', peerId, { username: peer.username, pos: { x: peer.x, y: peer.y } });

          // Send back initial handshake
          ws.send(JSON.stringify({
            type: 'WELCOME',
            selfId: peerId,
            peer,
            allPeers: spatialEngine.getAllPeers(),
            zones: zoneManager.getAllZones(),
            cullingStats: spatialEngine.computeMeshCullingStats()
          }));

          // Notify other peers of new participant
          broadcast({
            type: 'PEER_JOINED',
            peer
          }, ws);

          break;
        }

        case 'MOVE': {
          if (!peerId) return;
          if (!Number.isFinite(Number(msg.x)) || !Number.isFinite(Number(msg.y))) return;

          const updatedPeer = spatialEngine.updatePeer(peerId, {
            x: Number(msg.x),
            y: Number(msg.y),
            z: finite(msg.z),
            heading: finite(msg.heading),
            audioRange: msg.audioRange ? finite(msg.audioRange, undefined) : undefined
          });

          // Send back local neighborhood telemetry to moving client
          sendAudibleUpdate(ws, peerId);

          // Broadcast lightweight position update to all other connected peers
          broadcast({
            type: 'PEER_MOVED',
            peerId,
            x: updatedPeer.x,
            y: updatedPeer.y,
            z: updatedPeer.z,
            heading: updatedPeer.heading
          }, ws);

          break;
        }

        case 'SPEAK_STATE': {
          if (!peerId) return;
          const peer = spatialEngine.updatePeer(peerId, {
            isSpeaking: !!msg.isSpeaking,
            isMuted: msg.isMuted !== undefined ? !!msg.isMuted : undefined,
            isDeafened: msg.isDeafened !== undefined ? !!msg.isDeafened : undefined
          });

          broadcast({
            type: 'PEER_SPEAKING_UPDATE',
            peerId,
            isSpeaking: peer.isSpeaking,
            isMuted: peer.isMuted,
            isDeafened: peer.isDeafened
          }, ws);
          break;
        }

        // WebRTC Signaling Passthrough (Offer, Answer, ICE Candidates)
        case 'SIGNAL_OFFER':
        case 'SIGNAL_ANSWER':
        case 'SIGNAL_ICE': {
          if (!peerId) return;
          const targetWs = peerSockets.get(msg.targetId);
          if (targetWs && targetWs.readyState === targetWs.OPEN) {
            targetWs.send(JSON.stringify({
              type: msg.type,
              senderId: peerId,
              payload: msg.payload
            }));
          }
          break;
        }

        // WebSocket Fallback Audio Streaming
        case 'AUDIO_DATA_PACKET': {
          if (!peerId) return;
          const sender = spatialEngine.getPeer(peerId);
          if (!sender || sender.isMuted) return;

          // Everyone within earshot of the sender; gains are computed from each RECEIVER's perspective
          for (const item of spatialEngine.getAudiblePeersFor(peerId)) {
            const receiver = item.peer;
            if (receiver.isDeafened || receiver.isBot) continue;
            const targetWs = peerSockets.get(receiver.id);
            if (!targetWs || targetWs.readyState !== targetWs.OPEN) continue;

            const effectiveRange = Math.max(sender.audioRange, receiver.audioRange);
            const attenuation = spatialEngine.calculateAttenuation(item.distance, 2.0, effectiveRange);
            const coneGain = spatialEngine.calculateConeGain(sender, receiver);

            targetWs.send(JSON.stringify({
              type: 'PEER_AUDIO_STREAM',
              senderId: peerId,
              netGain: attenuation * coneGain,
              relativeX: sender.x - receiver.x,
              relativeY: sender.y - receiver.y,
              relativeZ: (sender.z || 0) - (receiver.z || 0),
              acousticFilter: zoneManager.getAcousticFilterBetween(
                { x: sender.x, y: sender.y },
                { x: receiver.x, y: receiver.y }
              ),
              audioChunk: msg.audioChunk
            }));
          }
          break;
        }

        case 'PING': {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          break;
        }
      }
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Only tear the peer down if this socket still owns the id (it may have been re-claimed)
    if (peerId && peerSockets.get(peerId) === ws) {
      spatialEngine.removePeer(peerId);
      peerSockets.delete(peerId);
      db.logEvent('USER_LEAVE', peerId, {});

      broadcast({
        type: 'PEER_LEFT',
        peerId
      });
      console.log(`[WS] Peer disconnected: ${peerId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${peerId}:`, err.message);
  });
});

// Periodic Beacon Sound Pulses (e.g. clock chimes) - each beacon honours its own interval_sec
const beaconLastPulse = new Map();
setInterval(async () => {
  try {
    const beacons = await db.getAllBeacons();
    const now = Date.now();
    for (const b of beacons) {
      const everyMs = Math.max(1, Number(b.interval_sec) || 8) * 1000;
      if (now - (beaconLastPulse.get(b.id) || 0) >= everyMs) {
        beaconLastPulse.set(b.id, now);
        broadcast({ type: 'BEACON_PULSE', beacon: b });
      }
    }
  } catch (e) {
    // ignore
  }
}, 500);

// Periodically refresh every client's audible neighbourhood. Bots (and other peers) keep moving
// while a listener stands still, so audibility cannot depend on the listener's own MOVE events.
setInterval(() => {
  if (clients.size === 0) return;
  const stats = spatialEngine.computeMeshCullingStats();
  for (const [ws, id] of clients) {
    try {
      sendAudibleUpdate(ws, id, stats);
    } catch (e) {
      console.error('[WS] Audible refresh failed:', e.message);
    }
  }
}, 250);

// Heartbeat: drop dead sockets so ghost peers don't linger
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// Initialize DB and launch server
async function startServer() {
  await db.init();
  await zoneManager.init();

  // Start mock bots by default to provide an immediate interactive acoustic experience
  botSimulator.start();

  server.listen(PORT, () => {
    console.log(`
  PROXISPEAK: GEOSPATIAL PROXIMITY AUDIO ECOSYSTEM
  Server running at: http://localhost:${PORT}

    `);
  });
}

startServer().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
