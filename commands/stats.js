const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

// Class icons mapping (using Discord emoji or Unicode)
const CLASS_ICONS = {
    'Musa': '◆',
    'Zerk': '◆',
    'Mystic': '◆',
    'Striker': '◆',
    'Seraph': '◆',
    'Dosa': '◆',
    'Woosa': '◆',
    'Shai': '◆',
    'default': '◆'
};

// Tier colors (based on signup count thresholds)
const getTierIndicator = (count) => {
    if (count >= 50) return '🟡'; // Gold tier
    if (count >= 30) return '🟠'; // Orange tier  
    if (count >= 15) return '🔵'; // Blue tier
    if (count >= 5) return '🟢';  // Green tier
    return '⚪'; // Default
};

// Pad string to fixed width for alignment
const padEnd = (str, len) => {
    const strLen = [...str].length; // Handle unicode properly
    if (strLen >= len) return str;
    return str + ' '.repeat(len - strLen);
};

const padStart = (str, len) => {
    const strLen = [...str].length;
    if (strLen >= len) return str;
    return ' '.repeat(len - strLen) + str;
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('league_stats')
        .setDescription('View signup statistics'),
    async execute(interaction) {
        const stats = db.getStats(interaction.guildId);

        if (stats.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('Guild League Participation')
                .setDescription('No stats recorded yet.')
                .setColor(0x2F3136);
            return interaction.reply({ embeds: [embed] });
        }

        // Calculate total signups
        const totalSignups = stats.reduce((sum, s) => sum + s.count, 0);
        const playerCount = stats.length;

        const embed = new EmbedBuilder()
            .setTitle(`Guild League (${playerCount}) | Total: ${totalSignups}`)
            .setColor(0xE74C3C); // Red color like in the image

        // Build formatted player list
        let description = '```ansi\n';
        
        // Show top 15 players
        const topPlayers = stats.slice(0, 15);
        
        topPlayers.forEach((stat, index) => {
            const displayName = stat.custom_name || `User`;
            const count = stat.count.toString();
            const tier = getTierIndicator(stat.count);
            
            // Format: <Guild> Name      Count  [ ◆ Class]  ●
            // Using fixed widths for alignment
            const nameDisplay = padEnd(displayName.substring(0, 14), 14);
            const countDisplay = padStart(count, 4);
            
            description += `${nameDisplay} ${countDisplay}  ${tier}\n`;
        });
        
        description += '```';

        // Add legend
        description += '\n**Tier Legend:**\n';
        description += '🟡 50+ | 🟠 30+ | 🔵 15+ | 🟢 5+ | ⚪ <5';

        embed.setDescription(description);
        
        // Add footer with last updated info
        embed.setFooter({ text: 'Signup participation leaderboard' });
        embed.setTimestamp();

        await interaction.reply({ embeds: [embed] });
    },
};
