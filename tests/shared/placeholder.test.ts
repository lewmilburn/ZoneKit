import { describe, expect, it } from 'vitest'
import { abstractZone, findZoneLiterals, resolveZone } from '../../src/zonekeeper/shared/placeholder'

describe('resolveZone', () => {
  it('replaces {zone} including nested values and every occurrence', () => {
    expect(resolveZone({ to: 'https://{zone}/a' }, 'a.com')).toEqual({ to: 'https://a.com/a' })
    expect(resolveZone({ l: [{ u: '{zone} and www.{zone}' }] }, 'a.com')).toEqual({
      l: [{ u: 'a.com and www.a.com' }]
    })
  })

  it('leaves keys and non-strings alone and does not mutate', () => {
    const input = { '{zone}': '{zone}', n: 1, b: true, z: null }
    const out = resolveZone(input, 'a.com')
    expect(out).toEqual({ '{zone}': 'a.com', n: 1, b: true, z: null })
    expect(input['{zone}']).toBe('{zone}')
  })

  it('treats $ patterns in the zone name literally', () => {
    expect(resolveZone('{zone}', 'a$&b.com')).toBe('a$&b.com')
  })

  it('works on a bare string', () => {
    expect(resolveZone('{zone}', 'a.com')).toBe('a.com')
  })

  it('copies an own __proto__ key as data and inherits nothing', () => {
    const out = resolveZone(JSON.parse('{"__proto__":{"a":"{zone}"}}'), 'a.com') as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(out.a).toBeUndefined()
    expect((Object.getOwnPropertyDescriptor(out, '__proto__')!.value as { a: string }).a).toBe('a.com')
  })
})

describe('abstractZone', () => {
  it('replaces a whole-string host', () => {
    expect(abstractZone('a.com', 'a.com')).toBe('{zone}')
    expect(abstractZone('www.a.com', 'a.com')).toBe('www.{zone}')
  })

  it('replaces quoted hosts', () => {
    expect(abstractZone('http.host eq "a.com"', 'a.com')).toBe('http.host eq "{zone}"')
    expect(abstractZone(`http.host in {"a.com" 'www.a.com'}`, 'a.com')).toBe(
      `http.host in {"{zone}" 'www.{zone}'}`
    )
  })

  it('replaces URL hosts, with ports, paths, queries', () => {
    expect(abstractZone('https://a.com/x', 'a.com')).toBe('https://{zone}/x')
    expect(abstractZone('https://www.a.com/x', 'a.com')).toBe('https://www.{zone}/x')
    expect(abstractZone('http://a.com:8080', 'a.com')).toBe('http://{zone}:8080')
    expect(abstractZone('https://a.com?q=1', 'a.com')).toBe('https://{zone}?q=1')
    expect(abstractZone('https://a.com#f', 'a.com')).toBe('https://{zone}#f')
  })

  it('does not touch lookalike hosts', () => {
    for (const s of [
      'nota.com', 'a.com.evil.net', 'sub.a.com', 'a.community', 'a.com-x.net', 'xa.com',
      'my_a.com', 'üa.com', 'a-a.com', 'a.com-x', 'a.comé', 'a.com_x',
      'https://my_a.com/', 'https://üa.com/', 'https://a-a.com/', 'https://a.com.evil.net/',
      '"a.com-x"', '"sub.a.com"', 'https://sub.a.com/', 'https://wwww.a.com/'
    ]) {
      expect(abstractZone(s, 'a.com')).toBe(s)
    }
  })

  it('does not touch non-host positions', () => {
    for (const s of [
      'user@a.com', 'https://a.com@evil.net', 'https://other.com/a.com',
      'https://other.com/?u=a.com', 'https://partner.example/?site=a.com'
    ]) {
      expect(abstractZone(s, 'a.com')).toBe(s)
    }
  })

  it('is case-sensitive and does not normalise case', () => {
    for (const s of ['A.COM', 'WWW.a.com', 'https://A.COM/x', '"A.COM"', 'www.A.com']) {
      expect(abstractZone(s, 'a.com')).toBe(s)
    }
  })

  it('treats regex characters literally', () => {
    expect(abstractZone('https://aXcom/', 'a.com')).toBe('https://aXcom/')
    expect(abstractZone('a+b.com', 'a+b.com')).toBe('{zone}')
  })

  it('recurses without touching keys or mutating', () => {
    const input = { 'a.com': ['a.com', { u: 'www.a.com' }], n: 2 }
    expect(abstractZone(input, 'a.com')).toEqual({ 'a.com': ['{zone}', { u: 'www.{zone}' }], n: 2 })
    expect(input['a.com'][0]).toBe('a.com')
  })

  it('copies an own __proto__ key as data and inherits nothing', () => {
    const out = abstractZone(JSON.parse('{"__proto__":{"a":"a.com"}}'), 'a.com') as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(out.a).toBeUndefined()
    expect((Object.getOwnPropertyDescriptor(out, '__proto__')!.value as { a: string }).a).toBe('{zone}')
  })

  it('round trips resolve then abstract for supported host forms', () => {
    const v = {
      a: '{zone}',
      b: 'www.{zone}',
      c: 'http.host eq "{zone}"',
      d: 'https://{zone}/p?x=1',
      e: 'https://www.{zone}:8443/p',
      f: ['{zone}', { g: `http.host in {"{zone}" "www.{zone}"}` }]
    }
    expect(abstractZone(resolveZone(v, 'a.com'), 'a.com')).toEqual(v)
  })
})

describe('findZoneLiterals', () => {
  it('returns nothing when fully abstracted', () => {
    expect(findZoneLiterals({ a: 'https://a.com/x', b: '"a.com"' }, 'a.com')).toEqual([])
  })

  it('reports remaining mentions, case-insensitively, after abstraction', () => {
    const v = {
      a: 'sub.a.com',
      b: '*.a.com/*',
      c: '^(www\\.)?a\\.com$',
      d: 'A.COM',
      e: 'WWW.a.com',
      f: 'user@a.com',
      g: 'https://a.com@evil.net',
      h: 'https://other.com/a.com',
      i: 'https://other.com/?u=a.com',
      j: 'https://a.com/ok'
    }
    expect(findZoneLiterals(v, 'a.com')).toEqual([
      'sub.a.com', '*.a.com/*', '^(www\\.)?a\\.com$', 'A.COM', 'WWW.a.com', 'user@a.com',
      'https://a.com@evil.net', 'https://other.com/a.com', 'https://other.com/?u=a.com'
    ])
  })

  it('reports the abstracted text and dedupes', () => {
    expect(findZoneLiterals(['"a.com" and sub.a.com', 'sub.a.com', 'sub.a.com'], 'a.com')).toEqual([
      '"{zone}" and sub.a.com',
      'sub.a.com'
    ])
  })

  it('does not report lookalikes of other names', () => {
    expect(findZoneLiterals('nothing here', 'a.com')).toEqual([])
  })
})
