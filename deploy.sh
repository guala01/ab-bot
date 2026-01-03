#!/bin/bash

# Navigate to the bot directory (adjust if needed, but relative path is safest if running from inside)
# cd /root/ab-bot 

echo "Starting deployment..."

# 1. Get latest changes
echo "Pulling latest changes from git..."
git pull

# 2. Install dependencies (in case new ones were added)
echo "Installing dependencies..."
npm install

# 3. Update slash commands
echo "Deploying slash commands..."
node deploy-commands.js

# 4. Restart the bot
echo "Restarting pm2 process..."
pm2 restart ab-bot
pm2 restart ab-bot-web

echo "Deployment complete!"
