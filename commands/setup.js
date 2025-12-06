const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup_league')
        .setDescription('Configure the guild league schedule')
        .addStringOption(option =>
            option.setName('day')
                .setDescription('Day of the week (e.g., Sunday)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('ranges')
                .setDescription('Time ranges (e.g., "18:00-19:30, 21:30-22:30")')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const day = interaction.options.getString('day');
        const rangesRaw = interaction.options.getString('ranges');

        // Validate ranges
        // Expected format: "HH:mm-HH:mm, HH:mm-HH:mm"
        const rangeParts = rangesRaw.split(',').map(s => s.trim());
        const validRanges = [];
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

        for (const part of rangeParts) {
            const times = part.split('-');
            if (times.length !== 2) {
                return interaction.reply({ content: `Invalid range format: ${part}. Use "HH:mm-HH:mm"`, flags: 64 });
            }
            const start = times[0].trim();
            const end = times[1].trim();

            if (!timeRegex.test(start) || !timeRegex.test(end)) {
                return interaction.reply({ content: `Invalid time format in range: ${part}. Use HH:mm (24h)`, flags: 64 });
            }

            validRanges.push({ start, end });
        }

        // Save to DB
        try {
            db.saveConfig(interaction.guildId, day, JSON.stringify(validRanges));
            await interaction.reply({ content: `Configuration saved for **${day}** with ranges: ${rangesRaw}`, flags: 64 });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'Failed to save configuration.', flags: 64 });
        }
    },
};
