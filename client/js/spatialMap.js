/**
 * ProxiSpeak Interactive Geospatial Radar & Canvas Map
 * Renders acoustic zones, peer avatars, directional hearing cones,
 * audio radiation ripples, and handles click/drag coordinate navigation.
 */

class SpatialMap {
  constructor(canvasElement, onUserNavigate) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.onUserNavigate = onUserNavigate; // callback(x, y, heading)

    // Camera view & scale (pixels per meter)
    this.scale = 6.0; // 1 meter = 6 pixels
    this.cameraOffset = { x: 0, y: 0 };
    this.targetPos = null;

    // Local user representation
    this.selfUser = {
      x: 0,
      y: 0,
      heading: 0, // degrees
      audioRange: 35,
      username: 'You',
      avatarColor: '#06b6d4'
    };

    // World Entities
    this.peers = new Map(); // id -> peer
    this.zones = [];
    this.beacons = [];
    this.audiblePeerIds = new Set();

    // v1.1 live visuals
    this.bubbles = new Map();      // peerId -> { text, expires }  (proximity chat bubbles)
    this.clickMarker = null;       // { x, y, expires } last navigation target
    this.selfLevel = 0;            // live mic level [0,1] drives the self voice ring
    this.showMinimap = true;
    this.minimapSize = 130;
    this.minimapRange = 120;       // metres shown from centre to edge

    // Visual animation ticks
    this.rippleAnimTick = 0;

