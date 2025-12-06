const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('league_stats')
        .setDescription('View signup statistics'),
    async execute(interaction) {
        const stats = db.getStats(interaction.guildId);

        const embed = new EmbedBuilder()
            .setTitle('Guild League Participation Leaderboard')
            .setColor(0xFFD700);

        if (stats.length === 0) {
            embed.setDescription('No stats recorded yet.');
        } else {
            // Top 10
            const top10 = stats.slice(0, 10);
            let description = '';
            top10.forEach((stat, index) => {
                description += `${index + 1}. <@${stat.user_id}> - **${stat.count}** signups\n`;
            });
            embed.setDescription(description);
        }

        await interaction.reply({ embeds: [embed] });
    },
};
