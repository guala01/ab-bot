const db = require('./db');

// Map of UserID -> Amount to reduce
const reductions = {
    '198667639373955073': 20,
    '269197430594076673': 20
};

const allStats = db.getAllStats();

console.log("Applying corrections...");

allStats.forEach(stat => {
    if (reductions[stat.user_id]) {
        const reduction = reductions[stat.user_id];
        const newCount = Math.max(0, stat.count - reduction);
        console.log(`Updating User ${stat.user_id} (Guild: ${stat.guild_id}): ${stat.count} -> ${newCount}`);
        db.setStatCount(stat.user_id, stat.guild_id, newCount);
    }
});

console.log("Corrections applied.");
