# WMROCU'S Price Is Right

Party price-guessing show: a big-screen display (`/`) plus phone handsets (`/play`).

## Run locally
```
npm install
npm start
```

## Railway variables
- `HOST_PIN` - optional. Leave it unset for no PIN: the host screen (`/`) is trusted automatically. Set it to require a PIN.
- `DATA_DIR` - persistent volume path (e.g. `/data`). Rounds you edit in the host editor are saved here, so they
  survive deploys and are shared by everyone using the show.
- `PUBLIC_URL` - public URL used for the QR code, e.g. `https://tpir.up.railway.app`.

## Notes
- Host actions need a host token. With no `HOST_PIN`, the big-screen page fetches it automatically; the `/play` phone page never does.
- Bids are hidden from other phones until the host locks bids.
- A show session resets after 3 hours of inactivity (never mid-game).
- `data/default.json` seeds the rounds on first run; later edits live in `$DATA_DIR/settings.json`.
