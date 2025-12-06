const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');

const dbPath = path.join(__dirname, '..', 'league.db');
const db = new Database(dbPath);

const args = process.argv.slice(2);
const force = args.includes('--force');
const guildArgIndex = args.indexOf('--guild');
let guildId = null;

if (guildArgIndex !== -1 && args[guildArgIndex + 1]) {
    guildId = args[guildArgIndex + 1];
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function resetStats() {
    try {
        if (guildId) {
            const info = db.prepare('DELETE FROM stats WHERE guild_id = ?').run(guildId);
            console.log(`Deleted ${info.changes} stats entries for guild ${guildId}.`);
        } else {
            const info = db.prepare('DELETE FROM stats').run();
            console.log(`Deleted ${info.changes} stats entries (ALL guilds).`);
        }
    } catch (err) {
        console.error('Error resetting stats:', err);
    } finally {
        db.close();
        process.exit(0);
    }
}

if (force) {
    resetStats();
} else {
    const scope = guildId ? `guild ${guildId}` : 'ALL guilds';
    rl.question(`WARNING: This will permanently delete stats for ${scope}. Are you sure? (y/N) `, (answer) => {
        if (answer.toLowerCase() === 'y') {
            resetStats();
        } else {
            console.log('Operation cancelled.');
            db.close();
            process.exit(0);
        }
    });
}
