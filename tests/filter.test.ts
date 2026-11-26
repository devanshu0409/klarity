import { describe, expect, it } from 'vitest'
import { compileFilter } from '../src/main/serde/filter'

describe('compileFilter', () => {
  it('matches everything when empty', () => {
    expect(compileFilter(undefined).isEmpty).toBe(true)
    expect(compileFilter('   ').matches('anything')).toBe(true)
  })

  it('is a case-insensitive contains by default', () => {
    const f = compileFilter('OrderId')
    expect(f.matches('{"orderid": 7}')).toBe(true)
    expect(f.matches('{"customer": 7}')).toBe(false)
  })

  it('requires every term with &&', () => {
    const f = compileFilter('alpha && beta')
    expect(f.matches('alpha and beta')).toBe(true)
    expect(f.matches('alpha only')).toBe(false)
  })

  it('accepts any term with ||', () => {
    const f = compileFilter('alpha || beta')
    expect(f.matches('just beta')).toBe(true)
    expect(f.matches('neither')).toBe(false)
  })

  it('gives && priority over ||, matching the Java tool', () => {
    // `a && b || c` is an AND of "a" and "b || c", not a mixed-precedence parse.
    const f = compileFilter('a && b || c')
    expect(f.matches('a b')).toBe(false) // second term is the literal "b || c"
    expect(f.matches('a b || c')).toBe(true)
  })
})
