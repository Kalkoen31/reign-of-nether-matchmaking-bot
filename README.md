How it works.

Index.js
1. Checks if active match exists.
2. Writes to /match/job.json containing map, players, the discord user id of the match creator, creation timestamp.
3. Checks current server state using the Pterodactyl API.
4. Stops the server if needed.
5. Starts the server using the Pterodactyl API.
6. Waits for "running" status by Pterodactyl.

run.sh
8. Detects /match/job.json.
9. Removes old world.
10. Reads map name from job.json and extracts it.
11. Clears whitelist
12. Updates /match/state.json to include match status (active or not), map and creation date.
13. Starts the minecraft server itself.

Index.js
13. When marked "running" by Pterodactyl it whitelists the users provided in the start command.
14. Announces match ready.
