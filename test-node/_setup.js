import { JSDOM } from 'jsdom'

// scope.js uses bare `new MutationObserver(...)` and keys.js uses bare `window`.
// Wire the JSDOM realm's classes onto the Node globals so those resolve.
export function makeDom(html = '<!DOCTYPE html><html><head></head><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  global.MutationObserver = dom.window.MutationObserver
  global.document = dom.window.document
  global.window = dom.window
  global.Node = dom.window.Node
  return dom
}

export function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
