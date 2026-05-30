#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const distFile = path.join(rootDir, 'dist', 'hyper-undo.min.js')
const vendorFile = path.join(rootDir, '..', 'hyperclayjs', 'src', 'vendor', 'hyper-undo.vendor.js')

const WRAPPER_CODE = `
// Auto-export to window unless suppressed by loader.
if (!window.__hyperclayNoAutoExport) {
  window.hyperclay = window.hyperclay || {};
  window.hyperclay.undo = hyperundo.undo;
  window.h = window.hyperclay;
}

export const undo = hyperundo.undo;
export default hyperundo;
`

const isCheck = process.argv.includes('--check')

if (!fs.existsSync(distFile)) {
  if (isCheck) process.exit(1)
  console.error('Error: dist/hyper-undo.min.js not found. Run "npm run build" first.')
  process.exit(1)
}

const minified = fs.readFileSync(distFile, 'utf8').trim()
const expected = minified + '\n' + WRAPPER_CODE

if (isCheck) {
  if (!fs.existsSync(vendorFile)) process.exit(1)
  const actual = fs.readFileSync(vendorFile, 'utf8')
  process.exit(actual === expected ? 0 : 1)
}

const vendorDir = path.dirname(vendorFile)
if (!fs.existsSync(vendorDir)) {
  console.error(`Error: hyperclayjs vendor folder not found at ${vendorDir}`)
  console.error('Make sure hyperclayjs is in the parent directory.')
  process.exit(1)
}

fs.writeFileSync(vendorFile, expected, 'utf8')
console.log('✓ Updated hyperclayjs/src/vendor/hyper-undo.vendor.js')
