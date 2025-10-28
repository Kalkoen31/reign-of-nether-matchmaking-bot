import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

const {
  DISCORD_TOKEN,
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  PTERO_BASE,             // e.g., https://panel.example.com
  PTERO_CLIENT_TOKEN,     // Client API token
  PTERO_SERVER_ID,        // UUID short of the server
  MATCH_DIR               // e.g., /srv/pterodactyl/volumes/<server-id>/match
} = process.env;

const MAPS = ['Duality_2p', 'Oceanborn_2p', 'OutlawsRidge_2p', 'FusionDelta_2p', 'Berlingrad_v2_2p', '4Mountains_4p', '4Rivers_4p', 'CaelumInsula_KotH_4p', 'EssentialIsles_6p', 'Quicksand_6p']; // keep in sync with /maps/*.zip

// --- Pterodactyl client API helpers ---
async function ptero(endpoint, method = 'GET', body) {
  const res = await fetch(`${PTERO_BASE}/api/client/servers/${PTERO_SERVER_ID}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${PTERO_CLIENT_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pterodactyl ${endpoint} ${method} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

const power = async (signal) => {
  console.log(`Sending power signal: ${signal}`);
  const result = await ptero('/power', 'POST', { signal });
  console.log(`Power signal ${signal} result:`, result);
  return result;
}; // 'stop' | 'start' | 'restart' | 'kill'
const sendCmd = (command) => ptero('/command', 'POST', { command });
const getResources = () => ptero('/resources', 'GET');

async function waitForState(target, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await getResources();
    const state = data.attributes.current_state;
    console.log(`Waiting for ${target}, current: ${state}`);
    if (state === target) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for state=${target} after ${timeoutMs}ms`);
}

// --- Discord setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('match')
    .setDescription('Start or end a match')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a match with selected map and players')
        .addStringOption(o => o.setName('map').setDescription('Map name').setRequired(true)
          .addChoices(...MAPS.map(m => ({ name: m, value: m }))))
        .addStringOption(o => o.setName('player1').setDescription('Player 1').setRequired(true))
        .addStringOption(o => o.setName('player2').setDescription('Player 2').setRequired(true))
        .addStringOption(o => o.setName('player3').setDescription('Player 3').setRequired(false))
        .addStringOption(o => o.setName('player4').setDescription('Player 4').setRequired(false))
        .addStringOption(o => o.setName('player5').setDescription('Player 5').setRequired(false))
        .addStringOption(o => o.setName('player6').setDescription('Player 6').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End the active match')
    )
    .addSubcommand(sub =>
      sub.setName('whitelist')
        .setDescription('Add a player to the current match whitelist')
        .addStringOption(o => o.setName('player').setDescription('Minecraft username to whitelist').setRequired(true))
    )
    .setDMPermission(false)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body: commands });
  console.log('Slash commands registered');
}

// --- State & file ops ---
const jobPath = path.join(MATCH_DIR, 'job.json');
const statePath = path.join(MATCH_DIR, 'state.json');

