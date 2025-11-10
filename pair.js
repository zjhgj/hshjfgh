const axios = require('axios');
const ytSearch = require('yt-search');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser
} = require('baileys');

// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: './dyby.png',
    OWNER_NUMBER: ''
};

// GitHub Octokit initialization
let octokit;
if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN
    });
}
const owner = process.env.GITHUB_REPO_OWNER || "";
const repo = process.env.GITHUB_REPO_NAME || "";

// Memory optimization: Use weak references for sockets
const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

// Memory optimization: Cache frequently used data
let adminCache = null;
let adminCacheTime = 0;
const ADMIN_CACHE_TTL = 300000; // 5 minutes

// Initialize directories
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Memory optimization: Improved admin loading with caching
function loadAdmins() {
    try {
        const now = Date.now();
        if (adminCache && now - adminCacheTime < ADMIN_CACHE_TTL) {
            return adminCache;
        }
        
        if (fs.existsSync(defaultConfig.ADMIN_LIST_PATH)) {
            adminCache = JSON.parse(fs.readFileSync(defaultConfig.ADMIN_LIST_PATH, 'utf8'));
            adminCacheTime = now;
            return adminCache;
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// Memory optimization: Use template literals efficiently
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Memory optimization: Clean up unused variables and optimize loops
async function cleanDuplicateFiles(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`creds_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        // Keep only the first (newest) file, delete the rest
        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Memory optimization: Reduce memory usage in message sending
async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'Bot Connected',
        `📞 Number: ${number}\nBots: Connected`,
        '*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
    );

    // Send messages sequentially to avoid memory spikes
    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: defaultConfig.IMAGE_PATH },
                    caption
                }
            );
            // Add a small delay to prevent rate limiting and memory buildup
            await delay(100);
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

// Memory optimization: Cache the about status to avoid repeated updates
let lastAboutUpdate = 0;
const ABOUT_UPDATE_INTERVAL = 3600000; // 1 hour

async function updateAboutStatus(socket) {
    const now = Date.now();
    if (now - lastAboutUpdate < ABOUT_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const aboutStatus = 'FATIMA-𝐌𝐃-𝐌𝐢𝐧𝐢 𝐁𝐨𝐭 𝐢𝐬 𝐀𝐜𝐭𝐢𝐯𝐞 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        lastAboutUpdate = now;
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

// Memory optimization: Limit story updates
let lastStoryUpdate = 0;
const STORY_UPDATE_INTERVAL = 86400000; // 24 hours

async function updateStoryStatus(socket) {
    const now = Date.now();
    if (now - lastStoryUpdate < STORY_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const statusMessage = `Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        lastStoryUpdate = now;
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

// Memory optimization: Throttle status handlers
function setupStatusHandlers(socket, userConfig) {
    let lastStatusInteraction = 0;
    const STATUS_INTERACTION_COOLDOWN = 10000; // 10 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        
        // Throttle status interactions to prevent spam
        const now = Date.now();
        if (now - lastStatusInteraction < STATUS_INTERACTION_COOLDOWN) {
            return;
        }

        try {
            if (userConfig.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }

            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                const emojis = Array.isArray(userConfig.AUTO_LIKE_EMOJI) ? 
                    userConfig.AUTO_LIKE_EMOJI : defaultConfig.AUTO_LIKE_EMOJI;
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        lastStatusInteraction = now;
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// Memory optimization: Streamline command handlers with rate limiting
function setupCommandHandlers(socket, number, userConfig) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        const newsletterJids = ["120363418144382782@newsletter", "120363418144382782@newsletter", "120363418144382782@newsletter"];
  const emojis = ["🫡", "💪"];

  if (msg.key && newsletterJids.includes(msg.key.remoteJid)) {
    try {
      const serverId = msg.newsletterServerId;
      if (serverId) {
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        await conn.newsletterReactMessage(msg.key.remoteJid, serverId.toString(), emoji);
      }
    } catch (e) {
    
    }
  }	  
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Extract text from different message types
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message.buttonsResponseMessage?.selectedButtonId) {
            text = msg.message.buttonsResponseMessage.selectedButtonId.trim();
        } else if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim();
        } else if (msg.message.videoMessage?.caption) {
            text = msg.message.videoMessage.caption.trim();
        }

        // Check if it's a command
        const prefix = userConfig.PREFIX || '.';
        if (!text.startsWith(prefix)) return;
        
        // Rate limiting
        const sender = msg.key.remoteJid;
        const now = Date.now();
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(prefix.length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const caption = `
╭───『 🤖 𝐁𝐎𝐓 𝐀𝐂𝐓𝐈𝐕𝐄 』───╮
│ ⏰ *ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s
│ 🟢 *ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs:* ${activeSockets.size}
│ 📱 *ʏᴏᴜʀ ɴᴜᴍʙᴇʀ:* ${number}
╰──────────────────╯

> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*
`;

                    await socket.sendMessage(sender, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH || 'https://files.catbox.moe/i9dtsl.jpg' },
                        caption: caption.trim()
                    });
                    break;
                }

                case 'config': {
                    if (args[0] === 'set' && args.length >= 3) {
                        const configKey = args[1].toUpperCase();
                        const configValue = args.slice(2).join(' ');
                        
                        // Handle array values
                        if (configKey === 'AUTO_LIKE_EMOJI') {
                            userConfig[configKey] = configValue.split(',');
                        } else {
                            userConfig[configKey] = configValue;
                        }
                        
                        await updateUserConfig(number, userConfig);
                        
                        await socket.sendMessage(sender, {
                            text: `✅ Config updated: ${configKey} = ${configValue}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                    } else if (args[0] === 'view') {
                        let configText = '*📋 Your Current Config:*\n\n';
                        for (const [key, value] of Object.entries(userConfig)) {
                            configText += `• ${key}: ${Array.isArray(value) ? value.join(', ') : value}\n`;
                        }
                        configText += '\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*';
                        
                        await socket.sendMessage(sender, { text: configText });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ Invalid config command. Usage:\n${prefix}config set [key] [value]\n${prefix}config view\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                    }
                    break;
                }
                
                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const os = require('os');
                    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
                    const totalRam = Math.round(os.totalmem() / 1024 / 1024);

                    const menuCaption = `
👋 *Hi ${number}*

╭───『 *FATIMA-𝐌𝐃-𝐌𝐢𝐧𝐢 𝐁𝐨𝐭 𝐢𝐬 𝐀𝐜𝐭𝐢𝐯𝐞* 』
│ 👾 *ʙᴏᴛ*: FATIMA-𝐌𝐃-𝐌𝐢𝐧𝐢
│ 📞 *ᴏᴡɴᴇʀ*: FATIMA-𝐌𝐃
│ ⏳ *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
│ 📂 *ʀᴀᴍ*: ${ramUsage}MB / ${totalRam}MB
│ ✏️ *ᴘʀᴇғɪx*: ${config.PREFIX}
╰─────────────────────╯

⚡ Commands:
- ${config.PREFIX}alive
- ${config.PREFIX}menu
- ${config.PREFIX}ping
- ${config.PREFIX}uptime
- ${config.PREFIX}repo
- ${config.PREFIX}pair
- ${config.PREFIX}tagall
- ${config.PREFIX}deleteme / confirm
- ${config.PREFIX}fb <url> - Download Facebook video
- ${config.PREFIX}song <query> - Search and download songs
- ${config.PREFIX}ytaudio <url> - Download YouTube audio
- ${config.PREFIX}getpp <number> - Get profile picture of any number
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || 'https://files.catbox.moe/i9dtsl.jpg' },
                        caption: menuCaption.trim()
                    });
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '🏓 Pong!' });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { 
                        text: `⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }
                
                case 'uptime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    await socket.sendMessage(sender, {
                        text: `⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n📊 *Active Sessions:* ${activeSockets.size}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }

                case 'tagall': {
                    if (!msg.key.remoteJid.endsWith('@g.us')) {
                        await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.' });
                        return;
                    }
                    const groupMetadata = await socket.groupMetadata(sender);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const tagMessage = `📢 *Tagging all members:*\n\n${participants.map(p => `@${p.split('@')[0]}`).join(' ')}`;
                    
                    await socket.sendMessage(sender, {
                        text: tagMessage,
                        mentions: participants
                    });
                    break;
                }

                case 'repo': {
                    await socket.sendMessage(sender, {
                        image: { url: 'https://files.catbox.moe/i9dtsl.jpg' },
                        caption: `📦 *ARSLAN-MD MINI BOT REPOSITORY*\n\n🔗 *GitHub:* https://github.com/policeduafatima/FATIMA-MD-Mini\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }

                case 'fb': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a Facebook video URL.\nUsage: ${config.PREFIX}fb <facebook-video-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const fbUrl = args[0];
                    if (!fbUrl.includes('facebook.com') && !fbUrl.includes('fb.watch')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid Facebook video URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading Facebook video, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/download/fbdl2?url=${encodeURIComponent(fbUrl)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data || response.data.status !== true) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Unable to fetch the video. Please check the URL and try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        // Extract links from the response
                        const sdLink = response.data.result.sdLink;
                        const hdLink = response.data.result.hdLink;
                        const downloadLink = hdLink || sdLink; // Prefer HD if available
                        const quality = hdLink ? "HD" : "SD";
                        
                        if (!downloadLink) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No downloadable video found. The video might be private or restricted.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }
                        
                        // Send the video
                        await socket.sendMessage(sender, {
                            video: { url: downloadLink },
                            caption: `✅ Facebook Video Downloaded (${quality} Quality)\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('Facebook download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading video. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'song': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a song name to search.\nUsage: ${config.PREFIX}song <song name>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const query = args.join(' ');
                    await socket.sendMessage(sender, { 
                        text: `🔍 Searching for "${query}"...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        // Search for videos using yt-search
                        const searchResults = await ytSearch(query);
                        
                        if (!searchResults.videos || searchResults.videos.length === 0) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No results found for "${query}"\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FARIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }
                        
                        // Get the first result
                        const video = searchResults.videos[0];
                        const videoUrl = video.url;
                        
                        await socket.sendMessage(sender, { 
                            text: `🎵 Found: ${video.title}\n⏱ Duration: ${video.timestamp}\n⬇️ Downloading audio...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        
                        // Download using the audio API
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(videoUrl)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ Downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('Song download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading song. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'ytaudio': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a YouTube URL.\nUsage: ${config.PREFIX}ytaudio <youtube-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const url = args[0];
                    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid YouTube URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading YouTube audio, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(url)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ YouTube audio downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('YouTube audio download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading audio. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'getpp': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a phone number.\nUsage: ${config.PREFIX}getpp <number>\nExample: ${config.PREFIX}getpp 923237045919\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    let targetNumber = args[0].replace(/[^0-9]/g, '');
                    
                    // Add country code if not provided
                    if (!targetNumber.startsWith('92') && targetNumber.length === 10) {
                        targetNumber = '92' + targetNumber;
                    }
                    
                    // Ensure it has @s.whatsapp.net
                    const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
                    
                    await socket.sendMessage(sender, { 
                        text: `🕵️ Stealing profile picture for ${targetNumber}...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        // Get profile picture URL
                        const profilePictureUrl = await socket.profilePictureUrl(targetJid, 'image');
                        
                        if (profilePictureUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: profilePictureUrl },
                                caption: `✅ Successfully stole profile picture!\n📱 Number: ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        }
                        
                    } catch (error) {
                        console.error('Profile picture steal error:', error);
                        
                        if (error.message.includes('404') || error.message.includes('not found')) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ Error stealing profile picture: ${error.message}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        }
                    }
                    break;
                }

                case 'deleteme': {
                    const confirmationMessage = `⚠️ *Are you sure you want to delete your session?*\n\nThis action will:\n• Log out your bot\n• Delete all session data\n• Require re-pairing to use again\n\nReply with *${config.PREFIX}confirm* to proceed or ignore to cancel.`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                    });
                    break;
                }

                case 'confirm': {
                    // Handle session deletion confirmation
                    const sanitizedNumber = number.replace(/[^0-9]/g, '');
                    
                    await socket.sendMessage(sender, {
                        text: '🗑️ Deleting your session...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                    });
                    
                    try {
                        // Close the socket connection
                        const socket = activeSockets.get(sanitizedNumber);
                        if (socket) {
                            socket.ws.close();
                            activeSockets.delete(sanitizedNumber);
                            socketCreationTime.delete(sanitizedNumber);
                        }
                        
                        // Delete session files
                        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
                        if (fs.existsSync(sessionPath)) {
                            fs.removeSync(sessionPath);
                        }
                        
                        // Delete from GitHub if octokit is available
                        if (octokit) {
                            await deleteSessionFromGitHub(sanitizedNumber);
                        }
                        
                        // Remove from numbers list
                        let numbers = [];
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                        }
                        const index = numbers.indexOf(sanitizedNumber);
                        if (index !== -1) {
                            numbers.splice(index, 1);
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        }
                        
                        await socket.sendMessage(sender, {
                            text: '✅ Your session has been successfully deleted!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                        });
                    } catch (error) {
                        console.error('Failed to delete session:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to delete your session. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                        });
                    }
                    break;
                }
                
                

                default: {
                    await socket.sendMessage(sender, {
                        text: `❌ Unknown command: ${command}\nUse ${prefix}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ An error occurred while processing your command. Please try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
            });
        }
    });
}

// Memory optimization: Throttle message handlers
function setupMessageHandlers(socket, userConfig) {
    let lastPresenceUpdate = 0;
    const PRESENCE_UPDATE_COOLDOWN = 5000; // 5 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Throttle presence updates
        const now = Date.now();
        if (now - lastPresenceUpdate < PRESENCE_UPDATE_COOLDOWN) {
            return;
        }

        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                lastPresenceUpdate = now;
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// Memory optimization: Batch GitHub operations
async function deleteSessionFromGitHub(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        // Delete files in sequence to avoid rate limiting
        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            await delay(500); // Add delay between deletions
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

// Memory optimization: Cache session data
const sessionCache = new Map();
const SESSION_CACHE_TTL = 300000; // 5 minutes

async function restoreSession(number) {
    try {
        if (!octokit) return null;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = sessionCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
            return cached.data;
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        // Cache the session data
        sessionCache.set(sanitizedNumber, {
            data: sessionData,
            timestamp: Date.now()
        });
        
        return sessionData;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Memory optimization: Cache user config
const userConfigCache = new Map();
const USER_CONFIG_CACHE_TTL = 300000; // 5 minutes

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = userConfigCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < USER_CONFIG_CACHE_TTL) {
            return cached.data;
        }
        
        let configData = { ...defaultConfig };
        
        if (octokit) {
            try {
                const configPath = `session/config_${sanitizedNumber}.json`;
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });

                const content = Buffer.from(data.content, 'base64').toString('utf8');
                const userConfig = JSON.parse(content);
                
                // Merge with default config
                configData = { ...configData, ...userConfig };
            } catch (error) {
                console.warn(`No configuration found for ${number}, using default config`);
            }
        }
        
        // Set owner number to the user's number if not set
        if (!configData.OWNER_NUMBER) {
            configData.OWNER_NUMBER = sanitizedNumber;
        }
        
        // Cache the config
        userConfigCache.set(sanitizedNumber, {
            data: configData,
            timestamp: Date.now()
        });
        
        return configData;
    } catch (error) {
        console.warn(`Error loading config for ${number}, using default config:`, error);
        return { ...defaultConfig, OWNER_NUMBER: number.replace(/[^0-9]/g, '') };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        if (octokit) {
            const configPath = `session/config_${sanitizedNumber}.json`;
            let sha;

            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });
                sha = data.sha;
            } catch (error) {
                // File doesn't exist yet, no sha needed
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: configPath,
                message: `Update config for ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
                sha
            });
        }
        
        // Update cache
        userConfigCache.set(sanitizedNumber, {
            data: newConfig,
            timestamp: Date.now()
        });
        
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// Memory optimization: Improve auto-restart logic
function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const RESTART_DELAY_BASE = 10000; // 10 seconds
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            // Delete session from GitHub when connection is lost
            await deleteSessionFromGitHub(number);
            
            if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
                console.log(`Max restart attempts reached for ${number}, giving up`);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                return;
            }
            
            restartAttempts++;
            const delayTime = RESTART_DELAY_BASE * Math.pow(2, restartAttempts - 1); // Exponential backoff
            
            console.log(`Connection lost for ${number}, attempting to reconnect in ${delayTime/1000} seconds (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
            
            await delay(delayTime);
            
            try {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            } catch (error) {
                console.error(`Reconnection attempt ${restartAttempts} failed for ${number}:`, error);
            }
        } else if (connection === 'open') {
            // Reset restart attempts on successful connection
            restartAttempts = 0;
        }
    });
}

// Memory optimization: Improve pairing process
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // Check if already connected
    if (activeSockets.has(sanitizedNumber)) {
        if (!res.headersSent) {
            res.send({ 
                status: 'already_connected',
                message: 'This number is already connected'
            });
        }
        return;
    }

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.windows('Chrome')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Load user config
        const userConfig = await loadUserConfig(sanitizedNumber);
        
        setupStatusHandlers(socket, userConfig);
        setupCommandHandlers(socket, sanitizedNumber, userConfig);
        setupMessageHandlers(socket, userConfig);
        setupAutoRestart(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = parseInt(userConfig.MAX_RETRIES) || 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * ((parseInt(userConfig.MAX_RETRIES) || 3) - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            
            if (octokit) {
                let sha;
                try {
                    const { data } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`
                    });
                    sha = data.sha;
                } catch (error) {
                    // File doesn't exist yet, no sha needed
                }

                await octokit.repos.createOrUpdateFileContents({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`,
                    message: `Update session creds for ${sanitizedNumber}`,
                    content: Buffer.from(fileContent).toString('base64'),
                    sha
                });
                console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    
                    const userJid = jidNormalizedUser(socket.user.id);
   
   await sock.newsletterFollow("120363348739987203@newsletter");
                        await sock.newsletterUnmute("120363348739987203@newsletter");   
                        await sock.newsletterFollow("120363348739987203@newsletter");
                        
                                                                                            
                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH },
                        caption: formatMessage(
                            'ARSLAN-MD-MINI BOT CONNECTED',
`✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n✨ Bot is now active and ready to use!\n\n📌 Type ${userConfig.PREFIX || '.'}menu to view all commands`,
'*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || '𝐀𝐫𝐬𝐥𝐚𝐧-𝐌𝐃-𝐌𝐢𝐧𝐢-𝐅𝚁𝙴𝙴-𝐁𝙾𝚃-session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// API Routes - Only essential routes kept
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Memory optimization: Limit concurrent connections
const MAX_CONCURRENT_CONNECTIONS = 5;
let currentConnections = 0;

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        const connectionPromises = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent connections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            connectionPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(connectionPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

// Memory optimization: Limit concurrent reconnections
router.get('/reconnect', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(500).send({ error: 'GitHub integration not configured' });
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        const reconnectPromises = [];
        
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent reconnections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            reconnectPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    console.error(`Failed to reconnect bot for ${number}:`, error);
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(reconnectPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

// Config management routes for HTML interface
router.get('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const config = await loadUserConfig(number);
        res.status(200).send(config);
    } catch (error) {
        console.error('Failed to load config:', error);
        res.status(500).send({ error: 'Failed to load config' });
    }
});

router.post('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const newConfig = req.body;
        
        // Validate config
        if (typeof newConfig !== 'object') {
            return res.status(400).send({ error: 'Invalid config format' });
        }
        
        // Load current config and merge
        const currentConfig = await loadUserConfig(number);
        const mergedConfig = { ...currentConfig, ...newConfig };
        
        await updateUserConfig(number, mergedConfig);
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

// Cleanup with better memory management
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
    
    // Clear all caches
    adminCache = null;
    adminCacheTime = 0;
    sessionCache.clear();
    userConfigCache.clear();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'BOT-session'}`);
});

// Regular memory cleanup
setInterval(() => {
    // Clean up expired cache entries
    const now = Date.now();
    
    // Clean session cache
    for (let [key, value] of sessionCache.entries()) {
        if (now - value.timestamp > SESSION_CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
    
    // Clean user config cache
    for (let [key, value] of userConfigCache.entries()) {
        if (now - value.timestamp > USER_CONFIG_CACHE_TTL) {
            userConfigCache.delete(key);
        }
    }
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
}, 300000); // Run every 5 minutes

module.exports = router;
















// commands handler with old cmds 

// Memory optimization: Streamline command handlers with rate limiting
function setupCommandHandlers(socket, number) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        // Extract text from different message types
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message.buttonsResponseMessage?.selectedButtonId) {
            text = msg.message.buttonsResponseMessage.selectedButtonId.trim();
        } else if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim();
        } else if (msg.message.videoMessage?.caption) {
            text = msg.message.videoMessage.caption.trim();
        }

        // Check if it's a command
        if (!text.startsWith(config.PREFIX)) return;
        
        // Rate limiting
        const sender = msg.key.remoteJid;
        const now = Date.now();
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const caption = `
╭───『 🤖 𝐁𝐎𝐓 𝐀𝐂𝐓𝐈𝐕𝐄 』───╮
│ ⏰ *ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s
│ 🟢 *ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs:* ${activeSockets.size}
│ 📱 *ʏᴏᴜʀ ɴᴜᴍʙᴇʀ:* ${number}
╰──────────────────╯

> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || 'https://files.catbox.moe/qryulf.jpg' },
                        caption: caption.trim()
                    });
                    break;
                }

                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const os = require('os');
                    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
                    const totalRam = Math.round(os.totalmem() / 1024 / 1024);

                    const menuCaption = `
👋 *Hi ${number}*

╭───『 *𝐀𝐫𝐬𝐥𝐚𝐧-𝐌𝐃-𝐌𝐢𝐧𝐢* 』
│ 👾 *ʙᴏᴛ*: 𝐀𝐫𝐬𝐥𝐚𝐧-𝐌𝐃-𝐌𝐢𝐧𝐢
│ 📞 *ᴏᴡɴᴇʀ*: 𝐀𝐫𝐬𝐥𝐚𝐧-𝐌𝐃
│ ⏳ *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
│ 📂 *ʀᴀᴍ*: ${ramUsage}MB / ${totalRam}MB
│ ✏️ *ᴘʀᴇғɪx*: ${config.PREFIX}
╰─────────────────────╯

⚡ Commands:
- ${config.PREFIX}alive
- ${config.PREFIX}menu
- ${config.PREFIX}ping
- ${config.PREFIX}uptime
- ${config.PREFIX}repo
- ${config.PREFIX}pair
- ${config.PREFIX}tagall
- ${config.PREFIX}deleteme / confirm
- ${config.PREFIX}fb <url> - Download Facebook video
- ${config.PREFIX}song <query> - Search and download songs
- ${config.PREFIX}ytaudio <url> - Download YouTube audio
- ${config.PREFIX}getpp <number> - Get profile picture of any number
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || 'https://files.catbox.moe/qryulf.jpg' },
                        caption: menuCaption.trim()
                    });
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '🏓 Pong!' });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { 
                        text: `⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }
                
                case 'uptime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    await socket.sendMessage(sender, {
                        text: `⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n📊 *Active Sessions:* ${activeSockets.size}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }

                case 'tagall': {
                    if (!msg.key.remoteJid.endsWith('@g.us')) {
                        await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.' });
                        return;
                    }
                    const groupMetadata = await socket.groupMetadata(sender);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const tagMessage = `📢 *Tagging all members:*\n\n${participants.map(p => `@${p.split('@')[0]}`).join(' ')}`;
                    
                    await socket.sendMessage(sender, {
                        text: tagMessage,
                        mentions: participants
                    });
                    break;
                }

                case 'repo': {
                    await socket.sendMessage(sender, {
                        image: { url: 'https://files.catbox.moe/qryulf.jpg' },
                        caption: `📦 *ARSLAN-MD MINI BOT REPOSITORY*\n\n🔗 *GitHub:* https://github.com/Arslan-MD/Arslan-MD-Mini\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }

                case 'fb': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a Facebook video URL.\nUsage: ${config.PREFIX}fb <facebook-video-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const fbUrl = args[0];
                    if (!fbUrl.includes('facebook.com') && !fbUrl.includes('fb.watch')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid Facebook video URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading Facebook video, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/download/fbdl2?url=${encodeURIComponent(fbUrl)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data || response.data.status !== true) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Unable to fetch the video. Please check the URL and try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        // Extract links from the response
                        const sdLink = response.data.result.sdLink;
                        const hdLink = response.data.result.hdLink;
                        const downloadLink = hdLink || sdLink; // Prefer HD if available
                        const quality = hdLink ? "HD" : "SD";
                        
                        if (!downloadLink) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No downloadable video found. The video might be private or restricted.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }
                        
                        // Send the video
                        await socket.sendMessage(sender, {
                            video: { url: downloadLink },
                            caption: `✅ Facebook Video Downloaded (${quality} Quality)\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('Facebook download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading video. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'song': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a song name to search.\nUsage: ${config.PREFIX}song <song name>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const query = args.join(' ');
                    await socket.sendMessage(sender, { 
                        text: `🔍 Searching for "${query}"...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        // Search for videos using yt-search
                        const searchResults = await ytSearch(query);
                        
                        if (!searchResults.videos || searchResults.videos.length === 0) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No results found for "${query}"\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }
                        
                        // Get the first result
                        const video = searchResults.videos[0];
                        const videoUrl = video.url;
                        
                        await socket.sendMessage(sender, { 
                            text: `🎵 Found: ${video.title}\n⏱ Duration: ${video.timestamp}\n⬇️ Downloading audio...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        
                        // Download using the audio API
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(videoUrl)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ Downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('Song download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading song. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'ytaudio': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a YouTube URL.\nUsage: ${config.PREFIX}ytaudio <youtube-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    const url = args[0];
                    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid YouTube URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading YouTube audio, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(url)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ YouTube audio downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                        });
                        
                    } catch (error) {
                        console.error('YouTube audio download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading audio. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                    }
                    break;
                }

                case 'getpp': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a phone number.\nUsage: ${config.PREFIX}getpp <number>\nExample: ${config.PREFIX}getpp 923155641171\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                        });
                        return;
                    }
                    
                    let targetNumber = args[0].replace(/[^0-9]/g, '');
                    
                    // Add country code if not provided
                    if (!targetNumber.startsWith('92') && targetNumber.length === 10) {
                        targetNumber = '92' + targetNumber;
                    }
                    
                    // Ensure it has @s.whatsapp.net
                    const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
                    
                    await socket.sendMessage(sender, { 
                        text: `🕵️ Stealing profile picture for ${targetNumber}...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                    });
                    
                    try {
                        // Get profile picture URL
                        const profilePictureUrl = await socket.profilePictureUrl(targetJid, 'image');
                        
                        if (profilePictureUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: profilePictureUrl },
                                caption: `✅ Successfully stole profile picture!\n📱 Number: ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        }
                        
                    } catch (error) {
                        console.error('Profile picture steal error:', error);
                        
                        if (error.message.includes('404') || error.message.includes('not found')) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ Error stealing profile picture: ${error.message}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*` 
                            });
                        }
                    }
                    break;
                }

                case 'deleteme': {
                    const confirmationMessage = `⚠️ *Are you sure you want to delete your session?*\n\nThis action will:\n• Log out your bot\n• Delete all session data\n• Require re-pairing to use again\n\nReply with *${config.PREFIX}confirm* to proceed or ignore to cancel.`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                    });
                    break;
                }

                case 'confirm': {
                    // Handle session deletion confirmation
                    const sanitizedNumber = number.replace(/[^0-9]/g, '');
                    
                    await socket.sendMessage(sender, {
                        text: '🗑️ Deleting your session...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                    });
                    
                    try {
                        // Close the socket connection
                        const socket = activeSockets.get(sanitizedNumber);
                        if (socket) {
                            socket.ws.close();
                            activeSockets.delete(sanitizedNumber);
                            socketCreationTime.delete(sanitizedNumber);
                        }
                        
                        // Delete session files
                        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
                        if (fs.existsSync(sessionPath)) {
                            fs.removeSync(sessionPath);
                        }
                        
                        // Delete from GitHub if octokit is available
                        if (octokit) {
                            await deleteSessionFromGitHub(sanitizedNumber);
                        }
                        
                        // Remove from numbers list
                        let numbers = [];
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                        }
                        const index = numbers.indexOf(sanitizedNumber);
                        if (index !== -1) {
                            numbers.splice(index, 1);
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        }
                        
                        await socket.sendMessage(sender, {
                            text: '✅ Your session has been successfully deleted!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                        });
                    } catch (error) {
                        console.error('Failed to delete session:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to delete your session. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*'
                        });
                    }
                    break;
                }

                default: {
                    await socket.sendMessage(sender, {
                        text: `❌ Unknown command: ${command}\nUse ${config.PREFIX}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
                    });
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ An error occurred while processing your command. Please try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy FATIMAᴍᴅ ᴏꜰꜰɪᴄɪᴀʟ*`
            });
        }
    });
}
