import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baseCfg = {
  csaBaseUrl: process.env.CSA_BASE_URL || 'https://api.playcsa.com',
  franchiseName: process.env.CSA_FRANCHISE_NAME || 'San Antonio Stallions',
  timezone: process.env.TIMEZONE || 'America/New_York',
  matchType: (argValue('--type') || process.env.CSA_MATCH_TYPE || '').toUpperCase(),
  weekNum: parseIntOrNull(argValue('--week') || process.env.CSA_WEEK_NUM),
  matchNum: parseIntOrNull(argValue('--match-num') || process.env.CSA_MATCH_NUM),
  tierName: argValue('--tier') || process.env.CSA_TIER_NAME || null,
  outDir:
    argValue('--out-dir') ||
    process.env.SCHEDULE_IMAGE_OUT_DIR ||
    path.resolve(__dirname, '..', 'output'),
};

let runtimeCfg = { ...baseCfg };

const TIER_TIMES = {
  academy:      ['7:45 PM ET', '8:30 PM ET'],
  novice:       ['8:30 PM ET', '9:15 PM ET'],
  professional: ['7:45 PM ET', '8:30 PM ET'],
  elite:        ['7:00 PM ET', '7:45 PM ET'],
  superstar:    ['8:30 PM ET', '9:15 PM ET'],
  premier:      ['7:00 PM ET', '7:45 PM ET', '8:30 PM ET'],
  'world class':['8:00 PM ET', '8:30 PM ET', '9:00 PM ET', '9:30 PM ET', '10:00 PM ET'],
};
const interRegularPath = path.resolve(__dirname, '..', 'assets', 'fonts', 'Inter-Regular.woff2');
const interBoldPath = path.resolve(__dirname, '..', 'assets', 'fonts', 'Inter-Bold.woff2');
let embeddedFontCssCache = null;

