const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('post_signup')
        .setDescription('Post the signup message for a specific day')
        .addStringOption(option =>
            option.setName('day')
                .setDescription('Day of the week to post signups for')
                .setRequired(true)),
    async execute(interaction) {
        const day = interaction.options.getString('day');
        const config = db.getConfig(interaction.guildId, day);

        if (!config) {
            return interaction.reply({ content: `No configuration found for **${day}**. Please use /setup_league first.`, ephemeral: true });
        }

        const ranges = JSON.parse(config.ranges);
        const slots = [];

        // Helper to convert time string to minutes
        const toMinutes = (timeStr) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        // Helper to convert minutes to time string
        const toTimeStr = (minutes) => {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        };

        // Generate slots (30m interval)
        for (const range of ranges) {
            let current = toMinutes(range.start);
            let end = toMinutes(range.end);

            // Handle overnight ranges (e.g. 22:00-01:00)
            if (end < current) {
                end += 24 * 60;
            }

            while (current <= end) { // Inclusive end time as per user request
                // Normalize minutes for display (handle > 24h)
                const displayMinutes = current % (24 * 60);
                slots.push(toTimeStr(displayMinutes));
                current += 30;
            }
        }

        // Create Embed
        const embed = new EmbedBuilder()
            .setTitle(`Guild League Signups - ${day}`)
            .setDescription(`Click the buttons below to sign up for specific time slots.\nTimes are in server time (or configured timezone).`)
            .setColor(0x0099FF);

        // Add initial fields (empty)
        for (const slot of slots) {
            embed.addFields({ name: `🫄🏿 ${slot}`, value: '-', inline: true });
        }

        // Create Buttons (max 5 per row, max 5 rows = 25 buttons max)
        // If more than 25 slots, we might need multiple messages or limit it.
        // Assuming reasonable number of slots for now.
        const rows = [];
        let currentRow = new ActionRowBuilder();

        for (const slot of slots) {
            if (currentRow.components.length >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
            }
            currentRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`signup_${slot}`)
                    .setLabel(slot)
                    .setStyle(ButtonStyle.Primary)
            );
        }
        if (currentRow.components.length > 0) {
            rows.push(currentRow);
        }

        if (rows.length > 5) {
            return interaction.reply({ content: `Too many slots generated (${slots.length}). Discord limits buttons to 25. Please reduce the range.`, ephemeral: true });
        }

        await interaction.reply({ embeds: [embed], components: rows });
    },
};
