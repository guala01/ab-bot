require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

client.commands = new Collection();

const buildSignupEmbedFromMessage = (message, messageId) => {
    const rows = message.components || [];
    let allSlots = [];
    let embedTeamMode = null;
    rows.forEach(row => {
        row.components.forEach(component => {
            if (component.customId && component.customId.startsWith('signup_')) {
                const p = parseSignupCustomId(component.customId);
                if (!p) return;
                if (!embedTeamMode) embedTeamMode = p.teamMode;
                allSlots.push(p.timeSlot);
            }
        });
    });

    const updatedSignups = db.getSignups(messageId);
    const signupsBySlot = {};
    allSlots.forEach(slot => signupsBySlot[slot] = []);
    updatedSignups.forEach(s => {
        if (signupsBySlot[s.slot_time]) signupsBySlot[s.slot_time].push(s.user_display_name);
    });

    const existing = message.embeds && message.embeds[0] ? message.embeds[0] : null;
    const newEmbed = existing ? EmbedBuilder.from(existing) : new EmbedBuilder();
    newEmbed.setFields([]);

    const fieldPrefix = embedTeamMode === 'B' ? '🟩 Team B •' : embedTeamMode === 'A' ? '🟥 Team A •' : '🫄🏿';
    for (const slot of allSlots) {
        const users = signupsBySlot[slot] || [];
        const value = users.length > 0 ? users.join(', ') : '-';
        newEmbed.addFields({ name: `${fieldPrefix} ${slot} (${users.length})`, value: value, inline: true });
    }

    return newEmbed;
};

const refreshSignupMessages = async (messageIds) => {
    const uniqueMessageIds = Array.from(new Set((messageIds || []).map(String).filter(Boolean)));
    for (const mid of uniqueMessageIds) {
        try {
            const meta = db.getMessage(mid);
            if (!meta || !meta.channel_id) continue;
            const channel = await client.channels.fetch(meta.channel_id);
            if (!channel || !channel.isTextBased()) continue;
            const msg = await channel.messages.fetch(mid);
            const embed = buildSignupEmbedFromMessage(msg, mid);
            await msg.edit({ embeds: [embed] });
        } catch (e) {
            console.error(`Failed to refresh signup message ${mid}:`, e.message);
        }
    }
};

// Load commands
const commandsPath = path.join(__dirname, 'commands');
// Ensure commands directory exists
if (!fs.existsSync(commandsPath)) {
    fs.mkdirSync(commandsPath);
}

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
});

const parseSignupCustomId = (customId) => {
    const parts = customId.split('_');
    if (parts[0] !== 'signup') return null;
    if (parts.length >= 3) {
        return { teamMode: parts[1], timeSlot: parts.slice(2).join('_') };
    }
    if (parts.length >= 2) {
        return { teamMode: 'M', timeSlot: parts.slice(1).join('_') };
    }
    return null;
};

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error executing this command!', flags: 64 });
            } else {
                await interaction.reply({ content: 'There was an error executing this command!', flags: 64 });
            }
        }
    } else if (interaction.isButton()) {
        try {
            // Handle signup buttons
            if (interaction.customId.startsWith('signup_')) {
                const parsed = parseSignupCustomId(interaction.customId);
                if (!parsed) return;

                const { teamMode, timeSlot } = parsed;
                const messageId = interaction.message.id;
                const userId = interaction.user.id;
                const displayName = interaction.user.username;

                // Check if user is already signed up for this slot
                const signups = db.getSignups(messageId);
                const isSignedUp = signups.some(s => s.user_id === userId && s.slot_time === timeSlot);

                // Acknowledge interaction without sending a message
                await interaction.deferUpdate();

                if (isSignedUp) {
                    db.removeSignup(messageId, userId, timeSlot);
                    db.removeTeam(messageId, userId, timeSlot);
                    db.decrementStat(userId, interaction.guildId);
                } else {
                    const meta = db.getMessage(messageId);
                    let relatedMessageIds = [messageId];
                    if (meta && meta.guild_id && meta.day) {
                        const related = db.getMessagesByGuildDay(meta.guild_id, meta.day);
                        relatedMessageIds = Array.from(new Set([messageId, ...related.map(r => r.message_id)]));
                    }

                    const existingAcrossGroup = db.getUserSignupsForMessagesSlot(relatedMessageIds, userId, timeSlot);
                    const removedFrom = [];
                    existingAcrossGroup.forEach(su => {
                        if (su.message_id !== messageId) {
                            db.removeSignup(su.message_id, userId, timeSlot);
                            db.removeTeam(su.message_id, userId, timeSlot);
                            db.decrementStat(userId, interaction.guildId);
                            removedFrom.push(su.message_id);
                        }
                    });

                    db.addSignup(messageId, userId, timeSlot, displayName);
                    if (teamMode === 'A' || teamMode === 'B') {
                        db.setTeam(messageId, userId, timeSlot, teamMode);
                    }
                    // Increment stats on signup (simple approach, or could be done when event closes)
                    db.incrementStat(userId, interaction.guildId);

                    if (removedFrom.length > 0) {
                        await refreshSignupMessages(removedFrom);
                    }
                }

                // Update the embed
                const updatedSignups = db.getSignups(messageId);

                // Reconstruct the embed fields
                const rows = interaction.message.components;
                let allSlots = [];
                let embedTeamMode = null;
                rows.forEach(row => {
                    row.components.forEach(component => {
                        if (component.customId && component.customId.startsWith('signup_')) {
                            const p = parseSignupCustomId(component.customId);
                            if (!p) return;
                            if (!embedTeamMode) embedTeamMode = p.teamMode;
                            allSlots.push(p.timeSlot);
                        }
                    });
                });

                // Group signups by slot
                const signupsBySlot = {};
                allSlots.forEach(slot => signupsBySlot[slot] = []);
                updatedSignups.forEach(s => {
                    if (signupsBySlot[s.slot_time]) {
                        signupsBySlot[s.slot_time].push(s.user_display_name);
                    }
                });

                const newEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
                newEmbed.setFields([]); // Clear existing fields

                // Add fields for each slot
                const fieldPrefix = embedTeamMode === 'B' ? '🟩 Team B •' : embedTeamMode === 'A' ? '🟥 Team A •' : '🫄🏿';
                for (const slot of allSlots) {
                    const users = signupsBySlot[slot] || [];
                    const value = users.length > 0 ? users.join(', ') : '-';
                    newEmbed.addFields({ name: `${fieldPrefix} ${slot} (${users.length})`, value: value, inline: true });
                }

                await interaction.editReply({ embeds: [newEmbed] });
            }
        } catch (error) {
            console.error('Error handling button interaction:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'There was an error processing your request.', flags: 64 });
            } else {
                await interaction.followUp({ content: 'There was an error processing your request.', flags: 64 });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
