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
const TEAM_A_VOICE_ID = '1002272934078992446';
const TEAM_B_VOICE_ID = '1354148290731577417';

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
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

function parseSignupCustomId(customId) {
    const parts = String(customId || '').split('_');
    if (parts[0] !== 'signup') return null;
    if (parts.length >= 3) return { teamMode: parts[1], timeSlot: parts.slice(2).join('_') };
    if (parts.length >= 2) return { teamMode: 'M', timeSlot: parts.slice(1).join('_') };
    return null;
}

function inferTeamModeFromDiscordMessage(message) {
    const rows = message && message.components ? message.components : [];
    for (const row of rows) {
        const comps = row && row.components ? row.components : [];
        for (const c of comps) {
            if (!c || !c.customId) continue;
            if (!String(c.customId).startsWith('signup_')) continue;
            const parsed = parseSignupCustomId(c.customId);
            if (parsed && (parsed.teamMode === 'A' || parsed.teamMode === 'B')) return parsed.teamMode;
        }
    }

    const title = message && message.embeds && message.embeds[0] && message.embeds[0].title ? String(message.embeds[0].title) : '';
    if (/team\s*a/i.test(title)) return 'A';
    if (/team\s*b/i.test(title)) return 'B';
    return null;
}

async function getSignupTeamModeForMessage(meta) {
    if (!meta || !meta.channel_id || !meta.message_id) return null;
    try {
        const channel = await client.channels.fetch(meta.channel_id);
        if (!channel || !channel.isTextBased()) return null;
        const message = await channel.messages.fetch(meta.message_id);
        return inferTeamModeFromDiscordMessage(message);
    } catch {
        return null;
    }
}

