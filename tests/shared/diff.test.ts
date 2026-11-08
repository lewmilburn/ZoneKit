import { describe, expect, it } from 'vitest'
import { diffEntries, isConflict, stripServerFields } from '../../src/zonekeeper/shared/diff'
import type { Entry } from '../../src/zonekeeper/shared/model'

const e = (key: string, value: unknown, order?: number): Entry => ({ key, area: 'rules', value, order })

describe('diffEntries', () => {
  it('marks identical entries unchanged', () => {
    const r = diffEntries([e('a', { x: 1 })], [e('a', { x: 1 })])
    expect(r.map((c) => c.type)).toEqual(['unchanged'])
    expect(isConflict(r[0])).toBe(false)
  })

  it('marks a missing entry as add, not a conflict', () => {
    const r = diffEntries([e('a', 1)], [])
    expect(r[0].type).toBe('add')
    expect(isConflict(r[0])).toBe(false)
  })

  it('marks an extra entry as extra, a conflict', () => {
    const r = diffEntries([], [e('z', 1)])
    expect(r).toEqual([{ type: 'extra', actual: e('z', 1) }])
    expect(isConflict(r[0])).toBe(true)
  })

  it('marks a changed value as different, a conflict', () => {
    const r = diffEntries([e('a', 1)], [e('a', 2)])
    expect(r[0].type).toBe('different')
    expect(isConflict(r[0])).toBe(true)
  })

  it('ignores top-level id, version and last_updated of a value', () => {
    const r = diffEntries(
      [e('a', { to: 'x' })],
      [e('a', { to: 'x', id: 'abc', version: '3', last_updated: 'now' })]
    )
    expect(r[0].type).toBe('unchanged')
  })

  it('does not ignore nested id or version (real configuration)', () => {
    const t = (d: unknown, a: unknown) => diffEntries([e('a', d)], [e('a', a)])[0].type
    expect(
      t(
        { action: 'execute', action_parameters: { id: 'A', version: 'latest' } },
        { action: 'execute', action_parameters: { id: 'B', version: '12' } }
      )
    ).toBe('different')
    expect(t({ actions: [{ id: 'always_use_https' }] }, { actions: [{ id: 'disable_security' }] })).toBe('different')
    expect(t({ actions: [{ id: 'ssl', value: 'flexible' }] }, { actions: [{ id: 'cache_level', value: 'flexible' }] })).toBe('different')
    expect(t({ o: { rules: [{ id: 'X' }] } }, { o: { rules: [{ id: 'Y' }] } })).toBe('different')
  })

  it('treats an own __proto__ key as data', () => {
    const t = (d: string, a: string) =>
      diffEntries([e('a', JSON.parse(d))], [e('a', JSON.parse(a))])[0].type
    expect(t('{"__proto__":"x"}', '{}')).toBe('different')
    expect(t('{"__proto__":null}', '{}')).toBe('different')
    expect(t('{"__proto__":{"a":1}}', '{"__proto__":{"a":1}}')).toBe('unchanged')
    expect(t('{"__proto__":{"a":1}}', '{"__proto__":{"a":2}}')).toBe('different')
  })

  it('distinguishes null from missing', () => {
    expect(diffEntries([e('a', { x: null })], [e('a', {})])[0].type).toBe('different')
  })

  it('requires keys to be unique across areas', () => {
    const a: Entry = { key: 'k', area: 'one', value: 1 }
    const b: Entry = { key: 'k', area: 'two', value: 1 }
    expect(() => diffEntries([a, b], [])).toThrow(/duplicate/i)
  })

  it('treats reordered rules as different', () => {
    const r = diffEntries([e('a', 1, 0), e('b', 2, 1)], [e('a', 1, 1), e('b', 2, 0)])
    expect(r.map((c) => c.type)).toEqual(['different', 'different'])
  })

  it('treats order defined on one side only as different', () => {
    expect(diffEntries([e('a', 1, 0)], [e('a', 1)])[0].type).toBe('different')
  })

  it('ignores order when undefined on both sides', () => {
    expect(diffEntries([e('a', 1)], [e('a', 1)])[0].type).toBe('unchanged')
  })

  it('ignores object key order but not array order', () => {
    expect(diffEntries([e('a', { x: 1, y: 2 })], [e('a', { y: 2, x: 1 })])[0].type).toBe('unchanged')
    expect(diffEntries([e('a', [1, 2])], [e('a', [2, 1])])[0].type).toBe('different')
  })

  it('does not confuse types that stringify alike', () => {
    expect(diffEntries([e('a', 1)], [e('a', '1')])[0].type).toBe('different')
    expect(diffEntries([e('a', null)], [e('a', undefined)])[0].type).toBe('different')
    expect(diffEntries([e('a', [null])], [e('a', [undefined])])[0].type).toBe('different')
  })

  it('treats a differing area as different', () => {
    const r = diffEntries([{ key: 'a', area: 'x', value: 1 }], [{ key: 'a', area: 'y', value: 1 }])
    expect(r[0].type).toBe('different')
  })

  it('throws on duplicate keys in either list', () => {
    expect(() => diffEntries([e('a', 1), e('a', 2)], [])).toThrow(/duplicate/i)
    expect(() => diffEntries([], [e('a', 1), e('a', 2)])).toThrow(/duplicate/i)
  })

  it('reports every kind together, desired first then extras', () => {
    const r = diffEntries([e('a', 1), e('b', 1), e('c', 1)], [e('c', 2), e('a', 1), e('z', 9)])
    expect(r.map((c) => c.type)).toEqual(['unchanged', 'add', 'different', 'extra'])
  })

  it('does not mutate inputs', () => {
    const d = [e('a', { id: 1, x: 1 })]
    const snap = JSON.stringify(d)
    diffEntries(d, [])
    expect(JSON.stringify(d)).toBe(snap)
  })
})

describe('stripServerFields', () => {
  it('removes only top-level server fields without mutating', () => {
    const input = { id: 1, version: 2, last_updated: 'x', a: { id: 3 }, b: [{ version: 2 }] }
    expect(stripServerFields(input)).toEqual({ a: { id: 3 }, b: [{ version: 2 }] })
    expect(input.id).toBe(1)
  })

  it('returns non-objects unchanged', () => {
    expect(stripServerFields('x')).toBe('x')
    expect(stripServerFields([{ id: 1 }])).toEqual([{ id: 1 }])
  })
})
