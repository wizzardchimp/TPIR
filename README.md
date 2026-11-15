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
- `BRAVE_API_KEY` - optional. Without it, "Find photo" uses free Wikimedia Commons images and "Suggest" price lookups are off. With a key (brave.com/search/api, Search plan) photos come from Brave image search and "Suggest" works.
- `PUBLIC_URL` - public URL used for the QR code, e.g. `https://tpir.up.railway.app`.

## Host controls
- **Space** (or a clicker: Right arrow / Page Down / `.`) always runs the next step: Start game -> Lock bids -> Reveal price -> Show scores -> Next round -> ... -> Reveal board -> New game. The big toolbar button shows what it will do.
- `S` guesses, `Q` join code, `F` fullscreen. The gear opens Settings (rounds, show text, players, session).
- Players join with the QR, `yourdomain/ABC`, or by typing the 3-letter room code on `/play`.

## Game sets
There are three sets (Default, Set 2, Set 3). The pristine version of each lives in git in `sets/<id>.json`.
Edits made in the settings console are saved to the data volume (`$DATA_DIR/sets/<id>.json`), so they survive deploys
without touching git. **Reset to original** deletes the saved copy. To make an edited set the new baseline, use
**Export this set** and commit the downloaded file over `sets/<id>.json`. The set you press *Play this set* on
is remembered across restarts. Switching is only allowed from the title screen.

## Photo search and price suggestions
In a round, type the item and press **Find photo** for three web photos (**Show others** for more; the chosen one is copied to
`$DATA_DIR/uploads`). **Suggest** lists prices found in web search results with their website; pick one or type your own.
Source is always typed by you.

## Notes
- Host actions need a host token. With no `HOST_PIN`, the big-screen page fetches it automatically; the `/play` phone page never does.
- Bids are hidden from other phones until the host locks bids.
- A show session resets after 3 hours of inactivity (never mid-game).
- `data/default.json` seeds the rounds on first run; later edits live in `$DATA_DIR/settings.json`.
