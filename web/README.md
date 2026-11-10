# web/: the guild's download page

A single static page for **HowBowWoW** (casual, dungeons and PvP) whose main job is getting guildmates the
Guild Camp desktop app. The buttons look up the newest `v*` release on GitHub in the browser and link
straight to its `Guild-Camp-Setup-<version>.exe`; if that lookup fails they open the latest release page.

Served by nginx on port 3000. Deployed by Coolify from `main` (base directory `/`, Dockerfile `/web/Dockerfile`,
health check `/healthz`) at https://wow.quiver.bslr.co.za. `/get` shows the page (the guild MOTD links there),
`/download` redirects to the latest release.

Nothing here talks to a server: the app and addon work without it (see `docs/PIVOT.md`).
