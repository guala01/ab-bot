const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const db = require('../db');

// Build the formatted embed for nodewar signups
// nameOverrides is an optional Map of userId -> displayName
const buildNodewarEmbed = (day, maxCap, signups, nameOverrides) => {
    const overrides = nameOverrides || new Map();
    const signed = signups.filter(s => s.status === 'signed');
    const waitlist = signups.filter(s => s.status === 'waitlist');

    const resolveName = (s) => overrides.get(s.user_id) || s.user_display_name || 'Unknown';

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ Node War — ${day}`)
        .setColor(0xE74C3C);

    // Build signed up players list
    let signedList = '';
    if (signed.length === 0) {
        signedList = '```\nNo signups yet\n```';
    } else {
        signedList = '```ansi\n';
        signed.forEach((s, idx) => {
            const num = (idx + 1).toString().padStart(2, ' ');
            const name = resolveName(s).substring(0, 18).padEnd(18, ' ');
            signedList += `${num}. ${name}\n`;
        });
        signedList += '```';
    }

    embed.addFields({
        name: `✅ Signed Up (${signed.length}/${maxCap})`,
        value: signedList,
        inline: false
    });

    // Build waitlist if any
    if (waitlist.length > 0) {
        let waitlistText = '```ansi\n';
        waitlist.forEach((s, idx) => {
            const num = (idx + 1).toString().padStart(2, ' ');
            const name = resolveName(s).substring(0, 18).padEnd(18, ' ');
            waitlistText += `${num}. ${name}\n`;
        });
        waitlistText += '```';

        embed.addFields({
            name: `⏳ Waiting List (${waitlist.length})`,
            value: waitlistText,
            inline: false
        });
    }

    // Footer with info
    const spotsLeft = Math.max(0, maxCap - signed.length);
    embed.setFooter({ 
        text: spotsLeft > 0 
            ? `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} remaining` 
            : 'Roster full — new signups go to waitlist'
    });
    embed.setTimestamp();

    return embed;
};

// Build the action buttons
const buildNodewarButtons = () => {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('nodewar_signup')
                .setLabel('Sign Up')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId('nodewar_leave')
                .setLabel('Leave')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );
    return [row];
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('post_nodewar')
        .setDescription('Post a Node War signup for today')
        .addStringOption(option =>
            option.setName('day')
                .setDescription('Day/title for this signup (e.g., "Monday 02/03")')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('max')
                .setDescription('Maximum number of players (default: 100)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(200)),

    async execute(interaction) {
        const day = interaction.options.getString('day');
        const maxCap = interaction.options.getInteger('max') || 100;

        const embed = buildNodewarEmbed(day, maxCap, []);
        const buttons = buildNodewarButtons();

        const message = await interaction.reply({ 
            embeds: [embed], 
            components: buttons, 
            fetchReply: true 
        });

        // Save to database
        try {
            db.saveNodewarMessage(message.id, interaction.guildId, interaction.channelId, day, maxCap);
        } catch (e) {
            console.error('Failed to save nodewar message metadata:', e);
        }
    },

    // Export helper for use in index.js
    buildNodewarEmbed,
    buildNodewarButtons
};