    this.initEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  initEvents() {
    let isDragging = false;

    this.canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      this.handlePointerAction(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) {
        this.handlePointerAction(e);
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Zoom on wheel
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      this.scale = Math.max(2.5, Math.min(15.0, this.scale * zoomFactor));
    });
  }

  handlePointerAction(e) {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // Convert screen coordinates to world coordinates (meters)
    const worldX = (screenX - this.canvas.width / 2) / this.scale + this.cameraOffset.x;
    const worldY = -((screenY - this.canvas.height / 2) / this.scale - this.cameraOffset.y);

    // Calculate heading towards target point
    const dx = worldX - this.selfUser.x;
    const dy = worldY - this.selfUser.y;
    let heading = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (heading < 0) heading += 360;

    this.clickMarker = { x: worldX, y: worldY, expires: performance.now() + 900 };

    if (this.onUserNavigate) {
      this.onUserNavigate(worldX, worldY, heading);
    }
  }

  setSelf(user) {
    this.selfUser = { ...this.selfUser, ...user };
    // Smooth camera tracking
    this.cameraOffset.x = this.selfUser.x;
    this.cameraOffset.y = this.selfUser.y;
  }

  updatePeers(peersList, audibleList = []) {
    this.peers.clear();
    for (const p of peersList) {
      if (p.id !== this.selfUser.id) {
        this.peers.set(p.id, p);
      }
    }

    this.audiblePeerIds.clear();
    for (const item of audibleList) {
      this.audiblePeerIds.add(item.peer.id);
    }
  }

  setZones(zones) {
    this.zones = zones || [];
  }

  setBeacons(beacons) {
    this.beacons = beacons || [];
  }

  /** Show a short-lived chat bubble above a peer (or yourself). */
  addBubble(peerId, text, ms = 6000) {
    const clean = String(text).length > 60 ? `${String(text).slice(0, 57)}...` : String(text);
    this.bubbles.set(peerId, { text: clean, expires: performance.now() + ms });
  }

  setSelfLevel(level) {
    this.selfLevel = Math.max(0, Math.min(1, level || 0));
  }

  drawBubble(ctx, x, y, text, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '11px sans-serif';
    const padX = 8;
    const w = Math.min(190, ctx.measureText(text).width + padX * 2);
    const h = 20;
    const bx = x - w / 2;
    const by = y - h;

    ctx.fillStyle = 'rgba(17, 24, 39, 0.95)';
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 6); else ctx.rect(bx, by, w, h);
    ctx.fill();
    ctx.stroke();

    // tail
    ctx.beginPath();
    ctx.moveTo(x - 4, by + h);
    ctx.lineTo(x, by + h + 5);
    ctx.lineTo(x + 4, by + h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#f3f4f6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, by + h / 2, w - padX);
    ctx.restore();
  }

  // Convert world meters to screen pixels
  worldToScreen(wx, wy) {
    const sx = this.canvas.width / 2 + (wx - this.cameraOffset.x) * this.scale;
    const sy = this.canvas.height / 2 - (wy - this.cameraOffset.y) * this.scale;
    return { x: sx, y: sy };
  }

  render() {
    this.rippleAnimTick += 0.05;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Clear background
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, w, h);

    // 1. Draw Grid lines
    this.drawGrid(ctx, w, h);

    // 2. Draw Acoustic Zones
    this.drawZones(ctx);

    // 3. Draw Beacons
    this.drawBeacons(ctx);

    // 4. Draw Self Hearing Radius & Directional Cone
    this.drawSelfHearingCone(ctx);

    // 5. Draw Peers & Bots
    this.drawPeers(ctx);

    // 6. Draw Self Avatar
    this.drawSelfAvatar(ctx);

    // 7. Chat bubbles, navigation marker and minimap overlays
    this.drawBubbles(ctx);
    this.drawClickMarker(ctx);
    if (this.showMinimap) this.drawMinimap(ctx, w, h);
  }

  drawBubbles(ctx) {
    const now = performance.now();
    for (const [id, b] of Array.from(this.bubbles.entries())) {
      if (b.expires <= now) { this.bubbles.delete(id); continue; }
      const who = id === this.selfUser.id ? this.selfUser : this.peers.get(id);
      if (!who) continue;
      const pos = this.worldToScreen(who.x, who.y);
      const alpha = Math.min(1, (b.expires - now) / 600); // fade out over the last 0.6 s
      this.drawBubble(ctx, pos.x, pos.y - 34, b.text, alpha);
    }
  }

  drawClickMarker(ctx) {
    if (!this.clickMarker) return;
    const left = this.clickMarker.expires - performance.now();
    if (left <= 0) { this.clickMarker = null; return; }
    const t = 1 - left / 900;
    const pos = this.worldToScreen(this.clickMarker.x, this.clickMarker.y);
    ctx.save();
    ctx.strokeStyle = `rgba(6, 182, 212, ${1 - t})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 4 + t * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Overview of the area around you: zones, beacons, bots, people and your hearing range. */
  drawMinimap(ctx, w, h) {
    const size = this.minimapSize;
    const x0 = 12;
    const y0 = h - size - 12;
    const k = (size / 2) / this.minimapRange; // pixels per metre
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const toMini = (wx, wy) => ({ x: cx + (wx - this.selfUser.x) * k, y: cy - (wy - this.selfUser.y) * k });

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, size, size);
    ctx.fillStyle = 'rgba(3, 7, 18, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(75, 85, 99, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.clip();

    for (const z of this.zones) {
      const p = toMini(z.x, z.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, z.radius * k, 0, Math.PI * 2);
      ctx.fillStyle = z.color || 'rgba(99, 102, 241, 0.2)';
      ctx.fill();
    }
    for (const b of this.beacons) {
      const p = toMini(b.x, b.y);
      ctx.fillStyle = '#eab308';
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }

    ctx.beginPath();
    ctx.arc(cx, cy, (this.selfUser.audioRange || 35) * k, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
    ctx.stroke();

    for (const p of this.peers.values()) {
      const m = toMini(p.x, p.y);
      ctx.beginPath();
      ctx.arc(m.x, m.y, p.isBot ? 2 : 3, 0, Math.PI * 2);
      ctx.fillStyle = this.audiblePeerIds.has(p.id) ? '#10b981' : '#6b7280';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = this.selfUser.avatarColor || '#06b6d4';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('MINIMAP', x0 + 4, y0 + 11);
    ctx.restore();
  }

  drawGrid(ctx, w, h) {
    ctx.save();
    const meterStep = 10; // grid line every 10 meters
    const pixelStep = meterStep * this.scale;

    const startX = (w / 2 - this.cameraOffset.x * this.scale) % pixelStep;
    const startY = (h / 2 + this.cameraOffset.y * this.scale) % pixelStep;

    ctx.strokeStyle = 'rgba(6, 182, 212, 0.07)';
    ctx.lineWidth = 1;

    for (let x = startX; x < w; x += pixelStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    for (let y = startY; y < h; y += pixelStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // World origin marker (0,0)
    const origin = this.worldToScreen(0, 0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(origin.x - 10, origin.y);
    ctx.lineTo(origin.x + 10, origin.y);
    ctx.moveTo(origin.x, origin.y - 10);
    ctx.lineTo(origin.x, origin.y + 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px monospace';
    ctx.fillText('(0m, 0m) Origin', origin.x + 8, origin.y - 8);

    ctx.restore();
  }

  drawZones(ctx) {
    ctx.save();
    for (const z of this.zones) {
      const pos = this.worldToScreen(z.x, z.y);
      const r = z.radius * this.scale;

      // Fill
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = z.color || 'rgba(99, 102, 241, 0.15)';
      ctx.fill();

      // Border
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = z.type === 'echo' ? '#3b82f6' : (z.type === 'muffled' ? '#eab308' : (z.type === 'broadcast' ? '#ef4444' : '#10b981'));
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = '#f3f4f6';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(z.name, pos.x, pos.y - r - 8);

      // Type Badge
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '9px monospace';
      ctx.fillText(`[${z.type.toUpperCase()}] R=${z.radius}m`, pos.x, pos.y - r + 4);
    }
    ctx.restore();
  }

  drawBeacons(ctx) {
    ctx.save();
    for (const b of this.beacons) {
      const pos = this.worldToScreen(b.x, b.y);

      // Beacon icon
      ctx.fillStyle = '#eab308';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, b.radius * this.scale, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#fef08a';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`🔔 ${b.name}`, pos.x, pos.y - 12);
    }
    ctx.restore();
  }

  drawSelfHearingCone(ctx) {
    ctx.save();
    const selfPos = this.worldToScreen(this.selfUser.x, this.selfUser.y);
    const rangePx = (this.selfUser.audioRange || 35) * this.scale;

    // Hearing range circle
    ctx.beginPath();
    ctx.arc(selfPos.x, selfPos.y, rangePx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.03)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Directional Sight Cone (120 degree cone)
    const headingRad = (this.selfUser.heading * Math.PI) / 180;
    const coneAngle = (60 * Math.PI) / 180;
    const coneLen = rangePx * 0.75;

    ctx.beginPath();
    ctx.moveTo(selfPos.x, selfPos.y);
    ctx.arc(selfPos.x, selfPos.y, coneLen, -headingRad - coneAngle, -headingRad + coneAngle);
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
    ctx.fill();

    ctx.restore();
  }

  drawPeers(ctx) {
    ctx.save();
    const selfPos = this.worldToScreen(this.selfUser.x, this.selfUser.y);

    for (const p of this.peers.values()) {
      const pos = this.worldToScreen(p.x, p.y);
      const isAudible = this.audiblePeerIds.has(p.id);

      // Distance line if audible
      if (isAudible) {
        ctx.beginPath();
        ctx.moveTo(selfPos.x, selfPos.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Distance text badge
        const midX = (selfPos.x + pos.x) / 2;
        const midY = (selfPos.y + pos.y) / 2;
        const dist = Math.hypot(p.x - this.selfUser.x, p.y - this.selfUser.y).toFixed(1);

        ctx.fillStyle = '#06b6d4';
        ctx.font = '9px monospace';
        ctx.fillText(`${dist}m`, midX, midY);
      }

      // Voice emission ripples if speaking or emitting sound
      if (p.isSpeaking || p.isBot) {
        const rippleR = ((this.rippleAnimTick * 20) % 30) + 12;
        const alpha = Math.max(0, 1 - (rippleR / 45));
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, rippleR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(16, 185, 129, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Peer avatar circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = p.avatarColor || '#ec4899';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isAudible ? '#10b981' : '#4b5563';
      ctx.stroke();

      // Heading indicator
      const hRad = ((p.heading || 0) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + Math.cos(hRad) * 16, pos.y - Math.sin(hRad) * 16);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Username tag
      ctx.fillStyle = p.isMuted ? '#f87171' : '#f3f4f6';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.username}${p.isMuted ? ' 🔇' : (p.isSpeaking && !p.isBot ? ' 🎙️' : '')}`, pos.x, pos.y - 14);

      if (p.isBot) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '8px monospace';
        ctx.fillText('AI BOT', pos.x, pos.y + 18);
      }
    }
    ctx.restore();
  }

  drawSelfAvatar(ctx) {
    ctx.save();
    const pos = this.worldToScreen(this.selfUser.x, this.selfUser.y);
    const color = this.selfUser.avatarColor || '#06b6d4';

    // Live voice ring: pulses with mic level while you are transmitting
    if (this.selfUser.isSpeaking && !this.selfUser.isMuted) {
      const r = 16 + this.selfLevel * 26 + ((this.rippleAnimTick * 18) % 10);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Glowing outer ring
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.25)';
    ctx.fill();

    // Inner avatar dot (your chosen colour)
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.selfUser.isMuted ? '#f43f5e' : '#ffffff';
    ctx.stroke();

    // Direction pointer
    const headingRad = (this.selfUser.heading * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineTo(pos.x + Math.cos(headingRad) * 20, pos.y - Math.sin(headingRad) * 20);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Tag
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.selfUser.username} (YOU)${this.selfUser.isMuted ? ' 🔇' : ''}`, pos.x, pos.y - 18);

    ctx.restore();
  }
}

// Attach globally
window.SpatialMap = SpatialMap;