import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExpiring } from '../lib/auth.js'

/** 造一个 exp 在 N 秒后的 JWT（不签名，仅 base64url 编码 header.payload）。 */
function makeJwt(expOffsetSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })).toString('base64url')
  return `${header}.${payload}.sig`
}

test('isExpiring: 5 分钟内过期 → true', () => {
  assert.equal(isExpiring(makeJwt(60), 300_000), true)
})

test('isExpiring: 还有 1 小时 → false', () => {
  assert.equal(isExpiring(makeJwt(3600), 300_000), false)
})

test('isExpiring: 已过期 → true', () => {
  assert.equal(isExpiring(makeJwt(-100), 300_000), true)
})

test('isExpiring: 解析失败（非 JWT）→ true（保守）', () => {
  assert.equal(isExpiring('not-a-jwt', 300_000), true)
})

test('isExpiring: 默认 skew 5 分钟', () => {
  // 4 分钟后过期：默认 5 分钟 skew 内 → true
  assert.equal(isExpiring(makeJwt(240)), true)
  // 6 分钟后过期 → false
  assert.equal(isExpiring(makeJwt(360)), false)
})
