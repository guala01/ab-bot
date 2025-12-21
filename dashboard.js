const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { Client, GatewayIntentBits } = require('discord.js');

require('dotenv').config();

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Initialize Discord Client
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Cache for names to avoid rate limits
const userCache = new Map();
const guildCache = new Map();

function parseLogFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const playerStats = new Map(); // name -> { name, class, spec, count }

        for (const line of lines) {
            const parts = line.trim().split('|');
            if (parts[0] === 'PLAYER') {
                const guildType = parts[1];
                if (guildType === 'MY_GUILD') {
                    const name = parts[2];
                    
                    if (!playerStats.has(name)) {
                        playerStats.set(name, { name, count: 0 });
                    }
                    playerStats.get(name).count++;
                }
            }
        }
        
        return Array.from(playerStats.values());
    } catch (e) {
        console.error('Error parsing log file:', e);
        return [];
    }
}

async function resolveUser(id) {
    if (userCache.has(id)) return userCache.get(id);
    try {
        const user = await client.users.fetch(id);
        const name = user.username;
        userCache.set(id, name);
        return name;
    } catch (e) {
        console.log(`Failed to resolve user ${id}: ${e.message}`);
        return id;
    }
}

async function resolveGuild(id) {
    if (guildCache.has(id)) return guildCache.get(id);
    try {
        const guild = await client.guilds.fetch(id);
        const name = guild.name;
        guildCache.set(id, name);
        return name;
    } catch (e) {
        console.log(`Failed to resolve guild ${id}: ${e.message}`);
        return id;
    }
}

function chunkMentions(prefix, userIds, maxLen) {
    const chunks = [];
    let current = prefix;
    for (const userId of userIds) {
        const mention = `<@${userId}>`;
        const next = current.length === prefix.length ? `${current} ${mention}` : `${current} ${mention}`;
        if (next.length > maxLen) {
            if (current !== prefix) chunks.push(current);
            current = `${prefix} ${mention}`;
        } else {
            current = next;
        }
    }
    if (current !== prefix) chunks.push(current);
    return chunks;
}

