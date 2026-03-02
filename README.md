# SanBot

Discord bot for the **San Antonio Stallions** (CSA) that posts weekly schedules into each tier category's `#schedule` channel.

## Current feature set

- Weekly auto-post of Stallions schedules, grouped by tier.
- Posts into `#schedule` text channels under tier categories (matched by tier name/abbr).
- Dedupe guard to avoid reposting the same season/week automatically.
- Manual slash command: `/postschedule` (requires `Manage Server`).

## Requirements

- Node.js 20+
- A Discord bot token with permissions in your guild:
  - `View Channels`
  - `Send Messages`
  - `Use Slash Commands`
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

4. Run:

```bash
npm start
```

## Configuration

- `CSA_FRANCHISE_NAME` (default: `San Antonio Stallions`)
- `SCHEDULE_CHANNEL_NAME` (default: `schedule`)
- `WEEKLY_CRON` (default: `0 12 * * 1`)  
  Runs every Monday at 12:00 in configured timezone.
- `TIMEZONE` (default: `America/Chicago`)
- `CSA_MATCH_TYPE` and `CSA_MATCH_NUM` can be set for testing/forced week selection.

## How week selection works

If no overrides are provided, the bot:

1. Loads current season from `/general/seasons?current=true`.
2. Uses season `current_stage` as match type (fallback `REG`).
3. Finds the first week with future or unreported matches for the Stallions.
4. Posts that week's matches from `/matches`.

## Notes

- Automatic posts are tracked in `data/state.json`.
- `/postschedule` ignores dedupe and forces a post.