export async function generateTierScheduleImages(overrides = {}) {
  const cfg = buildConfig(overrides);
  runtimeCfg = cfg;

  const [season, tiers, allFranchises] = await Promise.all([
    getCurrentSeason(),
    csaGet('/general/tiers'),
    csaGet('/franchises', { active: true }),
  ]);

  const franchise = findFranchiseByName(allFranchises, cfg.franchiseName);
  if (!franchise) throw new Error(`Franchise not found: ${cfg.franchiseName}`);

  const matchType = cfg.matchType || season.current_stage || 'REG';
  const allMatches = await csaGet('/matches', {
    season_id: season.id,
    match_type: matchType,
    franchise_id: franchise.id,
  });
  const captainPlayers = await csaGet('/leagueplayers', {
    season_id: season.id,
    captain: true,
    active: true,
  });

  if (!Array.isArray(allMatches) || allMatches.length === 0) {
    throw new Error(`No matches found for ${cfg.franchiseName} in ${matchType}.`);
  }

  let anchorMatchNum;
  if (cfg.matchNum) anchorMatchNum = cfg.matchNum;
  else if (cfg.weekNum) anchorMatchNum = cfg.weekNum * 2 - 1;
  else anchorMatchNum = inferMatchNumToRender(allMatches);

  const weeklyMatches = selectWeekBlockMatches(allMatches, anchorMatchNum);
  if (weeklyMatches.length === 0) {
    throw new Error(`No matches found for week ${cfg.weekNum || Math.ceil(anchorMatchNum / 2)} (anchor match ${anchorMatchNum}).`);
  }

  const logosByName = new Map();
  const franchiseIdByName = new Map();
  for (const f of allFranchises) {
    logosByName.set(normalizeText(f.name), f.logo || null);
    franchiseIdByName.set(normalizeText(f.name), f.id);
  }
  const captainByFranchiseTier = buildCaptainMap(captainPlayers);

  const tierOrder = new Map(
    tiers.map((t) => [normalizeText(t.name), Number.isFinite(t.order) ? t.order : 999])
  );

  const matchesByTier = groupBy(weeklyMatches, (m) => m.tier);
  const orderedTiers = [...matchesByTier.keys()].sort((a, b) => {
    const orderA = tierOrder.get(normalizeText(a)) ?? 999;
    const orderB = tierOrder.get(normalizeText(b)) ?? 999;
    return orderA - orderB;
  });
  const selectedTier = selectTier(orderedTiers, cfg.tierName);

  const franchiseLogoData = await loadLogoDataUri(franchise.logo);
  await fs.mkdir(cfg.outDir, { recursive: true });

  const matchNumsInBlock = [...new Set(weeklyMatches.map((m) => m.Match.match_num))].sort((a, b) => a - b);
  const displayWeekNum = cfg.weekNum || Math.ceil(anchorMatchNum / 2);
  const embeddedFontCss = await getEmbeddedFontCss();
  const rendered = [];

  for (const tierName of selectedTier ? [selectedTier] : orderedTiers) {
    const tierMatches = matchesByTier.get(tierName).sort((a, b) => {
      const aDate = new Date(a.Reschedule?.reschedule_date || a.Match.date).getTime();
      const bDate = new Date(b.Reschedule?.reschedule_date || b.Match.date).getTime();
      return aDate - bDate;
    });

    const tierTimesKey = normalizeText(tierName);
    const tierTimeSlots = TIER_TIMES[tierTimesKey] || null;

    const rows = [];
    for (const [i, match] of tierMatches.entries()) {
      const isHome = normalizeText(match.home) === normalizeText(cfg.franchiseName);
      const opponentName = isHome ? match.away : match.home;
      const opponentLogoUrl = logosByName.get(normalizeText(opponentName)) || null;
      const opponentFranchiseId = franchiseIdByName.get(normalizeText(opponentName));
      const captainName = getCaptainName(captainByFranchiseTier, opponentFranchiseId, tierName);
      const isRescheduled = !!match.Reschedule?.reschedule_date;
      const tierTime = !isRescheduled && tierTimeSlots ? tierTimeSlots[i] : null;
      const matchDate = match.Reschedule?.reschedule_date || match.Match.date;

      rows.push({
        opponentName,
        captainName,
        opponentLogoData: await loadLogoDataUri(opponentLogoUrl),
        homeAway: isHome ? 'HOME' : 'AWAY',
        matchNum: match.Match.match_num,
        dateText: formatMatchDate(matchDate),
        timeText: tierTime ?? formatMatchTimeOnly(matchDate),
        boText: `BO${match.Match.best_of}`,
      });
    }

    const png = await renderTierSchedulePng({
      seasonNumber: season.number,
      matchType,
      displayWeekNum,
      matchNumsInBlock,
      franchiseName: cfg.franchiseName,
      franchiseColor: franchise.color || '#d8ae52',
      franchiseLogoData,
      tierName,
      tierColor: findTierColor(tiers, tierName),
      rows,
      embeddedFontCss,
    });

    const safeTier = slugify(tierName);
    const fileName = `${slugify(cfg.franchiseName)}-${matchType.toLowerCase()}-week-${anchorMatchNum}-${safeTier}.png`;
    const outPath = path.join(cfg.outDir, fileName);

    await fs.writeFile(outPath, png);
    rendered.push({ tierName, outPath });
  }

  return {
    seasonNumber: season.number,
    matchType,
    anchorMatchNum,
    displayWeekNum,
    selectedTier,
    matchNumsInBlock,
    rendered,
  };
}

async function main() {
  if (!baseCfg.weekNum && !baseCfg.matchNum) {
    console.error('Error: --week <number> or --match-num <number> is required');
    process.exitCode = 1;
    return;
  }
  const result = await generateTierScheduleImages();
  console.log(`Rendered ${result.rendered.length} tier image(s).`);
  for (const item of result.rendered) console.log(`- ${item.outPath}`);
}

