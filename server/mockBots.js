class MockBotSimulator {
  constructor(spatialEngine, broadcastCallback) {
    this.spatialEngine = spatialEngine;
    this.broadcast = broadcastCallback;
    this.bots = new Map();
    this.timer = null;
    this.tickInterval = 100; // ms
  }

  initDefaultBots() {
    this.addBot({
      id: 'bot-alice',
      username: 'Alice (Orbit)',
      avatarColor: '#ec4899',
      radius: 20,
      center: { x: 0, y: 0 },
      angularSpeed: 0.03, // rad/tick
      currentAngle: 0,
      audioFrequency: 440, // Concert A (440Hz)
      audioRange: 35,
      soundPattern: 'pulse'
    });

    this.addBot({
      id: 'bot-bob',
      username: 'Bob (Auditorium)',
      avatarColor: '#8b5cf6',
      center: { x: -40, y: 40 },
      radius: 12,
      angularSpeed: 0.02,
      currentAngle: Math.PI,
      audioFrequency: 554.37, // C#5
      audioRange: 30,
      soundPattern: 'sine'
    });

    this.addBot({
      id: 'bot-carol',
      username: 'Carol (Library Scout)',
      avatarColor: '#10b981',
      center: { x: 45, y: 40 },
      radius: 10,
      angularSpeed: 0.025,
      currentAngle: Math.PI / 2,
      audioFrequency: 659.25, // E5
      audioRange: 25,
      soundPattern: 'chime'
    });
  }

  addBot(config) {
    const bot = {
      id: config.id || `bot-${Date.now()}`,
      username: config.username || 'Virtual Bot',
      avatarColor: config.avatarColor || '#f59e0b',
      center: config.center || { x: 0, y: 0 },
      radius: config.radius || 15,
      angularSpeed: config.angularSpeed || 0.02,
      currentAngle: config.currentAngle || 0,
      audioFrequency: config.audioFrequency || 440,
      audioRange: config.audioRange || 30,
      soundPattern: config.soundPattern || 'pulse',
      isBot: true,
      isSpeaking: true,
      heading: 0,
      x: config.center ? config.center.x : 0,
      y: config.center ? config.center.y : 0,
      z: 0
    };

    bot.x = bot.center.x + Math.cos(bot.currentAngle) * bot.radius;
    bot.y = bot.center.y + Math.sin(bot.currentAngle) * bot.radius;
    bot.heading = ((bot.currentAngle + Math.PI / 2) * 180) / Math.PI;

    this.bots.set(bot.id, bot);
    this.spatialEngine.updatePeer(bot.id, bot);
    return bot;
  }

  removeBot(id) {
    const bot = this.bots.get(id);
    if (bot) {
      this.spatialEngine.removePeer(id);
      this.bots.delete(id);
      if (this.broadcast) {
        this.broadcast({
          type: 'PEER_LEFT',
          peerId: id
        });
      }
      return true;
    }
    return false;
  }

  start() {
    if (this.timer) return;
    this.initDefaultBots();

    this.timer = setInterval(() => {
      this.updatePhysics();
    }, this.tickInterval);

    console.log('[MockBots] Simulator started with', this.bots.size, 'bots');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const id of Array.from(this.bots.keys())) {
      this.removeBot(id); 
    }
    console.log('[MockBots] Simulator stopped');
  }

  updatePhysics() {
    const updates = [];

    for (const bot of this.bots.values()) {
      bot.currentAngle += bot.angularSpeed;
      if (bot.currentAngle > Math.PI * 2) {
        bot.currentAngle -= Math.PI * 2;
      }

      const prevX = bot.x;
      const prevY = bot.y;

      bot.x = bot.center.x + Math.cos(bot.currentAngle) * bot.radius;
      bot.y = bot.center.y + Math.sin(bot.currentAngle) * bot.radius;

      const dx = bot.x - prevX;
      const dy = bot.y - prevY;
      let heading = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (heading < 0) heading += 360;
      bot.heading = heading;

      this.spatialEngine.updatePeer(bot.id, bot);

      updates.push({
        id: bot.id,
        username: bot.username,
        avatarColor: bot.avatarColor,
        x: bot.x,
        y: bot.y,
        z: bot.z,
        heading: bot.heading,
        audioRange: bot.audioRange,
        audioFrequency: bot.audioFrequency,
        soundPattern: bot.soundPattern,
        isSpeaking: true,
        isBot: true
      });
    }

    if (this.broadcast && updates.length > 0) {
      this.broadcast({
        type: 'BOT_POSITIONS_UPDATE',
        bots: updates
      });
    }
  }

  getAllBots() {
    return Array.from(this.bots.values());
  }
}

module.exports = MockBotSimulator;
