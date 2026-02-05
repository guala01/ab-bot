const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('edit_nodewar')
        .setDescription('Edit the max signup cap for an active Node War post')
        .addStringOption(option =>
            option.setName('message_id')
                .setDescription('The message ID of the nodewar post')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('max')
                .setDescription('New maximum number of players')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(200))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const messageId = interaction.options.getString('message_id').trim();
        const newMax = interaction.options.getInteger('max');

        const meta = db.getNodewarMessage(messageId);
        if (!meta) {
            return interaction.reply({ content: '❌ No Node War signup found with that message ID.', flags: 64 });
        }

        const oldMax = meta.max_cap;
        const result = db.updateNodewarCap(messageId, newMax);

        // Refresh the embed on Discord
        try {
            const channel = await interaction.client.channels.fetch(meta.channel_id);
            if (channel && channel.isTextBased()) {
                const msg = await channel.messages.fetch(messageId);
                const { buildNodewarEmbed } = require('./nodewar');
                const signups = db.getNodewarSignups(messageId);
                const userIds = signups.map(s => s.user_id);
                const overridesRaw = meta.guild_id ? db.getNameOverridesForUsers(userIds, meta.guild_id) : [];
                const nameOverrides = new Map(overridesRaw.map(o => [o.user_id, o.display_name]));
                const newEmbed = buildNodewarEmbed(meta.day, newMax, signups, nameOverrides);
                await msg.edit({ embeds: [newEmbed] });
            }
        } catch (e) {
            console.error('Failed to refresh nodewar embed after cap change:', e.message);
        }

        let response = `✅ **${meta.day}** cap updated: **${oldMax}** → **${newMax}**`;
        if (result.demoted) {
            response += `\n⚠️ ${result.demoted} player${result.demoted !== 1 ? 's' : ''} moved to the waiting list.`;
        }
        if (result.promoted) {
            response += `\n🎉 ${result.promoted} player${result.promoted !== 1 ? 's' : ''} promoted from the waiting list.`;
        }

        return interaction.reply({ content: response, flags: 64 });
    },
};
