// npm's range semantics (packages/userland/src/npm/semver.ts), against node-semver's behaviour.
import { describe, expect, it } from 'vitest'
import { maxSatisfying, satisfies, validRange } from '../../userland/src/npm/semver.ts'

describe('semver', () => {
  it('matches node-semver for common ranges', () => {
    const cases: [range: string, yes: string[], no: string[]][] = [
      ['^1.2.3', ['1.2.3', '1.9.0'], ['2.0.0', '1.2.2', '2.0.0-0']],
      ['^0.2.3', ['0.2.3', '0.2.9'], ['0.3.0', '0.2.2']],
      ['^0.0.3', ['0.0.3'], ['0.0.4']],
      ['^1.x', ['1.0.0', '1.99.0'], ['2.0.0']],
      ['~1.2.3', ['1.2.3', '1.2.9'], ['1.3.0']],
      ['~1.2', ['1.2.0', '1.2.9'], ['1.3.0']],
      ['~1', ['1.0.0', '1.9.9'], ['2.0.0']],
      ['1.2.x', ['1.2.0', '1.2.99'], ['1.3.0']],
      ['1', ['1.0.0', '1.5.0'], ['2.0.0']],
      ['*', ['0.0.1', '99.0.0'], ['1.0.0-beta']],
      ['', ['1.0.0'], []],
      ['>=1.2.3 <2', ['1.2.3', '1.9.9'], ['2.0.0', '1.2.2']],
      ['>1.2', ['1.3.0'], ['1.2.9']],
      ['<=1.2', ['1.2.9'], ['1.3.0']],
      ['1.2.3 - 2.3', ['1.2.3', '2.3.9'], ['2.4.0']],
      ['1.x || >=2.5.0', ['1.4.0', '2.5.0', '3.0.0'], ['2.4.0']],
      ['>= 1.0.0', ['1.0.0'], ['0.9.0']],
      ['=1.0.0', ['1.0.0'], ['1.0.1']],
      ['v2.0.0', ['2.0.0'], ['2.0.1']],
      // Prereleases match only ranges that name the same major.minor.patch with a prerelease.
      ['^1.2.3-beta.2', ['1.2.3-beta.3', '1.2.3', '1.5.0'], ['1.2.4-beta.1', '1.2.3-beta.1']],
      ['>=3.0.0-rc.0', ['3.0.0-rc.1', '3.1.0'], ['3.1.0-rc.1']],
    ]
    for (const [range, yes, no] of cases) {
      for (const version of yes) expect(satisfies(version, range), `${version} satisfies ${range}`).toBe(true)
      for (const version of no) expect(satisfies(version, range), `${version} doesn't satisfy ${range}`).toBe(false)
    }
  })

  it('picks the highest satisfying version and rejects invalid ranges', () => {
    expect(maxSatisfying(['1.0.0', '1.2.0', '1.10.0', '2.0.0', '1.11.0-beta'], '^1.0.0')).toBe('1.10.0')
    expect(maxSatisfying(['1.0.0'], '^2')).toBeUndefined()
    expect(validRange('latest')).toBe(false)
    expect(validRange('^1.2.3 || 2.x')).toBe(true)
  })
})
