// Takes screenshots of the Graft dashboard.
// Requires puppeteer: npm install (already in devDependencies)
// Run: node scripts/screenshot.mjs  (bus must be running on localhost:7433)

import puppeteer from 'puppeteer'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR   = path.join(__dirname, '..', 'docs', 'screenshots')

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  console.log('Launching headless browser…')
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page    = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })

  console.log('Loading dashboard…')
  await page.goto('http://localhost:7433/dashboard', { waitUntil: 'networkidle2', timeout: 15_000 })
  await sleep(3000)  // let SSE populate and charts render

  // Full dashboard screenshot
  const full = path.join(OUT_DIR, 'dashboard.png')
  await page.screenshot({ path: full, fullPage: true })
  console.log(`Saved: ${full}`)

  // Header + top panels close-up
  const header = path.join(OUT_DIR, 'dashboard-header.png')
  await page.screenshot({ path: header, clip: { x: 0, y: 0, width: 1440, height: 340 } })
  console.log(`Saved: ${header}`)

  // Graph + efficiency row
  const graphEl = await page.$('#panel-graph')
  if (graphEl) {
    const graphShot = path.join(OUT_DIR, 'dashboard-graph.png')
    await graphEl.screenshot({ path: graphShot })
    console.log(`Saved: ${graphShot}`)
  }

  // Healer panel
  const healerEl = await page.$('#panel-healer')
  if (healerEl) {
    const healerShot = path.join(OUT_DIR, 'dashboard-healer.png')
    await healerEl.screenshot({ path: healerShot })
    console.log(`Saved: ${healerShot}`)
  }

  await browser.close()
  console.log('\nAll screenshots saved to docs/screenshots/')
}

main().catch(e => { console.error(e.message); process.exit(1) })
