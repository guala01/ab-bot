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
    games_played INTEGER DEFAULT 0,
    last_updated TEXT
  );

  CREATE TABLE IF NOT EXISTS nodewar_signups (
    message_id TEXT,
    user_id TEXT,
    user_display_name TEXT,
    position INTEGER,
    status TEXT DEFAULT 'signed',
    signed_at TEXT,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS nodewar_messages (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT,
    channel_id TEXT,
    day TEXT,
    max_cap INTEGER DEFAULT 100,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS name_overrides (
    user_id TEXT,
    guild_id TEXT,
    display_name TEXT,
    PRIMARY KEY (user_id, guild_id)
  );
`);

// Add custom_name column if it doesn't exist
try {
  db.prepare('ALTER TABLE stats ADD COLUMN custom_name TEXT').run();
} catch (e) {
  // Column likely exists
}

// Migration: Recreate game_stats if it has old schema (class/spec columns)
try {
  const columns = db.pragma('table_info(game_stats)');
  const hasClass = columns.some(c => c.name === 'class');
  if (hasClass) {
    console.log('Migrating game_stats table to new schema...');
    db.prepare('DROP TABLE game_stats').run();
    db.exec(`
      CREATE TABLE game_stats (
        character_name TEXT PRIMARY KEY,
        games_played INTEGER DEFAULT 0,
        last_updated TEXT
      );
    `);
  }
} catch (e) {
  console.error('Migration error:', e);
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
  getMessagesByGuildDay: (guildId, day) => {
    return db.prepare('SELECT * FROM messages WHERE guild_id = ? AND day = ?').all(guildId, day);
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
  decrementStat: (userId, guildId) => {
    const stmt = db.prepare(`
      UPDATE stats 
      SET count = MAX(0, count - 1) 
      WHERE user_id = ? AND guild_id = ?
    `);
    return stmt.run(userId, guildId);
  },
  setStatCount: (userId, guildId, count) => {
    const stmt = db.prepare(`
        INSERT INTO stats (user_id, guild_id, count, last_seen)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, guild_id) DO UPDATE SET
        count = ?
    `);
    return stmt.run(userId, guildId, count, count);
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
  getSignupsForMessages: (messageIds) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM signups WHERE message_id IN (${placeholders}) ORDER BY message_id, slot_time ASC`).all(...messageIds);
  },
  getUserSignupsForMessagesSlot: (messageIds, userId, slotTime) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM signups WHERE message_id IN (${placeholders}) AND user_id = ? AND slot_time = ?`).all(...messageIds, userId, slotTime);
  },
  getTeamsForMessages: (messageIds) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM teams_v2 WHERE message_id IN (${placeholders})`).all(...messageIds);
  },
  updateGameStats: (stats) => {
    const insert = db.prepare("INSERT OR REPLACE INTO game_stats (character_name, games_played, last_updated) VALUES (@name, @count, datetime('now'))");
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
  syncStatsFromSignups: () => {
    // Get counts from signups joined with messages to get guild_id
    const rows = db.prepare(`
      SELECT 
        s.user_id, 
        m.guild_id, 
        COUNT(*) as count
      FROM signups s
      JOIN messages m ON s.message_id = m.message_id
      GROUP BY s.user_id, m.guild_id
    `).all();

    const insert = db.prepare(`
      INSERT INTO stats (user_id, guild_id, count, last_seen)
      VALUES (@user_id, @guild_id, @count, datetime('now'))
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
      count = @count
    `);

    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        if (row.guild_id) {
          insert.run(row);
        }
      }
    });

    transaction(rows);
  },
  updateCustomName: (userId, guildId, name) => {
    return db.prepare('UPDATE stats SET custom_name = ? WHERE user_id = ? AND guild_id = ?').run(name, userId, guildId);
  },
  setTeam: (messageId, userId, slotTime, team) => {
    return db.prepare('INSERT OR REPLACE INTO teams_v2 (message_id, user_id, slot_time, team) VALUES (?, ?, ?, ?)').run(messageId, userId, slotTime, team);
  },
  removeTeam: (messageId, userId, slotTime) => {
    return db.prepare('DELETE FROM teams_v2 WHERE message_id = ? AND user_id = ? AND slot_time = ?').run(messageId, userId, slotTime);
  },
  getTeams: (messageId) => {
    return db.prepare('SELECT * FROM teams_v2 WHERE message_id = ?').all(messageId);
  },
  deleteMessage: (messageId) => {
    db.prepare('DELETE FROM signups WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM teams_v2 WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE message_id = ?').run(messageId);
  },
  deleteMessages: (messageIds) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM signups WHERE message_id IN (${placeholders})`).run(...messageIds);
    db.prepare(`DELETE FROM teams_v2 WHERE message_id IN (${placeholders})`).run(...messageIds);
    db.prepare(`DELETE FROM messages WHERE message_id IN (${placeholders})`).run(...messageIds);
  },
  updateMessageDay: (messageId, day) => {
    return db.prepare('UPDATE messages SET day = ? WHERE message_id = ?').run(day, messageId);
  },
  updateMessageDays: (messageIds, day) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    return db.prepare(`UPDATE messages SET day = ? WHERE message_id IN (${placeholders})`).run(day, ...messageIds);
  },

  // ========== Node War Functions ==========
  saveNodewarMessage: (messageId, guildId, channelId, day, maxCap) => {
    return db.prepare(`
      INSERT OR REPLACE INTO nodewar_messages (message_id, guild_id, channel_id, day, max_cap, created_at) 
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(messageId, guildId, channelId, day, maxCap);
  },
  getNodewarMessage: (messageId) => {
    return db.prepare('SELECT * FROM nodewar_messages WHERE message_id = ?').get(messageId);
  },
  getAllNodewarMessages: () => {
    return db.prepare('SELECT * FROM nodewar_messages ORDER BY created_at DESC').all();
  },
  addNodewarSignup: (messageId, userId, displayName) => {
    // Get current max position
    const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM nodewar_signups WHERE message_id = ?').get(messageId);
    const position = (maxPos && maxPos.maxPos !== null) ? maxPos.maxPos + 1 : 1;
    
    // Get max cap for this message
    const meta = db.prepare('SELECT max_cap FROM nodewar_messages WHERE message_id = ?').get(messageId);
    const maxCap = meta ? meta.max_cap : 100;
    
    // Count current signed players
    const signedCount = db.prepare("SELECT COUNT(*) as cnt FROM nodewar_signups WHERE message_id = ? AND status = 'signed'").get(messageId);
    const currentSigned = signedCount ? signedCount.cnt : 0;
    
    // Determine status
    const status = currentSigned < maxCap ? 'signed' : 'waitlist';
    
    return db.prepare(`
      INSERT OR IGNORE INTO nodewar_signups (message_id, user_id, user_display_name, position, status, signed_at) 
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(messageId, userId, displayName, position, status);
  },
  removeNodewarSignup: (messageId, userId) => {
    // Get the user being removed
    const removed = db.prepare('SELECT * FROM nodewar_signups WHERE message_id = ? AND user_id = ?').get(messageId, userId);
    if (!removed) return { changes: 0 };
    
    // Delete the user
    const result = db.prepare('DELETE FROM nodewar_signups WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    
    // If they were signed (not waitlist), promote first waitlister
    if (removed.status === 'signed') {
      const firstWaitlist = db.prepare(`
        SELECT * FROM nodewar_signups 
        WHERE message_id = ? AND status = 'waitlist' 
        ORDER BY position ASC 
        LIMIT 1
      `).get(messageId);
      
      if (firstWaitlist) {
        db.prepare("UPDATE nodewar_signups SET status = 'signed' WHERE message_id = ? AND user_id = ?")
          .run(messageId, firstWaitlist.user_id);
      }
    }
    
    return result;
  },
  getNodewarSignups: (messageId) => {
    return db.prepare('SELECT * FROM nodewar_signups WHERE message_id = ? ORDER BY position ASC').all(messageId);
  },
  getNodewarSignup: (messageId, userId) => {
    return db.prepare('SELECT * FROM nodewar_signups WHERE message_id = ? AND user_id = ?').get(messageId, userId);
  },
  deleteNodewarMessage: (messageId) => {
    db.prepare('DELETE FROM nodewar_signups WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM nodewar_messages WHERE message_id = ?').run(messageId);
  },

  // ========== Name Override Functions ==========
  setNameOverride: (userId, guildId, displayName) => {
    return db.prepare(`
      INSERT OR REPLACE INTO name_overrides (user_id, guild_id, display_name)
      VALUES (?, ?, ?)
    `).run(userId, guildId, displayName);
  },
  removeNameOverride: (userId, guildId) => {
    return db.prepare('DELETE FROM name_overrides WHERE user_id = ? AND guild_id = ?').run(userId, guildId);
  },
  getNameOverride: (userId, guildId) => {
    return db.prepare('SELECT display_name FROM name_overrides WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
  },
  getAllNameOverrides: (guildId) => {
    return db.prepare('SELECT * FROM name_overrides WHERE guild_id = ? ORDER BY display_name ASC').all(guildId);
  },
  getNameOverridesForUsers: (userIds, guildId) => {
    if (!Array.isArray(userIds) || userIds.length === 0) return [];
    const placeholders = userIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM name_overrides WHERE user_id IN (${placeholders}) AND guild_id = ?`).all(...userIds, guildId);
  }
};
