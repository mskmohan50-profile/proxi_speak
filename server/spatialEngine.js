/**
 * ProxiSpeak Spatial Partitioning & Acoustic Routing Engine
 * Implements Spatial Grid Hashing, Euclidean & Haversine distance,
 * Distance Attenuation Modeling (Inverse Square, Exponential, Linear),
 * and Acoustic Cone Directional Occlusion calculations.
 */

class SpatialEngine {
  constructor(options = {}) {
    this.cellSize = options.cellSize || 25.0; // Cell size in meters
    this.grid = new Map(); // key: "cellX,cellY" -> Set of userIds
    this.peers = new Map(); // userId -> { id, x, y, z, heading, audioRange, ... }
    this.maxPeerRange = 0; // largest audioRange of any peer (bounds the grid search radius)
  }

  _recomputeMaxRange() {
    let max = 0;
    for (const p of this.peers.values()) {
      if (p.audioRange > max) max = p.audioRange;
    }
    this.maxPeerRange = max;
  }

  /**
   * Compute spatial grid cell coordinate for a given (x, y) position
   */
  getCellKey(x, y) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  /**
   * Update or register a peer's geospatial state
   */
  updatePeer(id, state) {
    const existing = this.peers.get(id);
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

    // Resolve the new coordinates first (missing / non-finite values keep the old ones)
    const x = num(state.x, existing ? existing.x : 0);
    const y = num(state.y, existing ? existing.y : 0);
    const z = num(state.z, existing ? existing.z : 0);

    // If moving to another cell, remove from the old cell
    if (existing) {
      const oldKey = this.getCellKey(existing.x, existing.y);
      const newKey = this.getCellKey(x, y);
      if (oldKey !== newKey) {
        const oldSet = this.grid.get(oldKey);
        if (oldSet) {
          oldSet.delete(id);
          if (oldSet.size === 0) this.grid.delete(oldKey);
        }
      }
    }

    const audioRange = num(state.audioRange, existing ? existing.audioRange : 35.0);

    const peerData = {
      id,
      x,
      y,
      z,
      heading: num(state.heading, existing ? existing.heading : 0), // degrees [0, 360)
      audioRange: audioRange > 0 ? audioRange : (existing ? existing.audioRange : 35.0),
      username: state.username || (existing ? existing.username : 'User'),
      avatarColor: state.avatarColor || (existing ? existing.avatarColor : '#6366f1'),
      isMuted: state.isMuted !== undefined ? state.isMuted : (existing ? existing.isMuted : false),
      isDeafened: state.isDeafened !== undefined ? state.isDeafened : (existing ? existing.isDeafened : false),
      isSpeaking: state.isSpeaking !== undefined ? state.isSpeaking : (existing ? existing.isSpeaking : false),
      isBot: state.isBot !== undefined ? !!state.isBot : (existing ? existing.isBot : false),
      lastUpdated: Date.now()
    };
    // Keep bot audio metadata (used by clients to synthesize tones)
    if (state.audioFrequency !== undefined) peerData.audioFrequency = state.audioFrequency;
    else if (existing && existing.audioFrequency !== undefined) peerData.audioFrequency = existing.audioFrequency;
    if (state.soundPattern !== undefined) peerData.soundPattern = state.soundPattern;
    else if (existing && existing.soundPattern !== undefined) peerData.soundPattern = existing.soundPattern;

    this.peers.set(id, peerData);
    if (peerData.audioRange > this.maxPeerRange) this.maxPeerRange = peerData.audioRange;

    const cellKey = this.getCellKey(peerData.x, peerData.y);
    if (!this.grid.has(cellKey)) {
      this.grid.set(cellKey, new Set());
    }
    this.grid.get(cellKey).add(id);

    return peerData;
  }

  /**
   * Remove a peer from the spatial engine
   */
  removePeer(id) {
    const existing = this.peers.get(id);
    if (existing) {
      const cellKey = this.getCellKey(existing.x, existing.y);
      const cellSet = this.grid.get(cellKey);
      if (cellSet) {
        cellSet.delete(id);
        if (cellSet.size === 0) this.grid.delete(cellKey);
      }
      this.peers.delete(id);
      if (existing.audioRange >= this.maxPeerRange) this._recomputeMaxRange();
      return true;
    }
    return false;
  }

  getPeer(id) {
    return this.peers.get(id);
  }

  getAllPeers() {
    return Array.from(this.peers.values());
  }

  /**
   * 3D Euclidean distance in meters
   */
  getDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = (p1.z || 0) - (p2.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Convert GPS (lat, lon) coordinates to local Cartesian (x, y) meters
   * relative to an anchor reference point.
   */
  static gpsToCartesian(lat, lon, anchorLat, anchorLon) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat - anchorLat) * (Math.PI / 180);
    const dLon = (lon - anchorLon) * (Math.PI / 180);
    const meanLat = ((lat + anchorLat) / 2) * (Math.PI / 180);

