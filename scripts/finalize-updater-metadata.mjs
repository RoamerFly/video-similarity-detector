#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const version = process.env.TAG_NAME || process.env.VERSION || process.argv[2] || ''
const repository = process.env.GITHUB_REPOSITORY || process.argv[3] || ''
const assetDir = process.env.ASSET_DIR || process.argv[4] || 'release-assets'
const notesPath = process.env.RELEASE_NOTES_FILE || process.argv[5] || 'release_body.md'

if (!version.startsWith('v')) {
  throw new Error('Release tag must start with v, for example v1.0.0')
}
if (!repository.includes('/')) {
  throw new Error('GITHUB_REPOSITORY must be set, for example owner/repo')
}

const appVersion = version.slice(1)
const baseUrl = `https://github.com/${repository}/releases/download/${version}`
const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : ''

function readSignature(assetName) {
  const sigPath = path.join(assetDir, `${assetName}.sig`)
  if (!fs.existsSync(sigPath)) {
    throw new Error(`Missing updater signature: ${sigPath}`)
  }
  return fs.readFileSync(sigPath, 'utf8').replace(/[\r\n]/g, '')
}

function platform(assetName) {
  return {
    signature: readSignature(assetName),
    url: `${baseUrl}/${assetName}`,
  }
}

const cpuAsset = `Video_Similarity-${version}-windows-x64-cpu-installer.exe`
const gpuAsset = `Video_Similarity-${version}-windows-x64-gpu-installer.exe`
const macosArmAsset = `Video_Similarity-${version}-macos-arm64-installer.dmg`
const macosX64Asset = `Video_Similarity-${version}-macos-x64-installer.dmg`
const linuxAsset = `Video_Similarity-${version}-linux-x64-installer.deb`

function metadata(platforms) {
  return {
    version: appVersion,
    notes: notes || `Video Similarity v${appVersion}`,
    pub_date: new Date().toISOString(),
    platforms,
  }
}

const windowsPlatforms = {
  'windows-x86_64-cpu': platform(cpuAsset),
  'windows-x86_64-gpu': platform(gpuAsset),
  'windows-x86_64-nsis': platform(cpuAsset),
  'windows-x86_64': platform(cpuAsset),
}

const darwinPlatforms = {
  'darwin-aarch64': platform(macosArmAsset),
  'darwin-x86_64': platform(macosX64Asset),
}

const linuxPlatforms = {
  'linux-x86_64': platform(linuxAsset),
}

const latestMetadata = metadata({
  ...windowsPlatforms,
  ...darwinPlatforms,
  ...linuxPlatforms,
})

const outputs = {
  'latest.json': latestMetadata,
  'windows.json': metadata(windowsPlatforms),
  'darwin.json': metadata(darwinPlatforms),
  'linux.json': metadata(linuxPlatforms),
}

for (const [output, data] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(assetDir, output), `${JSON.stringify(data, null, 2)}\n`)
}

console.log(`Generated updater metadata for ${version}: ${Object.keys(outputs).join(', ')}`)