async function sendTeamRemindersToChannels({ messageIds, slotTime }) {
    const signups = db.getSignupsForMessages(messageIds);
    const teamsRaw = db.getTeamsForMessages(messageIds);
    const messageMetas = messageIds.map(id => db.getMessage(id)).filter(Boolean);

    const metaByMessageId = new Map();
    for (const m of messageMetas) metaByMessageId.set(m.message_id, m);
    const fallbackMeta = messageMetas.find(m => m && m.channel_id && m.guild_id) || null;
    const targetChannelId = fallbackMeta ? fallbackMeta.channel_id : null;

    const teamsMap = {};
    teamsRaw.forEach(t => {
        teamsMap[`${t.message_id}_${t.user_id}_${t.slot_time}`] = t.team;
    });

    const buckets = new Map();
    const skippedMessageIds = [];
    const usedFallbackForMessageIds = [];

    for (const s of signups) {
        if (slotTime && s.slot_time !== slotTime) continue;
        let meta = metaByMessageId.get(s.message_id);
        if (!meta || !meta.channel_id || !meta.guild_id) {
            if (fallbackMeta) {
                meta = fallbackMeta;
                usedFallbackForMessageIds.push(s.message_id);
            } else {
                skippedMessageIds.push(s.message_id);
                continue;
            }
        }

        const team = teamsMap[`${s.message_id}_${s.user_id}_${s.slot_time}`] || null;
        if (team !== 'A' && team !== 'B') continue;

        const bucketKey = s.slot_time;
        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, {
                guildId: meta.guild_id,
                day: meta.day || null,
                slotTime: s.slot_time,
                messageLinks: new Set(),
                teamA: new Set(),
                teamB: new Set()
            });
        }

        const bucket = buckets.get(bucketKey);
        bucket.messageLinks.add(`https://discord.com/channels/${meta.guild_id}/${meta.channel_id}/${s.message_id}`);
        if (team === 'A') bucket.teamA.add(s.user_id);
        if (team === 'B') bucket.teamB.add(s.user_id);
    }

    const uniqueSkipped = Array.from(new Set(skippedMessageIds));
    const uniqueFallback = Array.from(new Set(usedFallbackForMessageIds));

    let attempted = 0;
    let sent = 0;
    const errors = [];
    const details = [];

    if (!targetChannelId) {
        return {
            attempted,
            sent,
            skippedMessageIds: uniqueSkipped,
            usedFallbackForMessageIds: uniqueFallback,
            errors: [{ error: 'No channel metadata found for these messageIds' }],
            details
        };
    }

    for (const bucket of buckets.values()) {
        const teamAIds = Array.from(bucket.teamA);
        const teamBIds = Array.from(bucket.teamB);
        if (teamAIds.length === 0 && teamBIds.length === 0) continue;

        attempted += 1;

        const dayPart = bucket.day ? `${bucket.day} ` : '';
        const shouldPingTeamB = teamBIds.length >= 8;
        const shouldPingTeamA = teamAIds.length > 0;
        if (!shouldPingTeamA && !shouldPingTeamB) continue;

        const header = shouldPingTeamB
            ? `Hey! Team A and Team B — ${dayPart}${bucket.slotTime} match is about to start.`
            : `Hey! Team A — ${dayPart}${bucket.slotTime} match is about to start.`;
        const links = Array.from(bucket.messageLinks).slice(0, 3);
        const linksPart = links.length > 0 ? `\n${links.join('\n')}` : '';

        const payloads = [];

        const aChunks = shouldPingTeamA ? chunkMentions(`Team A (${teamAIds.length}):`, teamAIds, 1900) : [];
        const bChunks = shouldPingTeamB ? chunkMentions(`Team B (${teamBIds.length}):`, teamBIds, 1900) : [];

        if (!shouldPingTeamB) {
            const bLine = `Team B (${teamBIds.length}): not pinged (need 8+)`;
            if (aChunks.length > 0) {
                const aPayloads = aChunks.map((chunk, idx) => ({
                    content: `${header}\n${chunk}${idx === 0 ? `\n${bLine}${linksPart}` : ''}`,
                    userIds: teamAIds
                }));
                payloads.push(...aPayloads);
            } else {
                payloads.push({
                    content: `${header}\n${bLine}${linksPart}`,
                    userIds: []
                });
            }
        } else {
            if (aChunks.length === 1 && bChunks.length === 1) {
                const content = `${header}\n${aChunks[0]}\n${bChunks[0]}${linksPart}`;
                if (content.length <= 2000) {
                    payloads.push({ content, userIds: [...teamAIds, ...teamBIds] });
                }
            }

            if (payloads.length === 0) {
                const aPayloads = aChunks.map((chunk, idx) => ({
                    content: `${header}\n${chunk}${idx === 0 ? linksPart : ''}`,
                    userIds: teamAIds
                }));
                const bPayloads = bChunks.map((chunk, idx) => ({
                    content: `${header}\n${chunk}${idx === 0 && aPayloads.length === 0 ? linksPart : ''}`,
                    userIds: teamBIds
                }));
                payloads.push(...aPayloads, ...bPayloads);
            }
        }

        const detail = {
            channelId: targetChannelId,
            slotTime: bucket.slotTime,
            teamA: teamAIds.length,
            teamB: teamBIds.length,
            pingedB: shouldPingTeamB,
            plannedMessages: payloads.length,
            sentMessages: 0
        };

        try {
            const channel = await client.channels.fetch(targetChannelId);
            if (!channel || !channel.isTextBased()) {
                errors.push({ channelId: targetChannelId, slotTime: bucket.slotTime, error: 'Channel not text-based' });
                details.push(detail);
                continue;
            }

            for (const p of payloads) {
                const uniqueUserIds = Array.from(new Set(p.userIds || []));
                await channel.send({
                    content: p.content,
                    allowedMentions: { parse: [], users: uniqueUserIds }
                });
                sent += 1;
                detail.sentMessages += 1;
            }
            details.push(detail);
        } catch (e) {
            errors.push({ channelId: targetChannelId, slotTime: bucket.slotTime, error: e.message });
            details.push(detail);
        }
    }

    return { attempted, sent, skippedMessageIds: uniqueSkipped, usedFallbackForMessageIds: uniqueFallback, errors, details };
}

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/__health', (req, res) => {
    res.status(200).send('ok');
});