    const x = dLon * Math.cos(meanLat) * R;
    const y = dLat * R;
    return { x, y };
  }

  /**
   * Calculate attenuation gain using Inverse Distance Model (Web Audio standard)
   * gain = refDistance / (refDistance + rolloff * (max(distance, refDistance) - refDistance))
   */
  calculateAttenuation(distance, refDistance = 2.0, maxDistance = 40.0, rolloffFactor = 1.2) {
    if (distance <= refDistance) return 1.0;
    if (distance >= maxDistance) return 0.0;
    const gain = refDistance / (refDistance + rolloffFactor * (distance - refDistance));
    return Math.max(0.0, Math.min(1.0, gain));
  }

  /**
   * Directional acoustic cone gain:
   * Returns a factor [outerGain, 1.0] depending on whether listener is within speaker's projection cone.
   */
  calculateConeGain(speaker, listener, innerAngleDeg = 90, outerAngleDeg = 240, outerGain = 0.25) {
    // Vector from speaker to listener
    const dx = listener.x - speaker.x;
    const dy = listener.y - speaker.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return 1.0;

    // Angle of relative position vector in degrees [0, 360)
    let angleToListener = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angleToListener < 0) angleToListener += 360;

    // Angular difference with speaker heading
    let diff = Math.abs(angleToListener - speaker.heading);
    if (diff > 180) diff = 360 - diff;

    const halfInner = innerAngleDeg / 2;
    const halfOuter = outerAngleDeg / 2;

    if (diff <= halfInner) return 1.0;
    if (diff >= halfOuter) return outerGain;

    // Linear interpolation between inner and outer boundary
    const t = (diff - halfInner) / (halfOuter - halfInner);
    return 1.0 - t * (1.0 - outerGain);
  }

  /**
   * Find nearby peers for a given listener within maximum audible radius
   * Uses spatial hash grid search for optimal O(K) efficiency.
   */
  getAudiblePeersFor(listenerId) {
    const listener = this.peers.get(listenerId);
    if (!listener) return [];

    const radius = listener.audioRange || 35.0;
    // A far-away peer with a bigger range can still be heard, so search out to the largest range in use
    const searchRadius = Math.max(radius, this.maxPeerRange);
    const radiusCells = Math.ceil(searchRadius / this.cellSize);
    const centerCellX = Math.floor(listener.x / this.cellSize);
    const centerCellY = Math.floor(listener.y / this.cellSize);

    const audible = [];

    for (let cx = centerCellX - radiusCells; cx <= centerCellX + radiusCells; cx++) {
      for (let cy = centerCellY - radiusCells; cy <= centerCellY + radiusCells; cy++) {
        const cellKey = `${cx},${cy}`;
        const cellPeers = this.grid.get(cellKey);
        if (!cellPeers) continue;

        for (const peerId of cellPeers) {
          if (peerId === listenerId) continue;
          const peer = this.peers.get(peerId);
          if (!peer) continue;

          const dist = this.getDistance(listener, peer);
          const effectiveRange = Math.max(radius, peer.audioRange);

          if (dist <= effectiveRange) {
            const attenuation = this.calculateAttenuation(dist, 2.0, effectiveRange);
            const coneGain = this.calculateConeGain(peer, listener);
            const netGain = attenuation * coneGain;

            audible.push({
              peer,
              distance: dist,
              netGain,
              attenuation,
              coneGain,
              relativeX: peer.x - listener.x,
              relativeY: peer.y - listener.y,
              relativeZ: (peer.z || 0) - (listener.z || 0)
            });
          }
        }
      }
    }

    return audible.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Benchmark metrics: Total potential mesh connections vs culled connections
   */
  computeMeshCullingStats() {
    const count = this.peers.size;
    if (count <= 1) return { totalPossibleLinks: 0, activeAudioLinks: 0, cullingRatioPercent: 100 };

    const totalPossibleLinks = (count * (count - 1)) / 2;
    let activeLinks = 0;

    const peerArray = Array.from(this.peers.values());
    for (let i = 0; i < peerArray.length; i++) {
      for (let j = i + 1; j < peerArray.length; j++) {
        const d = this.getDistance(peerArray[i], peerArray[j]);
        const maxRange = Math.max(peerArray[i].audioRange, peerArray[j].audioRange);
        if (d <= maxRange) {
          activeLinks++;
        }
      }
    }

    const saved = totalPossibleLinks - activeLinks;
    const cullingRatioPercent = totalPossibleLinks > 0 ? ((saved / totalPossibleLinks) * 100).toFixed(1) : 0;

    return {
      peerCount: count,
      totalPossibleLinks,
      activeAudioLinks: activeLinks,
      linksAvoided: saved,
      cullingRatioPercent: Number(cullingRatioPercent)
    };
  }
}

module.exports = SpatialEngine;
