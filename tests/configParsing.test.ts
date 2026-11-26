import { describe, expect, it } from 'vitest'

// Mirrors of the renderer helpers. They live in .tsx files that pull in React,
// so they are re-declared here rather than dragging a DOM environment into the
// unit test run; keep them in sync with CreateTopicDialog/EditTopicConfigDialog.
function parseConfigLines(text: string): Record<string, string> {
  const configs: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key) configs[key] = line.slice(eq + 1).trim()
  }
  return configs
}

describe('parseConfigLines', () => {
  it('parses key=value pairs', () => {
    expect(parseConfigLines('retention.ms=604800000\ncleanup.policy=delete')).toEqual({
      'retention.ms': '604800000',
      'cleanup.policy': 'delete'
    })
  })

  it('ignores blanks and comments', () => {
    expect(parseConfigLines('\n# a comment\n  \nfoo=bar')).toEqual({ foo: 'bar' })
  })

  it('keeps equals signs inside the value', () => {
    // Values like base64 or connection strings legitimately contain '='.
    expect(parseConfigLines('a=b=c')).toEqual({ a: 'b=c' })
  })

  it('drops lines without a separator', () => {
    expect(parseConfigLines('justakey')).toEqual({})
  })
})
