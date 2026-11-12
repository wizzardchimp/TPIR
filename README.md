# WMROCU'S Price Is Right

Party price-guessing show: a big-screen display (`/`) plus phone handsets (`/play`).

## Run locally
```
npm install
HOST_PIN=1234 npm start
```

## Railway variables
- `HOST_PIN` - host PIN (required; the default `1234` is only for local use).
- `DATA_DIR` - persistent volume path (e.g. `/data`). Rounds you edit in the host editor are saved here, so they
  survive deploys and are shared by everyone using the show.
- `PUBLIC_URL` - public URL used for the QR code, e.g. `https://tpir.up.railway.app`.

## Notes
- All host actions require the PIN-derived host token; players cannot call them.
- Bids are hidden from other phones until the host locks bids.
- A show session resets after 3 hours of inactivity (never mid-game).
- `data/default.json` seeds the rounds on first run; later edits live in `$DATA_DIR/settings.json`.