// Middleware
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Routes
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid password' });
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const stats = db.getAllStats();
        const configs = db.getAllConfigs();
        const signups = db.getAllSignups();
        const messages = db.getAllMessages(); // Fetch message metadata

        // Map message metadata
        const messageMap = new Map();
        messages.forEach(m => messageMap.set(m.message_id, m));
        
        // Fetch Game Stats
        const gameStats = db.getGameStats();
        const gameStatsMap = new Map();
        gameStats.forEach(gs => {
            gameStatsMap.set(gs.character_name, gs.games_played);
        });

        // Enrich Stats with Names and Game Counts
        const enrichmentPromises = stats.map(async s => {
            s.username = await resolveUser(s.user_id);
            s.guildName = await resolveGuild(s.guild_id);
            
            // Match with game stats using custom_name (priority) or username
            const lookupName = s.custom_name || s.username; // Note: Log file usually has character names, so custom_name is key
            s.games_played = gameStatsMap.get(lookupName) || 0;
        });
        
        await Promise.all(enrichmentPromises);

        // Group configs by guild
        const configsByGuild = {};
        for (const c of configs) {
            c.guildName = await resolveGuild(c.guild_id);
            if (!configsByGuild[c.guild_id]) configsByGuild[c.guild_id] = { name: c.guildName, configs: [] };
            configsByGuild[c.guild_id].configs.push(c);
        }

        const signupGroupsMap = {};
        for (const s of signups) {
            const meta = messageMap.get(s.message_id);
            const hasDay = meta && meta.day;
            const groupKey = hasDay ? `${meta.guild_id || ''}::${meta.day}` : `msg::${s.message_id}`;
            if (!signupGroupsMap[groupKey]) {
                signupGroupsMap[groupKey] = {
                    id: groupKey,
                    day: hasDay ? meta.day : 'Unknown Day',
                    guildId: hasDay ? (meta.guild_id || null) : null,
                    messageIds: [],
                    signups: []
                };
            }
            if (!signupGroupsMap[groupKey].messageIds.includes(s.message_id)) {
                signupGroupsMap[groupKey].messageIds.push(s.message_id);
            }
            signupGroupsMap[groupKey].signups.push(s);
        }

        const signupGroups = Object.values(signupGroupsMap).sort((a, b) => {
            const dayCmp = String(a.day).localeCompare(String(b.day));
            if (dayCmp !== 0) return dayCmp;
            return String(a.id).localeCompare(String(b.id));
        });

        // Create a map of custom_name -> signup count from stats table
        const signupCounts = new Map();
        stats.forEach(s => {
            if (s.custom_name) {
                const current = signupCounts.get(s.custom_name) || 0;
                signupCounts.set(s.custom_name, current + s.count);
            }
        });

        // Enrich gameStats with signup counts
        gameStats.forEach(gs => {
            gs.signup_count = signupCounts.get(gs.character_name) || 0;
        });

        res.render('dashboard', {
            user: 'Admin',
            stats: stats,
            gameStats: gameStats,
            configs: configsByGuild,
            signupGroups: signupGroups
        });
    } catch (err) {
        console.error("Dashboard error:", err);
        res.render('dashboard', { user: 'Admin', stats: [], gameStats: [], configs: {}, signupGroups: [] });
    }
});

app.post('/update-game-stats', requireAuth, (req, res) => {
    const filePath = path.join(__dirname, 'bdo_guild_match_log.txt');
    
    if (!fs.existsSync(filePath)) {
        return res.redirect('/dashboard?error=Log file not found in root directory');
    }
    
    const stats = parseLogFile(filePath);
    if (stats.length > 0) {
        db.updateGameStats(stats);
        res.redirect('/dashboard?success=Participation stats updated');
    } else {
        res.redirect('/dashboard?error=Failed to parse log file or empty');
    }
});

app.post('/api/player/rename', requireAuth, (req, res) => {
    const { userId, guildId, customName } = req.body;
    try {
        db.updateCustomName(userId, guildId, customName);
        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error updating name');
    }
});

app.post('/api/sync-stats', requireAuth, (req, res) => {
    try {
        db.syncStatsFromSignups();
        res.redirect('/dashboard?success=Stats synced from signups');
    } catch (e) {
        console.error(e);
        res.redirect('/dashboard?error=Failed to sync stats');
    }
});