async function renderTierSchedulePng({
  seasonNumber,
  matchType,
  displayWeekNum,
  matchNumsInBlock,
  franchiseName,
  franchiseColor,
  franchiseLogoData,
  tierName,
  tierColor,
  rows,
  embeddedFontCss,
}) {
  const width = 1400;
  const rowHeight = 160;
  const headerHeight = 248; // card at y=24, h=200, 24px bottom margin
  const footerHeight = 52;
  const rowGap = 8;
  const paddingV = 16;
  const contentHeight = rows.length * rowHeight + Math.max(rows.length - 1, 0) * rowGap + paddingV * 2;
  const height = headerHeight + contentHeight + footerHeight;

  const tc = hexToRgb(tierColor) || { r: 168, g: 179, b: 214 };

  // Shared card geometry
  const cardX = 40;
  const cardW = width - 80; // 1320

  // Row geometry (constants, per-row cardY varies)
  const accentW = 6;
  const rowContentX = cardX + accentW + 22; // 68
  const timePanelW = 280;
  const timePanelX = cardX + cardW - timePanelW; // 1080
  const logoR = 38;
  const logoCx = timePanelX + timePanelW - logoR - 18; // 1304
  const timeTextCx = Math.round((timePanelX + logoCx - logoR - 12) / 2); // ~1167

  // ── Header ───────────────────────────────────────────────────────────────
  const hY = 24;
  const hH = 200;
  const hLeftW = 300;
  const hLogoCx = cardX + hLeftW / 2; // 190
  const hLogoCy = hY + hH / 2;        // 124
  const hContentX = cardX + hLeftW + 28; // 368
  const tierLabel = tierName.toUpperCase();
  const tierBadgeW = Math.max(tierLabel.length * 13 + 36, 80);
  const tierBadgeX = cardX + cardW - tierBadgeW - 20;

  const headerSvg = `
    <defs>
      <clipPath id="hClip">
        <rect x="${cardX}" y="${hY}" width="${cardW}" height="${hH}" rx="20"/>
      </clipPath>
      <linearGradient id="hPanelGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="70%"  stop-color="${franchiseColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${franchiseColor}" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="hLogoClip">
        <circle cx="${hLogoCx}" cy="${hLogoCy}" r="66"/>
      </clipPath>
    </defs>

    <!-- Header card -->
    <rect x="${cardX}" y="${hY}" width="${cardW}" height="${hH}" rx="20" fill="#0b1127"/>

    <!-- Top accent stripe (clipped to card rx) -->
    <rect x="${cardX}" y="${hY}" width="${cardW}" height="4" fill="${franchiseColor}" clip-path="url(#hClip)"/>

    <!-- Franchise color left panel -->
    <rect x="${cardX}" y="${hY}" width="${hLeftW}" height="${hH}" fill="url(#hPanelGrad)" clip-path="url(#hClip)"/>

    <!-- Panel divider -->
    <line x1="${cardX + hLeftW}" y1="${hY + 30}" x2="${cardX + hLeftW}" y2="${hY + hH - 30}"
          stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

    <!-- Logo background -->
    <circle cx="${hLogoCx}" cy="${hLogoCy}" r="70" fill="rgba(0,0,0,0.22)"/>
    <circle cx="${hLogoCx}" cy="${hLogoCy}" r="66" fill="rgba(0,0,0,0.18)"
            stroke="rgba(255,255,255,0.13)" stroke-width="1.5"/>

    ${franchiseLogoData
      ? `<image x="${hLogoCx - 66}" y="${hLogoCy - 66}" width="132" height="132"
               href="${franchiseLogoData}" clip-path="url(#hLogoClip)"/>`
      : ''}

    <!-- Tier badge -->
    <rect x="${tierBadgeX}" y="${hY + 20}" width="${tierBadgeW}" height="30" rx="15"
          fill="rgba(${tc.r},${tc.g},${tc.b},0.12)" stroke="${tierColor}" stroke-width="1.5"/>
    <text x="${tierBadgeX + tierBadgeW / 2}" y="${hY + 40}" text-anchor="middle"
          font-size="14" font-weight="800" fill="${tierColor}"
          letter-spacing="1.5">${escapeXml(tierLabel)}</text>

    <!-- Franchise name -->
    <text x="${hContentX}" y="${hY + 113}" font-size="62" font-weight="900"
          fill="#ffffff" letter-spacing="-1.5">${escapeXml(franchiseName)}</text>

    <!-- Info line -->
    <text x="${hContentX}" y="${hY + 152}" font-size="22" font-weight="700"
          fill="${franchiseColor}" opacity="0.92">
      ${escapeXml(matchType)} · Season ${seasonNumber} · Week ${displayWeekNum}
    </text>

    <!-- Subtitle label -->
    <text x="${hContentX + 2}" y="${hY + 183}" font-size="13" font-weight="600"
          fill="rgba(255,255,255,0.28)" letter-spacing="3.5">TIER SCHEDULE</text>
  `;

  // ── Rows ─────────────────────────────────────────────────────────────────
  const rowSvgs = rows.map((row, i) => {
    const cardY = headerHeight + paddingV + i * (rowHeight + rowGap);
    const cardH = rowHeight;
    const isHome = row.homeAway === 'HOME';
    const tagColor = isHome ? '#4ade80' : '#60a5fa';
    const tagBg    = isHome ? 'rgba(74,222,128,0.1)' : 'rgba(96,165,250,0.1)';
    const logoCyRow = cardY + cardH / 2;

    return `
      <defs>
        <clipPath id="rClip${i}">
          <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14"/>
        </clipPath>
        <clipPath id="oClip${i}">
          <circle cx="${logoCx}" cy="${logoCyRow}" r="${logoR}"/>
        </clipPath>
      </defs>

      <!-- Row card -->
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="#0b1127"/>

      <!-- Accent bar -->
      <rect x="${cardX}" y="${cardY}" width="${accentW}" height="${cardH}"
            fill="${tagColor}" clip-path="url(#rClip${i})"/>

      <!-- Time panel background -->
      <rect x="${timePanelX}" y="${cardY}" width="${timePanelW}" height="${cardH}"
            fill="rgba(255,255,255,0.022)" clip-path="url(#rClip${i})"/>
      <line x1="${timePanelX}" y1="${cardY + 22}" x2="${timePanelX}" y2="${cardY + cardH - 22}"
            stroke="rgba(255,255,255,0.055)" stroke-width="1"/>

      <!-- HOME/AWAY tag -->
      <rect x="${rowContentX}" y="${cardY + 14}" width="72" height="25" rx="7"
            fill="${tagBg}" stroke="${tagColor}" stroke-width="1.2"/>
      <text x="${rowContentX + 36}" y="${cardY + 31}" text-anchor="middle"
            font-size="12" font-weight="800" fill="${tagColor}"
            letter-spacing="1.5">${row.homeAway}</text>

      <!-- Match number badge -->
      <rect x="${rowContentX + 80}" y="${cardY + 14}" width="78" height="25" rx="7"
            fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
      <text x="${rowContentX + 119}" y="${cardY + 31}" text-anchor="middle"
            font-size="12" font-weight="700" fill="rgba(155,175,225,0.55)"
            letter-spacing="0.5">Match ${row.matchNum}</text>

      <!-- Opponent name -->
      <text x="${rowContentX}" y="${cardY + 93}" font-size="50" font-weight="900"
            fill="#edf2ff" letter-spacing="-0.5">${escapeXml(row.opponentName)}</text>

      <!-- Captain -->
      <text x="${rowContentX}" y="${cardY + 134}" font-size="19"
            fill="rgba(155,175,225,0.58)" font-weight="500">Captain
        <tspan font-weight="700" fill="rgba(210,225,255,0.88)">${escapeXml(row.captainName || 'TBD')}</tspan>
      </text>

      <!-- Date -->
      <text x="${timeTextCx}" y="${cardY + 58}" text-anchor="middle"
            font-size="16" font-weight="600" fill="rgba(145,165,220,0.62)"
            letter-spacing="0.3">${escapeXml(row.dateText)}</text>

      <!-- Time -->
      <text x="${timeTextCx}" y="${cardY + 99}" text-anchor="middle"
            font-size="26" font-weight="800" fill="#edf2ff">${escapeXml(row.timeText)}</text>

      <!-- BO badge -->
      <rect x="${timeTextCx - 30}" y="${cardY + 110}" width="60" height="26" rx="8"
            fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>
      <text x="${timeTextCx}" y="${cardY + 128}" text-anchor="middle"
            font-size="14" font-weight="800" fill="rgba(165,185,235,0.85)"
            letter-spacing="1">${escapeXml(row.boText)}</text>

      <!-- Opponent logo -->
      <circle cx="${logoCx}" cy="${logoCyRow}" r="${logoR + 3}"
              fill="rgba(5,8,20,0.85)" stroke="rgba(255,255,255,0.07)" stroke-width="1.5"/>
      ${row.opponentLogoData
        ? `<image x="${logoCx - logoR}" y="${logoCyRow - logoR}" width="${logoR * 2}" height="${logoR * 2}"
                  href="${row.opponentLogoData}" clip-path="url(#oClip${i})"/>`
        : `<text x="${logoCx}" y="${logoCyRow + 10}" text-anchor="middle"
                 font-size="28" fill="rgba(155,175,225,0.25)">?</text>`}
    `;
  }).join('');

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY = height - footerHeight;
  const footerSvg = `
    <line x1="${cardX}" y1="${footerY + 14}" x2="${width - cardX}" y2="${footerY + 14}"
          stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
    <text x="${width - cardX}" y="${footerY + 38}" text-anchor="end"
          font-size="15" fill="rgba(85,105,165,0.58)"
          letter-spacing="0.3">api.playcsa.com</text>
  `;

  // ── Full SVG ───────────────────────────────────────────────────────────────
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#07091c"/>

      <style>
        ${embeddedFontCss}
        text { font-family: "InterEmbedded", Arial, Helvetica, sans-serif; }
      </style>

      ${headerSvg}
      ${rowSvgs}
      ${footerSvg}
    </svg>
  `;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// Helpers

function hexToRgb(hex) {
  if (!hex) return null;
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
}

function selectWeekBlockMatches(allMatches, anchorMatchNum) {
  const anchorMatches = allMatches.filter((m) => m.Match.match_num === anchorMatchNum);
  if (anchorMatches.length === 0) return [];
  const dateKeys = new Set(anchorMatches.map((m) => scheduleDateKey(m)));
  return allMatches.filter((m) => dateKeys.has(scheduleDateKey(m)));
}

function scheduleDateKey(match) {
  const iso = match.Reschedule?.reschedule_date || match.Match.date;
  return String(iso).slice(0, 10);
}


function selectTier(availableTiers, requestedTier) {
  if (!requestedTier) return null;
  const requestedNorm = normalizeTierName(requestedTier);
  if (!requestedNorm) return null;

  const found = availableTiers.find((tier) => normalizeTierName(tier) === requestedNorm);
  if (found) return found;

  throw new Error(
    `Tier "${requestedTier}" not found for this week. Available tiers: ${availableTiers.join(', ')}.`
  );
}

function getCurrentWeekWindow() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  let start;
  if (day === 3 || day > 3) {
    // Wed–Sat: snap forward to next Sunday
    const daysUntilSunday = (7 - day) % 7;
    start = new Date(now);
    start.setDate(now.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  } else {
    // Sun–Tue: snap back to last Sunday
    start = new Date(now);
    start.setDate(now.getDate() - day);
  }
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function inferMatchNumToRender(allMatches) {
  const { start, end } = getCurrentWeekWindow();
  const thisWeek = allMatches.filter((m) => {
    const iso = m.Reschedule?.reschedule_date || m.Match.date;
    const date = new Date(String(iso).slice(0, 10));
    return date >= start && date <= end;
  });
  if (thisWeek.length > 0) {
    const nums = thisWeek.map((m) => m.Match.match_num).filter(Boolean);
    return Math.min(...nums);
  }
  // fallback: most recent match
  const allNums = allMatches.map((m) => m.Match.match_num).filter(Boolean);
  return Math.max(...allNums);
}

function findTierColor(tiers, tierName) {
  const tier = tiers.find((t) => normalizeText(t.name) === normalizeText(tierName));
  return tier?.color || '#a8b3d6';
}

function findFranchiseByName(franchises, name) {
  const target = normalizeText(name);
  return franchises.find((f) => normalizeText(f.name) === target) || null;
}

async function getCurrentSeason() {
  const seasons = await csaGet('/general/seasons', { current: true });
  if (!Array.isArray(seasons) || seasons.length === 0) {
    throw new Error('CSA returned no current season.');
  }
  return seasons[0];
}

async function csaGet(pathname, query = {}, options = {}) {
  const shouldPaginate =
    options.paginate ??
    (query.page === undefined && query.size === undefined);

  const pageSize = query.size ?? options.size ?? 100;
  let page = query.page ?? 1;
  const allItems = [];

  while (true) {
    const url = new URL(pathname, runtimeCfg.csaBaseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(pageSize));

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CSA request failed (${res.status}) ${url.pathname}: ${body.slice(0, 220)}`);
    }

    const payload = await res.json();

    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
      return payload;
    }

    const data = payload.data;
    if (!Array.isArray(data)) {
      return data;
    }

    allItems.push(...data);
    const totalPages = Number(payload.total_pages) || 1;

    if (!shouldPaginate || page >= totalPages) {
      return allItems;
    }

    page += 1;
  }
}