async function readState() {
  try { return JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch { return { active: false, last_ended: null }; }
}

async function writeJob(job) {
  await fs.writeFile(jobPath, JSON.stringify(job, null, 2));
}

async function clearState() {
  await fs.writeFile(statePath, JSON.stringify({ active: false, last_ended: new Date().toISOString() }, null, 2));
  try { await fs.unlink(jobPath); } catch {}
}

// --- Match flow ---
async function startMatch(userId, map, players, interaction) {
  // Locking: only one active match
  const state = await readState();
  
  // Check if there's an active match
  if (state.active) {
    return interaction.editReply(`❌ A match is already active (map: **${state.map}**) started by <@${state.started_by}>. End it with \`/match end\` first.`);
  }
  
  // Check cooldown after ending a match (10 seconds)
  if (state.last_ended) {
    const cooldownMs = 10000; // 10 seconds
    const timeSinceEnd = Date.now() - new Date(state.last_ended).getTime();
    if (timeSinceEnd < cooldownMs) {
      const remainingSeconds = Math.ceil((cooldownMs - timeSinceEnd) / 1000);
      return interaction.editReply(`⏳ Please wait ${remainingSeconds} more second(s) before starting a new match.`);
    }
  }

  if (players.length < 2 || players.length > 6) {
    return interaction.editReply(`❌ Please provide between 2 and 6 players.`);
  }

  // Create a job for run.sh
  await writeJob({ map, players, started_by: userId, created_at: new Date().toISOString() });
  await interaction.editReply(`🛠️ Provisioning **${map}** for players: \`${players.join('`, `')}\` Please wait 45-60 seconds`);

  // Stop → Start cycle
  // Check current state first
  const currentState = (await getResources()).attributes.current_state;
  console.log(`Current server state: ${currentState}`);
  
  if (currentState !== 'offline') {
    try {
      await power('stop');
      await waitForState('offline', 120000);
    } catch (e) {
      console.error('Error stopping server:', e.message);
      throw e;
    }
  }

  console.log('Starting server...');
  await power('start');
  await waitForState('running', 120000);

  // Whitelist players via console
  for (const p of players) {
    await sendCmd(`whitelist add ${p}`);
  }
  await sendCmd(`say Match ready on ${map}! Whitelisted: ${players.join(', ')}`);

  await interaction.followUp(`✅ **Match is live** on **${map}**!\n🌐 Server: \`rts.memegaming.eu.org\`\n👥 Players: ${players.map(p => `\`${p}\``).join(', ')}\n\nOnly you can end it with \`/match end\`.`);

  // Mark state active
  await fs.writeFile(statePath, JSON.stringify({ active: true, map, started_by: userId, started_at: new Date().toISOString() }, null, 2));
}

async function endMatch(userId, interaction) {
  const state = await readState();
  if (!state.active) return interaction.editReply('ℹ️ No active match.');

  const isOwner = state.started_by === userId;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (!isOwner && !isAdmin) {
    return interaction.editReply(`❌ Only the match starter (<@${state.started_by}>) or an admin can end the match.`);
  }

  await interaction.editReply('🛑 Ending match and shutting down server…');

  try { await power('stop'); } catch {}
  await waitForState('offline', 120000);

  await clearState();
  await interaction.followUp('✅ Match ended. Server is now offline.');
}

async function whitelistPlayer(userId, player, interaction) {
  const state = await readState();
  
  // Check if there's an active match
  if (!state.active) {
    return interaction.editReply('❌ No active match. Start a match first with `/match start`.');
  }
  
  // Check if caller is the match creator or admin
  const isOwner = state.started_by === userId;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (!isOwner && !isAdmin) {
    return interaction.editReply(`❌ Only the match starter (<@${state.started_by}>) or an admin can whitelist players.`);
  }
  
  // Check if server is running
  const currentState = (await getResources()).attributes.current_state;
  if (currentState !== 'running') {
    return interaction.editReply(`❌ Server is not running (current state: ${currentState}). Wait for the match to fully start.`);
  }
  
  // Add player to whitelist
  try {
    await sendCmd(`whitelist add ${player}`);
    await interaction.editReply(`✅ Added **${player}** to the whitelist.`);
  } catch (e) {
    console.error('Error whitelisting player:', e.message);
    await interaction.editReply(`⚠️ Failed to whitelist **${player}**. Check the logs.`);
  }
}

client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'match') return;

  try {
    await interaction.deferReply({ flags: 64 }); // 64 = MessageFlags.Ephemeral

    if (interaction.options.getSubcommand() === 'start') {
      const map = interaction.options.getString('map', true);
      const players = ['player1','player2','player3','player4','player5','player6']
        .map(n => interaction.options.getString(n, false))
        .filter(Boolean);

      if (!MAPS.includes(map)) {
        return interaction.editReply(`❌ Unknown map. Available: ${MAPS.join(', ')}`);
      }
      await startMatch(interaction.user.id, map, players, interaction);
    } else if (interaction.options.getSubcommand() === 'end') {
      await endMatch(interaction.user.id, interaction);
    } else if (interaction.options.getSubcommand() === 'whitelist') {
      const player = interaction.options.getString('player', true);
      await whitelistPlayer(interaction.user.id, player, interaction);
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred) {
      await interaction.editReply('⚠️ Something went wrong. Check bot logs.');
    }
  }
});

client.login(DISCORD_TOKEN);