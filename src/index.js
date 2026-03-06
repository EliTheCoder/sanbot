import path from 'node:path';
import dotenv from 'dotenv';
import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import { generateTierScheduleImages } from './generateScheduleImage.js';

dotenv.config();

const cfg = {
  discordToken: req('DISCORD_TOKEN'),
  guildId: req('DISCORD_GUILD_ID'),
  franchiseName: process.env.CSA_FRANCHISE_NAME || 'San Antonio Stallions',
  scheduleChannelName: (process.env.SCHEDULE_CHANNEL_NAME || 'schedule').toLowerCase(),
  csaBaseUrl: process.env.CSA_BASE_URL || 'https://api.playcsa.com',
  timezone: process.env.TIMEZONE || 'America/New_York',
  stageOverride: process.env.CSA_MATCH_TYPE?.toUpperCase(),
  outputDir: process.env.SCHEDULE_IMAGE_OUT_DIR,
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  log('info', `Logged in as ${client.user.tag}`);
  await ensureSlashCommand();
  log('info', 'Bot ready. Use /postschedule to generate and post schedule images.');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'postschedule') return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'You need `Manage Server` permission to run this command.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const selectedTier = interaction.options.getString('tier');
    const weekNum = interaction.options.getInteger('week');
    const result = await postTierScheduleImages(selectedTier, weekNum);
    await interaction.editReply(
      `Done. Posted ${result.sentCount} tier image(s) for ${result.matchType} week ${result.displayWeekNum}${result.selectedTier ? ` (${result.selectedTier})` : ''}.`
    );
  } catch (err) {
    log('error', 'postschedule failed', err);
    await interaction.editReply(`Failed: ${err.message}`);
  }
});

client.login(cfg.discordToken);

async function postTierScheduleImages(selectedTier, weekNum) {
  const guild = await client.guilds.fetch(cfg.guildId);
  await guild.channels.fetch();

  const renderResult = await generateTierScheduleImages({
    csaBaseUrl: cfg.csaBaseUrl,
    franchiseName: cfg.franchiseName,
    timezone: cfg.timezone,
    matchType: cfg.stageOverride,
    matchNum: weekNum,
    tierName: selectedTier,
    outDir: cfg.outputDir,
  });

  let sentCount = 0;
  for (const item of renderResult.rendered) {
    const channel = findScheduleChannelForTier(guild, item.tierName);
    if (!channel) {
      log('warn', `No #${cfg.scheduleChannelName} channel found for tier "${item.tierName}"`);
      continue;
    }

    await channel.send({
      content: `**${cfg.franchiseName} - ${item.tierName}**\nSeason ${renderResult.seasonNumber} | ${renderResult.matchType} Week ${renderResult.displayWeekNum}`,
      files: [path.resolve(item.outPath)],
    });

    sentCount += 1;
  }

  return {
    sentCount,
    matchType: renderResult.matchType,
    anchorMatchNum: renderResult.anchorMatchNum,
    displayWeekNum: renderResult.displayWeekNum,
    selectedTier: renderResult.selectedTier || null,
  };
}

async function ensureSlashCommand() {
  const guild = await client.guilds.fetch(cfg.guildId);
  await guild.commands.set([
    {
      name: 'postschedule',
      description: 'Generate schedule images and post them to each tier schedule channel.',
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: 'week',
          description: 'Match number to post the schedule for.',
          required: true,
          min_value: 1,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'tier',
          description: 'Optional tier name (for example: Elite, Superstar, Academy).',
          required: false,
        },
      ],
    },
  ]);
}

function findScheduleChannelForTier(guild, tierName) {
  const channels = [...guild.channels.cache.values()];
  const tierNorm = normalizeTierName(tierName);

  return (
    channels.find((ch) => {
      if (ch.type !== ChannelType.GuildText) return false;
      if (ch.name.toLowerCase() !== cfg.scheduleChannelName) return false;

      const parent = ch.parent;
      if (!parent || parent.type !== ChannelType.GuildCategory) return false;

      const catNorm = normalizeTierName(parent.name);
      return catNorm.includes(tierNorm);
    }) || null
  );
}

function normalizeTierName(v) {
  return normalizeText(v).replace(/[^a-z0-9]/g, '');
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

function req(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIntOrNull(raw) {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function log(level, message, err) {
  const levels = ['debug', 'info', 'warn', 'error'];
  if (levels.indexOf(level) < levels.indexOf(cfg.logLevel)) return;

  const stamp = new Date().toISOString();
  if (err) {
    console[level](`[${stamp}] ${level.toUpperCase()} ${message}`, err);
    return;
  }

  console[level](`[${stamp}] ${level.toUpperCase()} ${message}`);
}