async function sendTeamRemindersToChannels({ messageIds, slotTime, checkOnly = false }) {
    const signups = db.getSignupsForMessages(messageIds);
    const teamsRaw = db.getTeamsForMessages(messageIds);
    const messageMetas = messageIds.map(id => db.getMessage(id)).filter(Boolean);

    const metaByMessageId = new Map();
    for (const m of messageMetas) metaByMessageId.set(m.message_id, m);
    const fallbackMeta = messageMetas.find(m => m && m.channel_id && m.guild_id) || null;
    const fallbackChannelId = fallbackMeta ? fallbackMeta.channel_id : null;

    const teamsMap = {};
    teamsRaw.forEach(t => {
        teamsMap[`${t.message_id}_${t.user_id}_${t.slot_time}`] = t.team;
    });

    const buckets = new Map();
    const skippedMessageIds = [];
    const usedFallbackForMessageIds = [];

    const teamModeByMessageId = new Map();
    const metasWithChannel = messageMetas.filter(m => m && m.channel_id && m.guild_id);
    for (const meta of metasWithChannel) {
        const mode = await getSignupTeamModeForMessage(meta);
        if (mode) teamModeByMessageId.set(meta.message_id, mode);
    }

    const teamAMeta = metasWithChannel.find(m => teamModeByMessageId.get(m.message_id) === 'A') || null;
    const teamBMeta = metasWithChannel.find(m => teamModeByMessageId.get(m.message_id) === 'B') || null;
    const teamAChannelId = (teamAMeta && teamAMeta.channel_id) || fallbackChannelId || null;
    const teamBChannelId = (teamBMeta && teamBMeta.channel_id) || fallbackChannelId || null;

    const teamALinks = [];
    const teamBLinks = [];
    metasWithChannel.forEach(m => {
        const mode = teamModeByMessageId.get(m.message_id);
        const link = `https://discord.com/channels/${m.guild_id}/${m.channel_id}/${m.message_id}`;
        if (mode === 'A') teamALinks.push(link);
        if (mode === 'B') teamBLinks.push(link);
    });

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
                day: meta.day || null,
                slotTime: s.slot_time,
                teamA: new Set(),
                teamB: new Set()
            });
        }

        const bucket = buckets.get(bucketKey);
        if (team === 'A') bucket.teamA.add(s.user_id);
        if (team === 'B') bucket.teamB.add(s.user_id);
    }

    const uniqueSkipped = Array.from(new Set(skippedMessageIds));
    const uniqueFallback = Array.from(new Set(usedFallbackForMessageIds));

    let attempted = 0;
    let sent = 0;
    const errors = [];
    const details = [];

    if (!teamAChannelId && !teamBChannelId) {
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
        const shouldPingTeamA = teamAIds.length > 0;
        const shouldPingTeamB = teamBIds.length >= 8;
        if (!shouldPingTeamA && !shouldPingTeamB) continue;

        if (checkOnly) {
            const missingVoiceUsers = [];
            // Use the guild from the available channel metadata
            const anyMeta = metasWithChannel.find(m => m.guild_id) || messageMetas.find(m => m.guild_id);
            const guildId = anyMeta ? anyMeta.guild_id : null;

            if (guildId) {
                try {
                    const guild = await client.guilds.fetch(guildId);

                    // Check Team A
                    for (const userId of teamAIds) {
                        try {
                            const member = await guild.members.fetch(userId);
                            if (member.voice.channelId !== TEAM_A_VOICE_ID) {
                                missingVoiceUsers.push({ userId, name: member.displayName, team: 'A' });
                            }
                        } catch (e) {
                            missingVoiceUsers.push({ userId, name: 'Unknown User', team: 'A' });
                        }
                    }

                    // Check Team B
                    for (const userId of teamBIds) {
                        try {
                            const member = await guild.members.fetch(userId);
                            if (member.voice.channelId !== TEAM_B_VOICE_ID) {
                                missingVoiceUsers.push({ userId, name: member.displayName, team: 'B' });
                            }
                        } catch (e) {
                            missingVoiceUsers.push({ userId, name: 'Unknown User', team: 'B' });
                        }
                    }
                } catch (e) {
                    console.error("Failed to fetch guild for voice check", e);
                }
            }

            if (missingVoiceUsers.length > 0) {
                return { checkOnly: true, missingUsers: missingVoiceUsers };
            } else {
                // If no missing users, return success for this check (but loop continues? No, usually checkOnly is per request.
                // If we have multiple buckets, we should accumulate or just return checking passed. 
                // For now, let's assume we want to check ALL buckets.
                // Actually, if we are here and passed, we continue to next bucket?
                // But wait, the function returns an object.
                // If checkOnly is true, we don't want to actually send messages.
                continue;
            }
        }

        const detail = {
            slotTime: bucket.slotTime,
            teamA: teamAIds.length,
            teamB: teamBIds.length,
            pingedB: shouldPingTeamB,
            channelAId: teamAChannelId,
            channelBId: teamBChannelId,
            plannedMessagesA: 0,
            plannedMessagesB: 0,
            sentMessagesA: 0,
            sentMessagesB: 0
        };

        if (shouldPingTeamA && teamAChannelId) {
            const headerA = `Hey! Team A — ${dayPart}${bucket.slotTime} match is about to start.`;
            const bInfo = shouldPingTeamB ? `Team B (${teamBIds.length})` : `Team B (${teamBIds.length}): not pinged (need 8+)`;
            const linksPartA = teamALinks.length > 0 ? `\n${teamALinks.slice(0, 3).join('\n')}` : '';
            const aChunks = chunkMentions(`Team A (${teamAIds.length}):`, teamAIds, 1900);
            const payloadsA = aChunks.map((chunk, idx) => ({
                content: `${headerA}\n${chunk}${idx === 0 ? `\n${bInfo}${linksPartA}` : ''}`,
                userIds: teamAIds
            }));
            detail.plannedMessagesA = payloadsA.length;

            try {
                const channelA = await client.channels.fetch(teamAChannelId);
                if (channelA && channelA.isTextBased()) {
                    for (const p of payloadsA) {
                        const uniqueUserIds = Array.from(new Set(p.userIds || []));
                        await channelA.send({ content: p.content, allowedMentions: { parse: [], users: uniqueUserIds } });
                        sent += 1;
                        detail.sentMessagesA += 1;
                    }
                } else {
                    errors.push({ channelId: teamAChannelId, slotTime: bucket.slotTime, error: 'Team A channel not text-based' });
                }
            } catch (e) {
                errors.push({ channelId: teamAChannelId, slotTime: bucket.slotTime, error: e.message });
            }
        }

        if (shouldPingTeamB && teamBChannelId) {
            const headerB = `Hey! Team B — ${dayPart}${bucket.slotTime} match is about to start.`;
            const linksPartB = teamBLinks.length > 0 ? `\n${teamBLinks.slice(0, 3).join('\n')}` : '';
            const bChunks = chunkMentions(`Team B (${teamBIds.length}):`, teamBIds, 1900);
            const payloadsB = bChunks.map((chunk, idx) => ({
                content: `${headerB}\n${chunk}${idx === 0 ? linksPartB : ''}`,
                userIds: teamBIds
            }));
            detail.plannedMessagesB = payloadsB.length;

            try {
                const channelB = await client.channels.fetch(teamBChannelId);
                if (channelB && channelB.isTextBased()) {
                    for (const p of payloadsB) {
                        const uniqueUserIds = Array.from(new Set(p.userIds || []));
                        await channelB.send({ content: p.content, allowedMentions: { parse: [], users: uniqueUserIds } });
                        sent += 1;
                        detail.sentMessagesB += 1;
                    }
                } else {
                    errors.push({ channelId: teamBChannelId, slotTime: bucket.slotTime, error: 'Team B channel not text-based' });
                }
            } catch (e) {
                errors.push({ channelId: teamBChannelId, slotTime: bucket.slotTime, error: e.message });
            }
        }

        details.push(detail);
    }

    if (checkOnly) {
        // If we reached here in checkOnly mode, it means no missing users were returned early (or we should have collected them).
        // My previous logic was: "if missing, return".
        // If we have multiple buckets, we might miss some if we return early.
        // But collecting them is safer. 
        // Let's refine the checkOnly logic in the loop:
        // Actually, the loop above returns immediately if missing users found.
        // So if we exit the loop, it means ALL buckets passed the check.
        return { checkOnly: true, missingUsers: [] };
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
    const checkOnly = !!req.body.checkOnly;

    if (messageIds.length === 0) return res.status(400).json({ error: 'Missing messageIds' });
    if (!client.isReady()) return res.status(503).json({ error: 'Discord client not ready' });

    try {
        const result = await sendTeamRemindersToChannels({ messageIds, slotTime, checkOnly });
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
