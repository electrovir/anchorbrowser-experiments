# anchorbrowser-experiments

Experiments comparing automation/bot detection between a remote [Anchor Browser](https://anchorbrowser.io)
session and a local browser, both driven with
[`@electrovir/rebrowser-playwright`](https://www.npmjs.com/package/@electrovir/rebrowser-playwright).
Each script drives both runners and saves screenshots to `.not-committed/` for side-by-side
comparison.

## Setup

1. Clone the repo
2. `npm ci`
3. Install Chrome: `npx playwright install chrome` (playwright will ask for sudo access).
4. Save your Anchor Browser API key as `{"apiKey":"<insert-here>"}` in `.not-committed/secrets.json`.

## Scripts

-   test any URL: `npm start <url>`
-   run bot detection: `npm run bot-detect`
-   download a file: `npm run download`
-   verify session persistence: `npm run session-persist`

Screenshots for both are saved into `./.not-committed`.
