import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import dotenv from 'dotenv';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.resolve(__dirname, '..', 'data', 'state.json');

const cfg = {
  discordToken: req('DISCORD_TOKEN'),
  guildId: req('DISCORD_GUILD_ID'),
  csaBaseUrl: process.env.CSA_BASE_URL || 'https://api.playcsa.com',
  franchiseName: process.env.CSA_FRANCHISE_NAME || 'San Antonio Stallions',
  weeklyCron: process.env.WEEKLY_CRON || '0 12 * * 1',
  timezone: process.env.TIMEZONE || 'America/Chicago',
  scheduleChannelName: (process.env.SCHEDULE_CHANNEL_NAME || 'schedule').toLowerCase(),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  stageOverride: process.env.CSA_MATCH_TYPE?.toUpperCase(),
  weekOverride: parseIntOrNull(process.env.CSA_MATCH_NUM),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  log('info', `Logged in as ${client.user.tag}`);
  await ensureSlashCommand();
  await postWeeklySchedules({ force: false });

  cron.schedule(
    cfg.weeklyCron,
    async () => {
      await postWeeklySchedules({ force: false });
    },
    { timezone: cfg.timezone }
  );

  log('info', `Weekly cron scheduled: "${cfg.weeklyCron}" (${cfg.timezone})`);
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
    const result = await postWeeklySchedules({ force: true });
    await interaction.editReply(
      `Done. Posted ${result.sentCount} tier schedule message(s) for ${result.matchType} week ${result.matchNum}.`
    );
  } catch (err) {
    log('error', 'Manual postschedule failed', err);
    await interaction.editReply(`Failed: ${err.message}`);
  }
});

client.login(cfg.discordToken);

async function postWeeklySchedules({ force }) {
  const guild = await client.guilds.fetch(cfg.guildId);
  await guild.channels.fetch();

  const [season, franchise, tiers] = await Promise.all([
    getCurrentSeason(),
    getFranchiseByName(cfg.franchiseName),
    getTiers(),
  ]);

  const matchType = cfg.stageOverride || season.current_stage || 'REG';
  const matchNum = cfg.weekOverride ?? (await inferWeekToPost(season.id, franchise.id, matchType));

  const stateKey = `${season.id}:${matchType}:${matchNum}`;
  if (!force) {
    const state = await readState();
    if (state.lastPostedKey === stateKey) {
      log('info', `Skipping already-posted week ${stateKey}`);
      return { sentCount: 0, matchType, matchNum };
    }
  }

  const matches = await getMatches(season.id, matchType, matchNum, franchise.id);
  if (!matches.length) {
    throw new Error(
      `No matches returned for ${cfg.franchiseName} (season=${season.id}, type=${matchType}, week=${matchNum}).`
    );
  }

  const matchesByTier = groupBy(matches, (m) => m.tier);
  const channelMap = findTierScheduleChannels(guild, tiers);

  let sentCount = 0;
  for (const [tierName, tierMatches] of matchesByTier.entries()) {
    const channel = channelMap.get(normalizeTierName(tierName));
    if (!channel) {
      log('warn', `No #${cfg.scheduleChannelName} channel found for tier "${tierName}"`);
      continue;
    }

    const message = formatTierScheduleMessage({
      franchiseName: cfg.franchiseName,
      seasonNumber: season.number,
      matchType,
      matchNum,
      tierName,
      tierMatches,
    });

    await channel.send({ content: message });
    sentCount += 1;
  }

  await writeState({
    lastPostedKey: stateKey,
    lastPostedAt: new Date().toISOString(),
  });

  log('info', `Posted ${sentCount} tier schedule message(s) for ${stateKey}`);
  return { sentCount, matchType, matchNum };
}

async function ensureSlashCommand() {
  const guild = await client.guilds.fetch(cfg.guildId);
  await guild.commands.set([
    {
      name: 'postschedule',
      description: "Post this week's Stallions schedules to each tier schedule channel.",
    },
  ]);
}

