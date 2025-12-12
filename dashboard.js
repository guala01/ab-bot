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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
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

        // Group Signups by Message
        const signupsByMessage = {};
        for (const s of signups) {
            const key = s.message_id;
            if (!signupsByMessage[key]) {
                signupsByMessage[key] = {
                    id: key,
                    day: messageMap.has(key) ? messageMap.get(key).day : 'Unknown Day',
                    signups: []
                };
            }
            signupsByMessage[key].signups.push(s);
        }

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
            signups: signupsByMessage
        });
    } catch (err) {
        console.error("Dashboard error:", err);
        res.render('dashboard', { user: 'Admin', stats: [], gameStats: [], configs: {}, signups: {} });
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
