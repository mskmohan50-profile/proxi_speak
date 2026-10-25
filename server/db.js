/**
 * ProxiSpeak Database Access Layer
 * Supports SQLite3 with an automatic file-backed JSON persistence fallback.
 * Manages user accounts, active sessions, audio beacons, and zone configurations.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'proxispeak.db');
const JSON_FALLBACK_PATH = path.join(__dirname, '..', 'data', 'proxispeak_data.json');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

class DatabaseManager {
  constructor() {
    this.isSqlite = false;
    this.sqliteDb = null;
    this.memoryStore = {
      users: [],
      beacons: [],
      zones: [],
      logs: []
    };
  }

  async init() {
    return new Promise((resolve) => {
      try {
        const sqlite3 = require('sqlite3').verbose();
        this.sqliteDb = new sqlite3.Database(DB_PATH, async (err) => {
          if (err) {
            console.warn('[DB] SQLite native initialization warning, falling back to JSON storage:', err.message);
            this.initJsonFallback();
            resolve();
          } else {
            this.isSqlite = true;
            console.log(`[DB] Connected to SQLite database at ${DB_PATH}`);
            await this.initSqliteSchema();
            resolve();
          }
        });
      } catch (e) {
        console.warn('[DB] SQLite3 module not available or native build missing, using file-backed JSON storage:', e.message);
        this.initJsonFallback();
        resolve();
      }
    });
  }

  async initSqliteSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        avatar_color TEXT,
        x REAL DEFAULT 0,
        y REAL DEFAULT 0,
        z REAL DEFAULT 0,
        heading REAL DEFAULT 0,
        is_muted INTEGER DEFAULT 0,
        is_deafened INTEGER DEFAULT 0,
        audio_range REAL DEFAULT 35.0,
        role TEXT DEFAULT 'participant',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL, /* echo, muffled, broadcast, quiet, normal */
        x REAL NOT NULL,
        y REAL NOT NULL,
        radius REAL NOT NULL,
        reverb_level REAL DEFAULT 0.0,
        cutoff_freq REAL DEFAULT 20000.0,
        max_gain REAL DEFAULT 1.0,
        color TEXT DEFAULT '#4f46e5'
      );

      CREATE TABLE IF NOT EXISTS audio_beacons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sound_type TEXT NOT NULL, /* ambient, announcement, siren, tone */
        x REAL NOT NULL,
        y REAL NOT NULL,
        radius REAL NOT NULL,
        frequency REAL DEFAULT 440,
        interval_sec REAL DEFAULT 5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        event_type TEXT,
        user_id TEXT,
        details TEXT
      );
    `;

    return new Promise((resolve) => {
      this.sqliteDb.exec(schema, async (err) => {
        if (err) {
          console.error('[DB] Schema setup failed:', err);
        } else {
          await this.seedDefaultData();
        }
        resolve();
      });
    });
  }

  initJsonFallback() {
    this.isSqlite = false;
    if (fs.existsSync(JSON_FALLBACK_PATH)) {
      try {
        const raw = fs.readFileSync(JSON_FALLBACK_PATH, 'utf-8');
        this.memoryStore = JSON.parse(raw);
        console.log(`[DB] Loaded persistent data store from ${JSON_FALLBACK_PATH}`);
      } catch (err) {
        console.error('[DB] Error parsing fallback json:', err);
      }
    }
    this.seedDefaultData();
  }

  persistJson() {
    if (!this.isSqlite) {
      try {
        fs.writeFileSync(JSON_FALLBACK_PATH, JSON.stringify(this.memoryStore, null, 2));
      } catch (err) {
        console.error('[DB] Failed persisting JSON store:', err);
      }
    }
  }

  async seedDefaultData() {
    const defaultZones = [
      {
        id: 'zone-auditorium',
        name: 'Grand Auditorium (Echo Chamber)',
        type: 'echo',
        x: -40,
        y: 40,
        radius: 30,
        reverb_level: 0.85,
        cutoff_freq: 18000,
        max_gain: 1.2,
        color: 'rgba(59, 130, 246, 0.25)'
      },
      {
        id: 'zone-library',
        name: 'Library & Study Lounge (Muffled/Occluded)',
        type: 'muffled',
        x: 45,
        y: 40,
        radius: 25,
        reverb_level: 0.1,
        cutoff_freq: 950,
        max_gain: 0.6,
        color: 'rgba(234, 179, 8, 0.25)'
      },
      {
        id: 'zone-stage',
        name: 'Town Hall Broadcast Stage',
        type: 'broadcast',
        x: 0,
        y: -40,
        radius: 20,
        reverb_level: 0.25,
        cutoff_freq: 20000,
        max_gain: 1.5,
        color: 'rgba(239, 68, 68, 0.25)'
      },
      {
        id: 'zone-whisper',
        name: 'Private Meeting Pod',
        type: 'quiet',
        x: 0,
        y: 15,
        radius: 12,
        reverb_level: 0.05,
        cutoff_freq: 20000,
        max_gain: 0.9,
        color: 'rgba(16, 185, 129, 0.25)'
      }
    ];

    const defaultBeacons = [
      {
        id: 'beacon-bell',
        name: 'Campus Clock Tower Chime',
        sound_type: 'bell',
        x: 0,
        y: 0,
        radius: 65,
        frequency: 523.25, // C5
        interval_sec: 10
      },
      {
        id: 'beacon-fountain',
        name: 'Zen Water Fountain',
        sound_type: 'ambient',
        x: -25,
        y: -15,
        radius: 20,
        frequency: 330,
        interval_sec: 3
      }
    ];

    if (this.isSqlite) {
      const zonePromises = defaultZones.map(z => {
        return new Promise((res) => {
          this.sqliteDb.run(
            `INSERT OR IGNORE INTO zones (id, name, type, x, y, radius, reverb_level, cutoff_freq, max_gain, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [z.id, z.name, z.type, z.x, z.y, z.radius, z.reverb_level, z.cutoff_freq, z.max_gain, z.color],
            () => res()
          );
        });
      });
      const beaconPromises = defaultBeacons.map(b => {
        return new Promise((res) => {
          this.sqliteDb.run(
            `INSERT OR IGNORE INTO audio_beacons (id, name, sound_type, x, y, radius, frequency, interval_sec)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [b.id, b.name, b.sound_type, b.x, b.y, b.radius, b.frequency, b.interval_sec],
            () => res()
          );
        });
      });
      await Promise.all([...zonePromises, ...beaconPromises]);
    } else {
      if (!this.memoryStore.zones.length) {
        this.memoryStore.zones = defaultZones;
      }
      if (!this.memoryStore.beacons.length) {
        this.memoryStore.beacons = defaultBeacons;
      }
      this.persistJson();
    }
  }

  // --- Zone Queries ---
  async getAllZones() {
    if (this.isSqlite) {
      return new Promise((resolve, reject) => {
        this.sqliteDb.all('SELECT * FROM zones', [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    }
    return this.memoryStore.zones;
  }

  async createZone(zone) {
    if (this.isSqlite) {
      return new Promise((resolve, reject) => {
        this.sqliteDb.run(
          `INSERT INTO zones (id, name, type, x, y, radius, reverb_level, cutoff_freq, max_gain, color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [zone.id, zone.name, zone.type, zone.x, zone.y, zone.radius, zone.reverb_level || 0, zone.cutoff_freq || 20000, zone.max_gain || 1, zone.color || '#4f46e5'],
          function (err) {
            if (err) reject(err);
            else resolve(zone);
          }
        );
      });
    }
    this.memoryStore.zones.push(zone);
    this.persistJson();
    return zone;
  }

  // --- Beacon Queries ---
  async getAllBeacons() {
    if (this.isSqlite) {
      return new Promise((resolve, reject) => {
        this.sqliteDb.all('SELECT * FROM audio_beacons', [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    }
    return this.memoryStore.beacons;
  }

  // --- Telemetry Logging ---
  logEvent(eventType, userId, details) {
    const detailsStr = typeof details === 'string' ? details : JSON.stringify(details);
    if (this.isSqlite) {
      this.sqliteDb.run(
        'INSERT INTO telemetry_logs (event_type, user_id, details) VALUES (?, ?, ?)',
        [eventType, userId, detailsStr],
        (err) => {
          if (err) console.error('[DB] Log error:', err);
        }
      );
    } else {
      this.memoryStore.logs.push({
        id: this.memoryStore.logs.length + 1,
        timestamp: new Date().toISOString(),
        event_type: eventType,
        user_id: userId,
        details: detailsStr
      });
      if (this.memoryStore.logs.length > 1000) {
        this.memoryStore.logs.shift();
      }
      this.persistJson();
    }
  }
}

module.exports = new DatabaseManager();
