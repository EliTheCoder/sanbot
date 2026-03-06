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
  matchNum: parseIntOrNull(argValue('--week') || process.env.CSA_MATCH_NUM),
  tierName: argValue('--tier') || process.env.CSA_TIER_NAME || null,
  outDir:
    argValue('--out-dir') ||
    process.env.SCHEDULE_IMAGE_OUT_DIR ||
    path.resolve(__dirname, '..', 'output'),
};

let runtimeCfg = { ...baseCfg };
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

  const anchorMatchNum = cfg.matchNum ?? inferMatchNumToRender(allMatches);
  const weeklyMatches = selectWeekBlockMatches(allMatches, anchorMatchNum);
  if (weeklyMatches.length === 0) {
    throw new Error(`No matches found for week ${anchorMatchNum}.`);
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
  const displayWeekNum = toDisplayWeekNum(matchNumsInBlock);
  const embeddedFontCss = await getEmbeddedFontCss();
  const rendered = [];

  for (const tierName of selectedTier ? [selectedTier] : orderedTiers) {
    const tierMatches = matchesByTier.get(tierName).sort((a, b) => {
      const aDate = new Date(a.Reschedule?.reschedule_date || a.Match.date).getTime();
      const bDate = new Date(b.Reschedule?.reschedule_date || b.Match.date).getTime();
      return aDate - bDate;
    });

    const rows = [];
    for (const match of tierMatches) {
      const isHome = normalizeText(match.home) === normalizeText(cfg.franchiseName);
      const opponentName = isHome ? match.away : match.home;
      const opponentLogoUrl = logosByName.get(normalizeText(opponentName)) || null;
      const opponentFranchiseId = franchiseIdByName.get(normalizeText(opponentName));
      const captainName = getCaptainName(captainByFranchiseTier, opponentFranchiseId, tierName);

      rows.push({
        opponentName,
        captainName,
        opponentLogoData: await loadLogoDataUri(opponentLogoUrl),
        homeAway: isHome ? 'HOME' : 'AWAY',
        matchNum: match.Match.match_num,
        timeText: formatMatchTime(match.Reschedule?.reschedule_date || match.Match.date),
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
  const rowHeight = 180;
  const headerHeight = 280;
  const footerHeight = 56;
  const rowGap = 12;
  const paddingV = 20;
  const contentHeight = rows.length * rowHeight + Math.max(rows.length - 1, 0) * rowGap + paddingV * 2;
  const height = headerHeight + contentHeight + footerHeight;

  // Parse franchise color for rgba usage
  const fc = hexToRgb(franchiseColor) || { r: 216, g: 174, b: 82 };
  const tc = hexToRgb(tierColor) || { r: 168, g: 179, b: 214 };

  const blockLabel = `Week ${displayWeekNum}`;

  // Row cards
  const rowSvgs = rows.map((row, i) => {
    const cardY = headerHeight + paddingV + i * (rowHeight + rowGap);
    const cardH = rowHeight;
    const isHome = row.homeAway === 'HOME';
    const tagColor = isHome ? '#22c55e' : '#60a5fa';
    const tagBg   = isHome ? 'rgba(34,197,94,0.12)' : 'rgba(96,165,250,0.12)';

    // Left accent bar color = home/away
    const accentBar = tagColor;

    // Logo area: right side, vertically centered
    const logoSize = 100;
    const logoX = width - 80 - logoSize;
    const logoY = cardY + (cardH - logoSize) / 2;
    const logoCx = logoX + logoSize / 2;
    const logoCy = logoY + logoSize / 2;

    // Time block: to the left of the logo
    const timeBlockRight = logoX - 24;

    return `
      <!-- Row ${i} card -->
      <rect x="56" y="${cardY}" width="${width - 112}" height="${cardH}" rx="20"
            fill="rgba(10,16,35,0.92)" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>

      <!-- Left accent bar -->
      <rect x="56" y="${cardY + 20}" width="5" height="${cardH - 40}" rx="3" fill="${accentBar}"/>

      <!-- Home/Away tag -->
      <rect x="86" y="${cardY + 22}" width="82" height="32" rx="8"
            fill="${tagBg}" stroke="${tagColor}" stroke-width="1.4"/>
      <text x="127" y="${cardY + 43}" text-anchor="middle"
            font-size="16" font-weight="800" fill="${tagColor}" letter-spacing="1.5">${row.homeAway}</text>

      <!-- Match number badge -->
      <rect x="180" y="${cardY + 22}" width="86" height="32" rx="8"
            fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" stroke-width="1.2"/>
      <text x="223" y="${cardY + 43}" text-anchor="middle"
            font-size="15" font-weight="700" fill="rgba(180,195,235,0.7)" letter-spacing="0.5">Match ${row.matchNum}</text>

      <!-- Opponent name -->
      <text x="86" y="${cardY + 104}" font-size="50" font-weight="900" fill="#f0f6ff"
            letter-spacing="-0.5">${escapeXml(row.opponentName)}</text>

      <!-- Captain label -->
      <text x="88" y="${cardY + 144}" font-size="22" fill="rgba(180,195,235,0.75)"
            font-weight="600">Captain</text>
      <text x="192" y="${cardY + 144}" font-size="22" fill="rgba(220,230,255,0.95)"
            font-weight="700">${escapeXml(row.captainName || 'TBD')}</text>

      <!-- Time & BO block -->
      <text x="${timeBlockRight}" y="${cardY + 85}" text-anchor="end"
            font-size="38" font-weight="800" fill="#f0f6ff">${escapeXml(row.timeText)}</text>
      <rect x="${timeBlockRight - 68}" y="${cardY + 100}" width="68" height="30" rx="8"
            fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
      <text x="${timeBlockRight - 34}" y="${cardY + 121}" text-anchor="middle"
            font-size="17" font-weight="800" fill="rgba(180,195,235,0.9)"
            letter-spacing="1">${escapeXml(row.boText)}</text>

      <!-- Opponent logo circle -->
      <circle cx="${logoCx}" cy="${logoCy}" r="${logoSize / 2 + 4}"
              fill="rgba(6,12,28,0.9)" stroke="rgba(255,255,255,0.1)" stroke-width="1.5"/>
      ${row.opponentLogoData
        ? `<image x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}"
                  href="${row.opponentLogoData}" clip-path="url(#logoClip${i})"/>`
        : `<text x="${logoCx}" y="${logoCy + 14}" text-anchor="middle"
                 font-size="36" fill="rgba(180,195,235,0.3)">?</text>`}
      <defs>
        <clipPath id="logoClip${i}">
          <circle cx="${logoCx}" cy="${logoCy}" r="${logoSize / 2}"/>
        </clipPath>
      </defs>
    `;
  }).join('');

  // Header
  const headerSvg = `
    <!-- Header card -->
    <rect x="56" y="40" width="${width - 112}" height="${headerHeight - 52}" rx="24"
          fill="rgba(8,14,30,0.97)" stroke="rgba(255,255,255,0.07)" stroke-width="1.5"/>

    <!-- Top color bar -->
    <rect x="56" y="40" width="${width - 112}" height="6" rx="3"
          fill="${franchiseColor}"/>

    <!-- Franchise logo circle -->
    <circle cx="160" cy="${40 + (headerHeight - 52) / 2}" r="72"
            fill="rgba(4,9,22,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
    ${franchiseLogoData
      ? `<image x="90" y="${40 + (headerHeight - 52) / 2 - 68}" width="140" height="140"
               href="${franchiseLogoData}" clip-path="url(#franchiseClip)"/>
         <defs>
           <clipPath id="franchiseClip">
             <circle cx="160" cy="${40 + (headerHeight - 52) / 2}" r="68"/>
           </clipPath>
         </defs>`
      : ''}

    <!-- Tier badge -->
    <rect x="264" y="72" width="${tierName.length * 14 + 40}" height="38" rx="19"
          fill="rgba(${tc.r},${tc.g},${tc.b},0.15)" stroke="${tierColor}" stroke-width="1.8"/>
    <text x="${264 + (tierName.length * 14 + 40) / 2}" y="97" text-anchor="middle"
          font-size="22" font-weight="800" fill="${tierColor}"
          letter-spacing="1">${escapeXml(tierName)}</text>

    <!-- Franchise name -->
    <text x="264" y="175" font-size="66" font-weight="900" fill="#f0f6ff"
          letter-spacing="-1">${escapeXml(franchiseName)}</text>

    <!-- Match info line -->
    <text x="264" y="220" font-size="30" font-weight="700"
          fill="${franchiseColor}">${escapeXml(matchType)} ${escapeXml(blockLabel)} | Season ${seasonNumber}</text>

    <!-- Subtle label -->
    <text x="264" y="252" font-size="18" font-weight="600"
          fill="rgba(150,168,215,0.6)" letter-spacing="2">TIER SCHEDULE</text>
  `;

  // Footer
  const footerY = height - footerHeight;
  const footerSvg = `
    <line x1="56" y1="${footerY + 12}" x2="${width - 56}" y2="${footerY + 12}"
          stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    <text x="${width - 60}" y="${footerY + 38}" text-anchor="end"
          font-size="16" fill="rgba(100,118,168,0.7)"
          letter-spacing="0.3">Generated from api.playcsa.com</text>
  `;

  // Full SVG
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%"   stop-color="#060c1e"/>
          <stop offset="50%"  stop-color="#0b1328"/>
          <stop offset="100%" stop-color="#111e38"/>
        </linearGradient>
        <!-- Subtle radial glow from franchise color top-right -->
        <radialGradient id="glowTR" cx="100%" cy="0%" r="55%">
          <stop offset="0%"   stop-color="${franchiseColor}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${franchiseColor}" stop-opacity="0"/>
        </radialGradient>
        <!-- Subtle radial glow bottom-left cool -->
        <radialGradient id="glowBL" cx="0%" cy="100%" r="45%">
          <stop offset="0%"   stop-color="#1e3a6e" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#1e3a6e" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <!-- Background -->
      <rect width="${width}" height="${height}" fill="url(#bg)"/>
      <rect width="${width}" height="${height}" fill="url(#glowTR)"/>
      <rect width="${width}" height="${height}" fill="url(#glowBL)"/>

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

function toDisplayWeekNum(matchNumsInBlock) {
  if (!Array.isArray(matchNumsInBlock) || matchNumsInBlock.length === 0) return 1;
  const maxNum = Math.max(...matchNumsInBlock);
  return Math.ceil(maxNum / 2);
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

function inferMatchNumToRender(allMatches) {
  const now = Date.now();
  const grouped = new Map();
  for (const m of allMatches) {
    const week = m.Match.match_num;
    if (!grouped.has(week)) grouped.set(week, []);
    grouped.get(week).push(m);
  }
  const weeks = [...grouped.keys()].sort((a, b) => a - b);
  for (const week of weeks) {
    const list = grouped.get(week);
    const hasUpcoming = list.some((m) => new Date(m.Reschedule?.reschedule_date || m.Match.date).getTime() >= now);
    const hasUnreported = list.some((m) => !m.Result?.is_reported);
    if (hasUpcoming || hasUnreported) return week;
  }
  return weeks[weeks.length - 1];
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

function formatMatchTime(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
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
