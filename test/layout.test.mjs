/**
 * Assertions on the panel's own stylesheet.
 *
 * These exist because a layout bug here is invisible to every other test: the
 * markup is right, the state is right, and the composer is still pushed off the
 * bottom of the pane. `.dswc-list` said `flex:1 1 auto; min-height:0` and a long
 * session still scrolled the whole panel, because the list's *wrapper* had no
 * `flex` of its own — it grew to the content height and the pane clipped it.
 *
 * The rules are read out of the shipped bundle (`lib/client.js`), so what is
 * checked is what a running DSH actually injects, not what the source intends.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/**
 * Collect this plugin's CSS rules from the bundle.
 *
 * `ensureStyle` builds the sheet as an array of plain string literals and joins
 * them, so the selectors appear verbatim. Later duplicates win, which matches
 * the cascade.
 * @returns selector → declaration map.
 */
function rules() {
  const out = new Map()
  const pattern = /'(\.dswc-[^{']+)\{([^}]*)\}'/g
  for (const match of bundle.matchAll(pattern)) {
    out.set(match[1], match[2])
  }
  return out
}

/** @returns the declarations for one selector. */
function rule(selector) {
  const found = rules().get(selector)
  assert.ok(found !== undefined, `no CSS rule for ${selector}`)
  return found
}

/** @returns whether a declaration list sets a property to a value. */
function has(selector, property, value) {
  const declarations = rule(selector)
  const found = declarations
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(property + ':'))
  assert.ok(found.length > 0, `${selector} does not set ${property}`)
  if (value === undefined) return true
  assert.ok(
    found.some((part) => part.slice(property.length + 1).trim() === value),
    `${selector} sets ${property} to ${found.join(', ')}, expected ${value}`,
  )
  return true
}

test('every box between the pane and the list can shrink', () => {
  // A flex child only shrinks when each ancestor in the chain can shrink too.
  // The chain is pane → .dswc-root → .dswc-picker → .dswc-listWrap → .dswc-list.
  for (const selector of ['.dswc-root', '.dswc-picker', '.dswc-listWrap']) {
    has(selector, 'min-height', '0')
    assert.match(rule(selector), /flex:1 1 auto/, `${selector} is not a shrinking flex item`)
  }
  has('.dswc-picker', 'overflow', 'hidden')
  has('.dswc-root', 'overflow', 'hidden')
})

test('the list wrapper is a flex column, not an auto-height block', () => {
  // The bug: `listWrap` had no `flex`, so it took the list's full content height
  // and the pane clipped the overflow. The composer went with it.
  const declarations = rule('.dswc-listWrap')
  assert.match(declarations, /display:flex/, 'the wrapper is a block again, so it grows with its content')
  assert.match(declarations, /flex-direction:column/)
  assert.match(declarations, /overflow:hidden/)
})

test('the list has a fixed share of the pane and scrolls its own content', () => {
  has('.dswc-list', 'min-height', '0')
  has('.dswc-list', 'overflow', 'auto')
  assert.match(rule('.dswc-list'), /flex:1 1 auto/)
  // `min-height:60px` is what used to give the long list somewhere to push the
  // composer to; the list must be allowed to collapse instead.
  assert.equal(/min-height:60px/.test(rule('.dswc-list')), false, 'the list refuses to shrink again')
})

test('the four kind boxes are right-aligned under their turn', () => {
  has('.dswc-turnFields', 'justify-content', 'flex-end')
  // And they no longer sit indented under the title with a hanging left margin.
  assert.equal(/padding:[^;]*24px/.test(rule('.dswc-turnFields')), false, 'the old left indent is back')
})

test('the page view keeps a rectangle for the guest', () => {
  // 0.6.0 dropped this rule's element from the render; the rule has to exist for
  // the parking code to place the page.
  assert.match(rule('.dswc-host'), /flex:1 1 auto/)
  assert.match(rule('.dswc-host'), /min-height:0/)
})

test('the picker and the page view do not both claim the panel', () => {
  // `.dswc-root` is the panel's outer box in both views; it must not grow past
  // the pane. `height:100%` alone does not resolve when the parent's height is
  // indefinite, which is why `flex:1 1 auto` is there as well.
  has('.dswc-root', 'height', '100%')
  has('.dswc-root', 'overflow', 'hidden')
})