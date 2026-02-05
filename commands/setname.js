const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_name')
        .setDescription('Set a display name override for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The Discord user to rename')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('name')
                .setDescription('The display name to use (leave empty to remove override)')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const targetUser = interaction.options.getUser('user');
        const newName = interaction.options.getString('name');
        const guildId = interaction.guildId;

        if (!newName || newName.trim() === '') {
            // Remove override
            db.removeNameOverride(targetUser.id, guildId);
            return interaction.reply({
                content: `✅ Removed name override for <@${targetUser.id}>. They will show as **${targetUser.username}**.`,
                flags: 64
            });
        }

        const trimmedName = newName.trim().substring(0, 20);
        db.setNameOverride(targetUser.id, guildId, trimmedName);

        return interaction.reply({
            content: `✅ <@${targetUser.id}> will now display as **${trimmedName}** in signups.`,
            flags: 64
        });
    },
};