async function loadLogoDataUri(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function formatMatchDate(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: runtimeCfg.timezone,
  }).format(date);
}

function formatMatchTimeOnly(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: runtimeCfg.timezone,
    timeZoneName: 'short',
  }).format(date);
}

function buildCaptainMap(captainPlayers) {
  const map = new Map();
  if (!Array.isArray(captainPlayers)) return map;
  for (const p of captainPlayers) {
    const franchiseId = p?.Franchise?.id;
    const tierName = p?.tier;
    const captainName = p?.Player?.csa_name;
    if (!franchiseId || !tierName || !captainName) continue;
    const key = `${franchiseId}:${normalizeText(tierName)}`;
    if (!map.has(key)) map.set(key, captainName);
  }
  return map;
}

function getCaptainName(captainByFranchiseTier, franchiseId, tierName) {
  if (!franchiseId || !tierName) return null;
  return captainByFranchiseTier.get(`${franchiseId}:${normalizeText(tierName)}`) || null;
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

function slugify(v) {
  return String(v || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeTierName(v) {
  return normalizeText(v).replace(/[^a-z0-9]/g, '');
}

function parseIntOrNull(v) {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function argValue(flag) {
  const idx = process.argv.findIndex((a) => a === flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getEmbeddedFontCss() {
  if (embeddedFontCssCache) return embeddedFontCssCache;

  try {
    const [regularBytes, boldBytes] = await Promise.all([
      fs.readFile(interRegularPath),
      fs.readFile(interBoldPath),
    ]);
    const regularBase64 = regularBytes.toString('base64');
    const boldBase64 = boldBytes.toString('base64');

    embeddedFontCssCache = [
      '@font-face {',
      'font-family: "InterEmbedded";',
      `src: url("data:font/woff2;base64,${regularBase64}") format("woff2");`,
      'font-weight: 400;',
      'font-style: normal;',
      '}',
      '@font-face {',
      'font-family: "InterEmbedded";',
      `src: url("data:font/woff2;base64,${boldBase64}") format("woff2");`,
      'font-weight: 700;',
      'font-style: normal;',
      '}',
    ].join('');
  } catch {
    embeddedFontCssCache = '';
  }

  return embeddedFontCssCache;
}

if (isCliEntry()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function buildConfig(overrides = {}) {
  const cfg = { ...baseCfg };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    cfg[key] = value;
  }
  return cfg;
}

function isCliEntry() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  return entry === __filename;
}
