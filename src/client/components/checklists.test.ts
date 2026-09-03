import { describe, expect, it } from 'vitest'
import type { Checklist, ChecklistItem } from '../../contract/checklists.js'
import { checklistRefusal, dueState, mayReopen, mayTick, myOpenItems } from './checklists.js'

const ME = '01920000-0000-7000-8000-00000000d001'
const OTHER = '01920000-0000-7000-8000-00000000d002'
const JOINER = '01920000-0000-7000-8000-00000000d005'

const item = (over: Partial<ChecklistItem>): ChecklistItem => ({
  id: crypto.randomUUID(),
  workspaceId: 'ws' as ChecklistItem['workspaceId'],
  checklistId: 'c1',
  title: 'Task',
  description: null,
  assigneePersonId: null,
  dueOn: null,
  order: 0,
  doneAt: null,
  doneBy: null,
  note: null,
  ...over,
})

const list = (over: Partial<Checklist>): Checklist => ({
  id: 'c1',
  workspaceId: 'ws' as Checklist['workspaceId'],
  personId: JOINER,
  templateId: null,
  name: 'Onboarding',
  kind: 'onboarding',
  anchorDate: '2026-09-01',
  status: 'open',
  startedBy: null,
  startedAt: '2026-09-01T00:00:00Z',
  completedAt: null,
  cancelledAt: null,
  items: [],
  progress: { done: 0, total: 0 },
  ...over,
})

describe('mayTick', () => {
  const open = list({})
  it('lets the assignee and a manager tick, and nobody else', () => {
    const mine = item({ assigneePersonId: ME })
    expect(mayTick(mine, open, { personId: ME, manage: false })).toBe(true)
    expect(mayTick(mine, open, { personId: OTHER, manage: false })).toBe(false)
    expect(mayTick(mine, open, { personId: null, manage: true })).toBe(true)
  })
  it('lets the person the list is about tick a pooled item, and only them', () => {
    const pooled = item({ assigneePersonId: null })
    expect(mayTick(pooled, open, { personId: JOINER, manage: false })).toBe(true)
    expect(mayTick(pooled, open, { personId: ME, manage: false })).toBe(false)
  })
  it('never on a cancelled list, even for a manager', () => {
    expect(
      mayTick(item({ assigneePersonId: ME }), list({ status: 'cancelled' }), { personId: ME, manage: true }),
    ).toBe(false)
  })
  it('does not extend the pool rule to reopening', () => {
    const pooled = item({ assigneePersonId: null, doneAt: '2026-09-02T00:00:00Z' })
    expect(mayReopen(pooled, open, { personId: JOINER, manage: false })).toBe(false)
    expect(mayReopen(item({ assigneePersonId: ME }), open, { personId: ME, manage: false })).toBe(true)
  })
})

describe('dueState', () => {
  it('reads a date against today lexically', () => {
    expect(dueState('2026-09-01', '2026-09-02')).toBe('overdue')
    expect(dueState('2026-09-02', '2026-09-02')).toBe('today')
    expect(dueState('2026-09-03', '2026-09-02')).toBe('later')
    expect(dueState(null, '2026-09-02')).toBe('none')
  })
})

describe('myOpenItems', () => {
  it('collects what the reader has to do, dated first and soonest first', () => {
    const a = list({
      id: 'a',
      startedAt: '2026-09-01T00:00:00Z',
      items: [
        item({ id: 'undated', assigneePersonId: ME }),
        item({ id: 'late', assigneePersonId: ME, dueOn: '2026-09-10' }),
        item({ id: 'done', assigneePersonId: ME, dueOn: '2026-09-01', doneAt: '2026-09-01T00:00:00Z' }),
        item({ id: 'theirs', assigneePersonId: OTHER, dueOn: '2026-09-01' }),
        item({ id: 'pooled', assigneePersonId: null, dueOn: '2026-09-04' }),
      ],
    })
    const b = list({
      id: 'b',
      personId: ME,
      startedAt: '2026-09-02T00:00:00Z',
      items: [item({ id: 'my-pool', assigneePersonId: null, dueOn: '2026-09-05' })],
    })
    const cancelled = list({ id: 'c', status: 'cancelled', items: [item({ assigneePersonId: ME })] })
    expect(myOpenItems([a, b, cancelled], ME).map((row) => row.item.id)).toEqual([
      'my-pool',
      'late',
      'undated',
    ])
    expect(myOpenItems([a, b], null)).toEqual([])
  })
})

describe('checklistRefusal', () => {
  it('translates a reason it knows and repeats a sentence it does not', () => {
    expect(
      checklistRefusal({ code: 'CONFLICT', message: 'x', data: { reason: 'hr.checklist.already_done' } }),
    ).toEqual({ key: 'checklist_refused_already_done' })
    expect(checklistRefusal({ code: 'CONFLICT', message: 'Something the router wrote.' })).toEqual({
      sentence: 'Something the router wrote.',
    })
    expect(checklistRefusal({ code: 'INTERNAL_SERVER_ERROR', message: 'fetch failed' })).toBeNull()
  })
})