function findTierScheduleChannels(guild, tiers) {
  const channels = [...guild.channels.cache.values()];
  const map = new Map();

  for (const tier of tiers) {
    const tierNorm = normalizeTierName(tier.name);
    const tierAbbrNorm = normalizeTierName(tier.abbr);

    const scheduleTextChannel = channels.find((ch) => {
      if (ch.type !== ChannelType.GuildText) return false;
      if (ch.name.toLowerCase() !== cfg.scheduleChannelName) return false;

      const parent = ch.parent;
      if (!parent || parent.type !== ChannelType.GuildCategory) return false;

      const catNorm = normalizeTierName(parent.name);
      return catNorm.includes(tierNorm) || catNorm.includes(tierAbbrNorm);
    });

    if (scheduleTextChannel) {
      map.set(tierNorm, scheduleTextChannel);
    }
  }

  return map;
}

function formatTierScheduleMessage({
  franchiseName,
  seasonNumber,
  matchType,
  matchNum,
  tierName,
  tierMatches,
}) {
  const sorted = [...tierMatches].sort(
    (a, b) => new Date(a.Reschedule?.reschedule_date || a.Match.date) - new Date(b.Reschedule?.reschedule_date || b.Match.date)
  );

  const lines = sorted.map((match) => {
    const isHome = normalizeText(match.home) === normalizeText(franchiseName);
    const opponent = isHome ? match.away : match.home;
    const versusLabel = isHome ? `vs ${opponent}` : `@ ${opponent}`;

    const date = new Date(match.Reschedule?.reschedule_date || match.Match.date);
    const when = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: cfg.timezone,
      timeZoneName: 'short',
    }).format(date);

    return `- ${versusLabel} | ${when}`;
  });

  return [
    `**${franchiseName} - ${tierName} Schedule**`,
    `Season ${seasonNumber} | ${matchType} Week ${matchNum}`,
    '',
    ...lines,
  ].join('\n');
}

async function inferWeekToPost(seasonId, franchiseId, matchType) {
  const allMatches = await getMatches(seasonId, matchType, undefined, franchiseId);
  if (!allMatches.length) throw new Error('Could not infer week: no matches found for franchise.');

  const now = Date.now();
  const groups = new Map();

  for (const match of allMatches) {
    const key = match.Match.match_num;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }

  const orderedWeeks = [...groups.keys()].sort((a, b) => a - b);

  for (const week of orderedWeeks) {
    const weekMatches = groups.get(week);

    const hasFuture = weekMatches.some((m) => {
      const scheduledAt = new Date(m.Reschedule?.reschedule_date || m.Match.date).getTime();
      return scheduledAt >= now;
    });

    const hasUnreported = weekMatches.some((m) => !m.Result?.is_reported);

    if (hasFuture || hasUnreported) return week;
  }

  return orderedWeeks[orderedWeeks.length - 1];
}

async function getCurrentSeason() {
  const seasons = await csaGet('/general/seasons', { current: true });
  if (!Array.isArray(seasons) || seasons.length === 0) {
    throw new Error('CSA returned no current season.');
  }
  return seasons[0];
}

async function getFranchiseByName(name) {
  const list = await csaGet('/franchises', { active: true, name });
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Franchise not found: ${name}`);
  }

  const exact = list.find((f) => normalizeText(f.name) === normalizeText(name));
  return exact || list[0];
}

async function getTiers() {
  return csaGet('/general/tiers');
}

async function getMatches(seasonId, matchType, matchNum, franchiseId) {
  const query = {
    season_id: seasonId,
    match_type: matchType,
    franchise_id: franchiseId,
  };

  if (typeof matchNum === 'number') {
    query.match_num = matchNum;
  }

  const matches = await csaGet('/matches', query);
  return Array.isArray(matches) ? matches : [];
}

async function csaGet(pathname, query = {}) {
  const url = new URL(pathname, cfg.csaBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CSA request failed (${res.status}) ${url.pathname}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function readState() {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeTierName(v) {
  return normalizeText(v).replace(/[^a-z0-9]/g, '');
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

function groupBy(list, getKey) {
  const map = new Map();
  for (const item of list) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
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
