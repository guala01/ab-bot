const Database = require('better-sqlite3');
const db = new Database('league.db');
db.pragma('journal_mode = WAL');

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

  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT,
    channel_id TEXT,
    day TEXT
  );

  CREATE TABLE IF NOT EXISTS teams_v2 (
    message_id TEXT,
    user_id TEXT,
    slot_time TEXT,
    team TEXT,
    PRIMARY KEY (message_id, user_id, slot_time)
  );

  CREATE TABLE IF NOT EXISTS game_stats (
    character_name TEXT PRIMARY KEY,
    class TEXT,
    spec TEXT,
    games_played INTEGER DEFAULT 0,
    last_updated TEXT
  );
`);

// Add custom_name column if it doesn't exist
try {
  db.prepare('ALTER TABLE stats ADD COLUMN custom_name TEXT').run();
} catch (e) {
  // Column likely exists
}

module.exports = {
  getConfig: (guildId, day) => {
    return db.prepare('SELECT * FROM configs WHERE guild_id = ? AND day = ?').get(guildId, day);
  },
  saveConfig: (guildId, day, ranges) => {
    return db.prepare('INSERT OR REPLACE INTO configs (guild_id, day, ranges) VALUES (?, ?, ?)').run(guildId, day, ranges);
  },
  saveMessage: (messageId, guildId, channelId, day) => {
    return db.prepare('INSERT OR REPLACE INTO messages (message_id, guild_id, channel_id, day) VALUES (?, ?, ?, ?)').run(messageId, guildId, channelId, day);
  },
  getMessage: (messageId) => {
    return db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  },
  getAllMessages: () => {
    return db.prepare('SELECT * FROM messages').all();
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
  },
  getAllStats: () => {
    return db.prepare('SELECT * FROM stats ORDER BY count DESC').all();
  },
  getStat: (userId, guildId) => {
    return db.prepare('SELECT * FROM stats WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
  },
  getAllConfigs: () => {
    return db.prepare('SELECT * FROM configs').all();
  },
  getAllSignups: () => {
    return db.prepare('SELECT * FROM signups ORDER BY message_id, slot_time ASC').all();
  },
  updateGameStats: (stats) => {
    const insert = db.prepare('INSERT OR REPLACE INTO game_stats (character_name, class, spec, games_played, last_updated) VALUES (@name, @class, @spec, @count, datetime("now"))');
    const deleteOld = db.prepare('DELETE FROM game_stats');
    
    const transaction = db.transaction((stats) => {
      deleteOld.run();
      for (const stat of stats) insert.run(stat);
    });
    transaction(stats);
  },
  getGameStats: () => {
    return db.prepare('SELECT * FROM game_stats ORDER BY games_played DESC').all();
  },
  updateCustomName: (userId, guildId, name) => {
    return db.prepare('UPDATE stats SET custom_name = ? WHERE user_id = ? AND guild_id = ?').run(name, userId, guildId);
  },
  setTeam: (messageId, userId, slotTime, team) => {
    return db.prepare('INSERT OR REPLACE INTO teams_v2 (message_id, user_id, slot_time, team) VALUES (?, ?, ?, ?)').run(messageId, userId, slotTime, team);
  },
  getTeams: (messageId) => {
    return db.prepare('SELECT * FROM teams_v2 WHERE message_id = ?').all(messageId);
  },
  deleteMessage: (messageId) => {
    db.prepare('DELETE FROM signups WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM teams_v2 WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE message_id = ?').run(messageId);
  },
  updateMessageDay: (messageId, day) => {
    return db.prepare('UPDATE messages SET day = ? WHERE message_id = ?').run(day, messageId);
  }
};
