import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeVarint, encodeVarint, deframe, encode, frame, getAll, get, getVar, msg, parse } from '../lib/pb.js'

test('varint round-trips small and large values', () => {
  for (const v of [0, 1, 127, 128, 255, 300, 16384, 0xffffffff, 0x7f]) {
    assert.deepEqual(decodeVarint(encodeVarint(v), 0)[0], v)
  }
})

test('msg emits and parse reads back a nested message', () => {
  const inner = msg({ 1: 'hello', 2: 42 })
  const outer = msg({ 1: inner, 2: 'world' })
  const tokens = parse(outer)
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0].field, 1)
  assert.deepEqual(parse(tokens[0].value), [
    { field: 1, wireType: 2, value: Buffer.from('hello') },
    { field: 2, wireType: 0, value: 42 },
  ])
})

test('get / getAll / getVar extract the right fields', () => {
  // 用 encode 直接构造：对象字面量无法表达重复字段号。
  const buf = encode([
    { field: 1, wireType: 2, value: Buffer.from('a') },
    { field: 3, wireType: 2, value: Buffer.from('x') },
    { field: 3, wireType: 2, value: Buffer.from('y') },
    { field: 5, wireType: 0, value: 1 },
    { field: 7, wireType: 0, value: 7 },
  ])
  assert.equal(get(buf, 1).toString('utf8'), 'a')
  assert.equal(getAll(buf, 3).length, 2)
  assert.equal(getVar(buf, 5), 1)
  assert.equal(getVar(buf, 7), 7)
  assert.equal(get(buf, 99), undefined)
})

test('frame / deframe round-trips with gzip flag', () => {
  const payload = Buffer.from('the quick brown fox')
  const framed = frame(payload, 0x01)
  const [frames, rest] = deframe(framed)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].flag, 0x01)
  assert.deepEqual(frames[0].payload, payload)
  assert.equal(rest.length, 0)
})

test('deframe leaves partial trailing frame as rest', () => {
  const framed = Buffer.concat([frame(Buffer.from('abc')), Buffer.from([0, 0, 0, 0, 99])])
  const [frames, rest] = deframe(framed)
  assert.equal(frames.length, 1)
  assert.deepEqual(rest, Buffer.from([0, 0, 0, 0, 99]))
})

test('encode handles repeated string fields in declaration order', () => {
  const buf = encode([
    { field: 4, wireType: 2, value: Buffer.from('first') },
    { field: 4, wireType: 2, value: Buffer.from('second') },
  ])
  assert.deepEqual(getAll(buf, 4).map((b) => b.toString('utf8')), ['first', 'second'])
})
