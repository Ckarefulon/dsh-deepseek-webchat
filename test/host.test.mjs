/**
 * Tests for the host half's row extraction — chiefly that a row knows which turn
 * it belongs to, which is what the picker's turn view groups on.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractMessages, KINDS } from '../lib/index.js'

/** A minimal event log: two human turns, with a question and its answer between. */
function log() {
  return [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: '第一答' },
            { type: 'reasoning', text: '想了想' },
          ],
        },
      },
    },
    { seq: 3, type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] }) } },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user-question-reply' }, content: [{ type: 'text', text: 'A' }] } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '那就 A' }] } } },
    { seq: 6, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] } },
    { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二答' }] } } },
  ]
}

test('every row carries the turn it belongs to', () => {
  const rows = extractMessages(log())
  const first = rows.filter((row) => row.turn === 1)
  const second = rows.filter((row) => row.turn === 2)
  assert.equal(first.length, 5)
  assert.equal(second.length, 2)
})

test('an answer to a question stays in the turn that asked it', () => {
  const rows = extractMessages(log())
  const answer = rows.find((row) => row.kind === KINDS.answer)
  assert.equal(answer.turn, 1)
  // And it did not open a turn of its own: the next turn is still 2.
  assert.equal(rows.some((row) => row.turn === 3), false)
})

test('detail rows keep their turn when the advanced set is read', () => {
  const rows = extractMessages(log(), { advanced: true })
  const reasoning = rows.find((row) => row.kind === KINDS.reasoning)
  assert.equal(reasoning.turn, 1)
  // Ids stay unique across the larger set, which is what selection keys on.
  const ids = new Set(rows.map((row) => row.id))
  assert.equal(ids.size, rows.length)
})

test('nothing before the first human turn belongs to a turn', () => {
  const rows = extractMessages([
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '开场白' }] } } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] } },
  ])
  // `null`, not `0`: the picker must be able to tell "belongs to no turn" from
  // "belongs to the first turn", and a turn numbered 0 would be rendered as one.
  assert.equal(rows[0].turn, null)
  assert.equal(rows[1].turn, 1)
})
