const db = require('./db');
const stats = db.getAllStats();
console.log("Top Users by Signup Count:");
stats.forEach(s => {
    console.log(`User ID: ${s.user_id} | Count: ${s.count} | Last Seen: ${s.last_seen}`);
});