app.get('/manage-teams', requireAuth, async (req, res) => {
    const messageIdsParam = typeof req.query.messageIds === 'string' ? req.query.messageIds : '';
    const messageIds = messageIdsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (messageIds.length === 0) return res.redirect('/dashboard');

    try {
        const signups = db.getSignupsForMessages(messageIds);
        const teamsRaw = db.getTeamsForMessages(messageIds);
        const messageMetas = messageIds.map(id => db.getMessage(id)).filter(Boolean);
        const days = Array.from(new Set(messageMetas.map(m => m.day).filter(Boolean)));

        const teamsMap = {};
        teamsRaw.forEach(t => {
            teamsMap[`${t.message_id}_${t.user_id}_${t.slot_time}`] = t.team;
        });

        const slots = {};

        const allStats = db.getAllStats();
        const customNameMap = {};
        allStats.forEach(stat => {
            if (stat.custom_name) {
                customNameMap[stat.user_id] = stat.custom_name;
            }
        });

        for (const s of signups) {
            s.username = await resolveUser(s.user_id);
            s.customName = customNameMap[s.user_id] || null;

            if (!slots[s.slot_time]) slots[s.slot_time] = [];
            s.team = teamsMap[`${s.message_id}_${s.user_id}_${s.slot_time}`] || null;
            slots[s.slot_time].push(s);
        }

        res.render('manage_teams', {
            messageId: messageIds.join(','),
            messageIds,
            messageKey: messageIds.join(','),
            day: days.length > 0 ? days.join(' / ') : 'Unknown',
            slots: slots
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading team management');
    }
});

app.get('/manage-teams/:messageId', requireAuth, async (req, res) => {
    const { messageId } = req.params;
    try {
        const signups = db.getSignups(messageId);
        const teamsRaw = db.getTeams(messageId);
        const message = db.getMessage(messageId);

        const teamsMap = {};
        teamsRaw.forEach(t => {
            teamsMap[`${t.user_id}_${t.slot_time}`] = t.team;
        });

        // Group signups by slot_time
        const slots = {};

        // Pre-fetch all stats for custom name lookup (handles old posts without message metadata)
        const allStats = db.getAllStats();
        const customNameMap = {};
        allStats.forEach(stat => {
            if (stat.custom_name) {
                customNameMap[stat.user_id] = stat.custom_name;
            }
        });

        for (const s of signups) {
            s.username = await resolveUser(s.user_id);

            // Get custom name from preloaded map
            s.customName = customNameMap[s.user_id] || null;

            if (!slots[s.slot_time]) slots[s.slot_time] = [];
            s.team = teamsMap[`${s.user_id}_${s.slot_time}`] || null;
            slots[s.slot_time].push(s);
        }

        res.render('manage_teams', {
            messageId,
            messageIds: [messageId],
            messageKey: messageId,
            day: message ? message.day : 'Unknown',
            slots: slots
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading team management');
    }
});

app.post('/api/teams/update', requireAuth, (req, res) => {
    const { messageId, userId, slotTime, team } = req.body;
    try {
        db.setTeam(messageId, userId, slotTime, team);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remind-teams', requireAuth, async (req, res) => {
    const bodyMessageIds = Array.isArray(req.body.messageIds) ? req.body.messageIds : null;
    const messageIdsParam = typeof req.body.messageIds === 'string' ? req.body.messageIds : '';
    const messageIds = (bodyMessageIds || messageIdsParam.split(',')).map(s => String(s).trim()).filter(Boolean);
    const slotTime = typeof req.body.slotTime === 'string' ? req.body.slotTime.trim() : null;

    if (messageIds.length === 0) return res.status(400).json({ error: 'Missing messageIds' });
    if (!client.isReady()) return res.status(503).json({ error: 'Discord client not ready' });

    try {
        const result = await sendTeamRemindersToChannels({ messageIds, slotTime });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/signup/delete', requireAuth, (req, res) => {
    const { messageId } = req.body;
    try {
        db.deleteMessage(messageId);
        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error deleting signup');
    }
});

app.post('/api/signup-group/delete', requireAuth, (req, res) => {
    const messageIdsParam = typeof req.body.messageIds === 'string' ? req.body.messageIds : '';
    const messageIds = messageIdsParam.split(',').map(s => s.trim()).filter(Boolean);
    try {
        db.deleteMessages(messageIds);
        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error deleting signup');
    }
});

app.post('/api/signup/rename', requireAuth, (req, res) => {
    const { messageId, dayName } = req.body;
    try {
        // Insert or update message entry
        const existing = db.getMessage(messageId);
        if (existing) {
            db.updateMessageDay(messageId, dayName);
        } else {
            // Create new entry for old posts without metadata
            db.saveMessage(messageId, '', '', dayName);
        }
        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error renaming day');
    }
});

app.post('/api/signup-group/rename', requireAuth, (req, res) => {
    const messageIdsParam = typeof req.body.messageIds === 'string' ? req.body.messageIds : '';
    const messageIds = messageIdsParam.split(',').map(s => s.trim()).filter(Boolean);
    const dayName = req.body.dayName;
    try {
        db.updateMessageDays(messageIds, dayName);
        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error renaming day');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Start Client and Server
client.login(process.env.DISCORD_TOKEN).then(() => {
    console.log('Dashboard Client Logged In');
    app.listen(PORT, () => {
        console.log(`Dashboard running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to login to Discord:', err);
    // Start server anyway so admin can see errors
    app.listen(PORT, () => {
        console.log(`Dashboard running (without Discord) on http://localhost:${PORT}`);
    });
});
