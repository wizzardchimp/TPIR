# TPIR Scores

Party scoreboard for "The Price Is Right"-style guessing games.

## Railway setup
Variables:
- `ADMIN_TOKEN` - host password (required in production; without it anyone can host/edit rounds).
- `PUBLIC_URL` - public URL used in the QR code, e.g. `https://your-app.up.railway.app`.
- `DATABASE_URL` - add the Railway **Postgres** plugin and reference its URL. Rounds are then stored in the cloud and survive redeploys.
  - Alternative: mount a Railway Volume and set `DATA_DIR` to its mount path (rounds saved as JSON there).

Without either, rounds are written to `./data/rounds.json`, which Railway wipes on each deploy.

## Rounds
Rounds live server-side (seeded once from `seed/default-rounds.json`). Edit them on the host page and press
"Save to cloud"; every host sees the change immediately. Prices are only served to authenticated hosts.
