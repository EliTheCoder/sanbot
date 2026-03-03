# SanBot

Discord bot for the **San Antonio Stallions** (CSA) that posts schedule **images** into each tier category's `#schedule` channel.

## Current feature set

- Command-only posting via `/postschedule` (requires `Manage Server`).
- Generates one image per tier for the selected week block.
- Includes opponent logos, home/away, match time, BO, and opposing team captain.
- Posts each tier image into `#schedule` under the matching tier category.

## Requirements

- Node.js 20+
- A Discord bot token with permissions in your guild:
  - `View Channels`
  - `Send Messages`
  - `Use Slash Commands`
  - `Attach Files`
- Channels structured with a `#schedule` text channel inside each tier category.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill required env vars in `.env`:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`

4. Start bot:

```bash
npm start
```

5. In Discord, run:

```text
/postschedule
```

Optional single-tier post:

```text
/postschedule tier:Elite
```

## Configuration

- `CSA_BASE_URL` (default: `https://api.playcsa.com`)
- `CSA_FRANCHISE_NAME` (default: `San Antonio Stallions`)
- `SCHEDULE_CHANNEL_NAME` (default: `schedule`)
- `TIMEZONE` (default: `America/New_York`)
- `SCHEDULE_IMAGE_OUT_DIR` (default: `output`)
- `CSA_MATCH_TYPE` and `CSA_MATCH_NUM` for forcing a specific render target.

## Manual Render (without bot)

```bash
npm run render-schedule -- --week 2 --type REG --out-dir output
```
