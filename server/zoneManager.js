/**
 * ProxiSpeak Acoustic Zone Manager
 * Controls virtual acoustic regions with unique acoustic environmental profiles:
 * - Echo Chamber: Adds high reverberation
 * - Muffled/Occluded Room: Low-pass filter simulating wall obstruction
 * - Broadcast Stage: Overrides distance attenuation for campus announcements
 * - Quiet Pod: Constrains audio strictly within the perimeter
 */

class ZoneManager {
  constructor(db) {
    this.db = db;
    this.zones = new Map();
  }

  async init() {
    const loadedZones = await this.db.getAllZones();
    this.zones.clear();
    for (const z of loadedZones) {
      this.zones.set(z.id, {
        ...z,
        radius: Number(z.radius),
        x: Number(z.x),
        y: Number(z.y),
        reverb_level: Number(z.reverb_level || 0),
        cutoff_freq: Number(z.cutoff_freq || 20000),
        max_gain: Number(z.max_gain || 1.0)
      });
    }
    console.log(`[ZoneManager] Loaded ${this.zones.size} acoustic zones`);
  }

  getAllZones() {
    return Array.from(this.zones.values());
  }

  getZone(id) {
    return this.zones.get(id);
  }

  async addZone(zoneData) {
    if (![zoneData.x, zoneData.y, zoneData.radius].every((v) => Number.isFinite(Number(v))) || Number(zoneData.radius) <= 0) {
      const err = new Error('Zone requires numeric x, y and a positive radius');
      err.statusCode = 400;
      throw err;
    }
    const zone = {
      id: zoneData.id || `zone-${Date.now()}`,
      name: zoneData.name || 'Custom Zone',
      type: zoneData.type || 'normal',
      x: Number(zoneData.x),
      y: Number(zoneData.y),
      radius: Number(zoneData.radius),
      reverb_level: Number(zoneData.reverb_level || 0),
      cutoff_freq: Number(zoneData.cutoff_freq || 20000),
      max_gain: Number(zoneData.max_gain || 1.0),
      color: zoneData.color || '#4f46e5'
    };

    await this.db.createZone(zone);
    this.zones.set(zone.id, zone);
    return zone;
  }

  /**
   * Determine the current zone a given (x, y) coordinate is situated within.
   * If inside multiple overlapping zones, returns the one with the closest center.
   */
  getZoneAt(x, y) {
    let closestZone = null;
    let closestDist = Infinity;

    for (const zone of this.zones.values()) {
      const dx = x - zone.x;
      const dy = y - zone.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= zone.radius && dist < closestDist) {
        closestZone = {
          ...zone,
          distanceFromCenter: dist
        };
        closestDist = dist;
      }
    }

    return closestZone;
  }

  /**
   * Compute acoustic transmission modifier between speaker and listener
   * based on their respective zone memberships.
   */
  getAcousticFilterBetween(speakerPos, listenerPos) {
    const speakerZone = this.getZoneAt(speakerPos.x, speakerPos.y);
    const listenerZone = this.getZoneAt(listenerPos.x, listenerPos.y);

    let reverb = 0.0;
    let cutoff = 20000;
    let gainMultiplier = 1.0;
    let isBlocked = false;

    // Both in quiet bubble: audio stays in; outside audio blocked
    if (speakerZone && speakerZone.type === 'quiet') {
      if (!listenerZone || listenerZone.id !== speakerZone.id) {
        // Speaker is inside quiet pod, listener is outside: muffled/inaudible
        cutoff = 400;
        gainMultiplier = 0.05;
      }
    } else if (listenerZone && listenerZone.type === 'quiet') {
      if (!speakerZone || speakerZone.id !== listenerZone.id) {
        // Listener inside quiet pod, speaker is outside
        cutoff = 400;
        gainMultiplier = 0.05;
      }
    }

    // Broadcast zone: Speaker on stage broadcasts loud and clear across distance
    if (speakerZone && speakerZone.type === 'broadcast') {
      gainMultiplier = Math.max(gainMultiplier, speakerZone.max_gain > 1 ? speakerZone.max_gain : 1.4);
    }

    // Muffled zone: Apply low-pass wall occlusion (cutoff comes from the zone definition)
    const muffledZone = (speakerZone && speakerZone.type === 'muffled') ? speakerZone
      : ((listenerZone && listenerZone.type === 'muffled') ? listenerZone : null);
    if (muffledZone) {
      cutoff = Math.min(cutoff, muffledZone.cutoff_freq || 950);
      gainMultiplier *= 0.7;
    }

    // Echo zone: apply reverberation (level comes from the zone definition)
    const echoZone = (listenerZone && listenerZone.type === 'echo') ? listenerZone
      : ((speakerZone && speakerZone.type === 'echo') ? speakerZone : null);
    if (echoZone) {
      reverb = Math.max(reverb, echoZone.reverb_level || 0.75);
    }

    return {
      speakerZone: speakerZone ? speakerZone.name : null,
      listenerZone: listenerZone ? listenerZone.name : null,
      reverb,
      cutoff,
      gainMultiplier,
      isBlocked
    };
  }
}

module.exports = ZoneManager;
