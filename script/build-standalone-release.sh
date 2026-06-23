#!/usr/bin/env bash
set -euo pipefail

version="${1:?version required}"
out_dir="${2:?output directory required}"

sdk_version="$(node -p "require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk']")"
mkdir -p "$out_dir"

platforms=(
  "darwin-arm64|bun-darwin-arm64|@anthropic-ai/claude-agent-sdk-darwin-arm64|claude-agent-acp|claude"
  "darwin-x64|bun-darwin-x64|@anthropic-ai/claude-agent-sdk-darwin-x64|claude-agent-acp|claude"
  "linux-arm64|bun-linux-arm64|@anthropic-ai/claude-agent-sdk-linux-arm64|claude-agent-acp|claude"
  "linux-x64|bun-linux-x64|@anthropic-ai/claude-agent-sdk-linux-x64|claude-agent-acp|claude"
  "win32-x64|bun-windows-x64|@anthropic-ai/claude-agent-sdk-win32-x64|claude-agent-acp.exe|claude.exe"
)

npm run build

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for item in "${platforms[@]}"; do
  IFS="|" read -r platform bun_target sdk_package adapter_binary sdk_binary <<< "$item"
  work="$tmp/$platform"
  mkdir -p "$work"

  bun build ./dist/index.js --compile --target="$bun_target" --outfile "$work/$adapter_binary"

  pack_json="$(cd "$work" && npm pack "${sdk_package}@${sdk_version}" --json)"
  pack_file="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); console.log(p[0].filename)' <<< "$pack_json")"
  tar -xzf "$work/$pack_file" -C "$work" "package/$sdk_binary"
  mv "$work/package/$sdk_binary" "$work/$sdk_binary"
  rm -rf "$work/package" "$work/$pack_file"

  chmod +x "$work/$adapter_binary" "$work/$sdk_binary"
  tar -C "$work" -czf "$out_dir/claude-agent-acp-${version}-${platform}.tar.gz" "$adapter_binary" "$sdk_binary"
done
