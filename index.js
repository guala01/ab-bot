require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

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
                const timeSlot = interaction.customId.split('_')[1];
                const messageId = interaction.message.id;
                const userId = interaction.user.id;
                const displayName = interaction.user.username;

                // Check if user is already signed up for this slot
                const signups = db.getSignups(messageId);
                const isSignedUp = signups.some(s => s.user_id === userId && s.slot_time === timeSlot);

                if (isSignedUp) {
                    db.removeSignup(messageId, userId, timeSlot);
                    await interaction.reply({ content: `Removed signup for ${timeSlot}`, flags: 64 });
                } else {
                    db.addSignup(messageId, userId, timeSlot, displayName);
                    // Increment stats on signup (simple approach, or could be done when event closes)
                    db.incrementStat(userId, interaction.guildId);
                    await interaction.reply({ content: `Signed up for ${timeSlot}`, flags: 64 });
                }

                // Update the embed
                const updatedSignups = db.getSignups(messageId);

                // Reconstruct the embed fields
                const rows = interaction.message.components;
                let allSlots = [];
                rows.forEach(row => {
                    row.components.forEach(component => {
                        if (component.customId && component.customId.startsWith('signup_')) {
                            allSlots.push(component.customId.split('_')[1]);
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
                for (const slot of allSlots) {
                    const users = signupsBySlot[slot] || [];
                    const value = users.length > 0 ? users.join(', ') : '-';
                    newEmbed.addFields({ name: `🫄🏿 ${slot} (${users.length})`, value: value, inline: true });
                }

                await interaction.message.edit({ embeds: [newEmbed] });
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
