#!/usr/bin/env bash
# Forge requires a configured set of both JVM and program arguments.
# Add custom JVM arguments to the user_jvm_args.txt
# Add custom program arguments {such as nogui} to this file in the next line before the "$@" or
#  pass them to this script directly
set -euo pipefail

BASE_DIR="/home/container"
MATCH_DIR="$BASE_DIR/match"
MAPS_DIR="$BASE_DIR/maps"
WORLD_DIR="$BASE_DIR/world"
JOB_FILE="$MATCH_DIR/job.json"
STATE_FILE="$MATCH_DIR/state.json"

announce() {
  echo "[matchmaker] $1"
}

# Ensure needed dirs exist
mkdir -p "$MATCH_DIR" "$MAPS_DIR"

# If a job exists, apply it before launching the server
if [[ -f "$JOB_FILE" ]]; then
  announce "Job file detected. Preparing world..."

  # Read map name from job.json (no jq—keep it simple)
  MAP_NAME=$(sed -n 's/.*"map"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$JOB_FILE" || true)

  if [[ -z "$MAP_NAME" ]]; then
    announce "Error: map not specified in $JOB_FILE"; exit 1
  fi

  ZIP_PATH="$MAPS_DIR/${MAP_NAME}.zip"
  if [[ ! -f "$ZIP_PATH" ]]; then
    announce "Error: map zip not found: $ZIP_PATH"; exit 1
  fi

  announce "Removing old world..."
  rm -rf "$WORLD_DIR"

  announce "Unzipping map: $MAP_NAME"
  # Extract directly into a temp directory to avoid conflicts
  TEMP_EXTRACT="$BASE_DIR/temp_extract_$$"
  mkdir -p "$TEMP_EXTRACT"
  cd "$TEMP_EXTRACT"
  jar xf "$ZIP_PATH" || {
    announce "Error: Failed to extract map zip"
    cd "$BASE_DIR"
    rm -rf "$TEMP_EXTRACT"
    exit 1
  }
  cd "$BASE_DIR"  # Move back to base dir before manipulating directories

  # If your zip contains a folder (e.g., 'world/'), move it into place
  # Try to detect the top-level dir if needed
  if [[ -f "$TEMP_EXTRACT/level.dat" ]]; then
    # Extracted files are directly in temp dir
    mv "$TEMP_EXTRACT" "$WORLD_DIR"
  else
    # Find the first folder with level.dat and move it to /world
    CANDIDATE=$(find "$TEMP_EXTRACT" -maxdepth 2 -type f -name "level.dat" -printf '%h\n' | head -n1)
    if [[ -n "$CANDIDATE" ]]; then
      mv "$CANDIDATE" "$WORLD_DIR"
      rm -rf "$TEMP_EXTRACT"
    else
      announce "Error: No level.dat found in extracted map"
      rm -rf "$TEMP_EXTRACT"
      exit 1
    fi
  fi

  # Clear whitelist so only new players will be added post-start
  echo "[]" > "$BASE_DIR/whitelist.json"

  # Record the applied map in state
  cat > "$STATE_FILE" <<EOF
{"active": true, "map": "$MAP_NAME", "started_at": "$(date -Iseconds)"}
EOF

  announce "World prepared."
  # Leave $JOB_FILE for the bot to read if it wants to add players later, or remove it now if you prefer.
fi

# Launch the Forge server
announce "Starting Minecraft server..."
java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.4.10/unix_args.txt "$@"
