const Database = require('better-sqlite3');
const db = new Database('league.db');

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    guild_id TEXT,
    day TEXT,
    ranges TEXT,
    PRIMARY KEY (guild_id, day)
  );

  CREATE TABLE IF NOT EXISTS signups (
    message_id TEXT,
    user_id TEXT,
    slot_time TEXT,
    user_display_name TEXT,
    PRIMARY KEY (message_id, user_id, slot_time)
  );

  CREATE TABLE IF NOT EXISTS stats (
    user_id TEXT,
    guild_id TEXT,
    count INTEGER DEFAULT 0,
    last_seen TEXT,
    PRIMARY KEY (user_id, guild_id)
  );
`);

module.exports = {
  getConfig: (guildId, day) => {
    return db.prepare('SELECT * FROM configs WHERE guild_id = ? AND day = ?').get(guildId, day);
  },
  saveConfig: (guildId, day, ranges) => {
    return db.prepare('INSERT OR REPLACE INTO configs (guild_id, day, ranges) VALUES (?, ?, ?)').run(guildId, day, ranges);
  },
  addSignup: (messageId, userId, slotTime, displayName) => {
    return db.prepare('INSERT OR IGNORE INTO signups (message_id, user_id, slot_time, user_display_name) VALUES (?, ?, ?, ?)').run(messageId, userId, slotTime, displayName);
  },
  removeSignup: (messageId, userId, slotTime) => {
    return db.prepare('DELETE FROM signups WHERE message_id = ? AND user_id = ? AND slot_time = ?').run(messageId, userId, slotTime);
  },
  getSignups: (messageId) => {
    return db.prepare('SELECT * FROM signups WHERE message_id = ? ORDER BY slot_time ASC').all(messageId);
  },
  incrementStat: (userId, guildId) => {
    const stmt = db.prepare(`
      INSERT INTO stats (user_id, guild_id, count, last_seen)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
      count = count + 1,
      last_seen = datetime('now')
    `);
    return stmt.run(userId, guildId);
  },
  getStats: (guildId) => {
    return db.prepare('SELECT * FROM stats WHERE guild_id = ? ORDER BY count DESC').all(guildId);
  }
};
