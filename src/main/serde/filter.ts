/**
 * Text filter for scans. Ported from the Java tool's `matchesFilter`, whose
 * semantics people already rely on:
 *
 *   `a && b`  every term must be present
 *   `a || b`  any term may be present
 *   `a`       plain contains
 *
 * AND is checked first, so `a && b || c` is treated as an AND of
 * `a` and `b || c` rather than mixed precedence. Matching is
 * case-insensitive and runs on the *decoded* text, which is what makes
 * searching inside Protobuf and FlatBuffers payloads work.
 */

export interface CompiledFilter {
  matches: (text: string) => boolean
  isEmpty: boolean
}

const MATCH_ALL: CompiledFilter = { matches: () => true, isEmpty: true }

export function compileFilter(filter: string | undefined): CompiledFilter {
  if (!filter || !filter.trim()) return MATCH_ALL
  const trimmed = filter.trim()

  if (trimmed.includes('&&')) {
    const terms = splitTerms(trimmed, '&&')
    if (terms.length > 0) {
      return {
        isEmpty: false,
        matches: (text) => {
          const haystack = text.toLowerCase()
          return terms.every((t) => haystack.includes(t))
        }
      }
    }
  }

  if (trimmed.includes('||')) {
    const terms = splitTerms(trimmed, '||')
    if (terms.length > 0) {
      return {
        isEmpty: false,
        matches: (text) => {
          const haystack = text.toLowerCase()
          return terms.some((t) => haystack.includes(t))
        }
      }
    }
  }

  const needle = trimmed.toLowerCase()
  return { isEmpty: false, matches: (text) => text.toLowerCase().includes(needle) }
}

function splitTerms(filter: string, separator: string): string[] {
  return filter
    .split(separator)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}
