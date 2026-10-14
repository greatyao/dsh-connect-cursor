/**
 * 最小 Protobuf + Connect 流式编解码（逆向自 Cursor agent.v1 / aiserver.v1）。
 *
 * 协议参考：cursor2api（MIT）的 pb.py —— 字段号取自 Cursor CLI 的 JS bundle，
 * 本模块与其行为对齐：varint / 长度分隔 / 固定 32/64 位四种 wire type，
 * 以及 Connect 流式帧 `[1B flags][4B 大端长度][payload]`（0x01=gzip，0x02=流结束 trailer）。
 *
 * @module dsh-connect-cursor/pb
 */

import { gunzipSync } from 'node:zlib'

/** 无符号 varint 编码。 */
export function encodeVarint(value) {
  const out = []
  let v = value >>> 0
  for (;;) {
    const byte = v & 0x7f
    v >>>= 7
    out.push(v ? byte | 0x80 : byte)
    if (!v) return Buffer.from(out)
  }
}

/**
 * 无符号 varint 解码；返回 [值, 下一索引]。
 *
 * 不加 `>>> 0`：位运算会把 32 位以上的 varint 截断（Cursor 的 context 字段会超 32 位）。
 */
export function decodeVarint(buf, i) {
  let value = 0
  let multiplier = 1
  for (;;) {
    const byte = buf[i]
    i += 1
    value += (byte & 0x7f) * multiplier
    if (!(byte & 0x80)) return [value, i]
    multiplier *= 128
  }
}

/** 解析一段 protobuf 为 `[{field, wireType, value}]`；value 对 wt2 是 Buffer，wt0 是数字。 */
export function parse(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    let tag
    ;[tag, i] = decodeVarint(buf, i)
    const field = tag >> 3
    const wireType = tag & 7
    if (wireType === 0) {
      let v
      ;[v, i] = decodeVarint(buf, i)
      out.push({ field, wireType, value: v })
    } else if (wireType === 2) {
      let len
      ;[len, i] = decodeVarint(buf, i)
      out.push({ field, wireType, value: buf.subarray(i, i + len) })
      i += len
    } else if (wireType === 5) {
      out.push({ field, wireType, value: buf.subarray(i, i + 4) })
      i += 4
    } else if (wireType === 1) {
      out.push({ field, wireType, value: buf.subarray(i, i + 8) })
      i += 8
    } else if (wireType === 3 || wireType === 4) {
      // group（wt3 开始 / wt4 结束）：成对出现，整体当作一个子消息。
      const start = i
      let depth = 1
      while (i < buf.length && depth > 0) {
        let inner
        ;[inner, i] = decodeVarint(buf, i)
        const innerWire = inner & 7
        if (innerWire === 3) depth += 1
        else if (innerWire === 4) depth -= 1
        else if (innerWire === 0) {
          ;[, i] = decodeVarint(buf, i)
        } else if (innerWire === 2) {
          let len
          ;[len, i] = decodeVarint(buf, i)
          i += len
        } else if (innerWire === 1) i += 8
        else if (innerWire === 5) i += 4
        else break
      }
      out.push({ field, wireType, value: buf.subarray(start, i) })
    } else {
      throw new Error(`protobuf: 不支持的 wire type ${wireType}`)
    }
  }
  return out
}

/** 把 `[{field, wireType, value}]` 序列化回 Buffer。 */
export function encode(tokens) {
  const parts = []
  for (const { field, wireType, value } of tokens) {
    parts.push(encodeVarint((field << 3) | wireType))
    if (wireType === 0) parts.push(encodeVarint(value))
    else if (wireType === 2) {
      parts.push(encodeVarint(value.length))
      parts.push(value)
    } else parts.push(value)
  }
  return Buffer.concat(parts)
}

/**
 * 按字段号构造消息。字段号可传数字（`{1: 'x'}`）或 `f` 前缀字符串（`{f1: 'x'}`，
 * 兼容 cursor2api 的 `msg(f1=...)` 写法）。bytes/str → wireType 2，int → varint，
 * bool → varint(0/1)，数组 → 重复字段（每项独立 emit）。
 */
export function msg(fields) {
  const tokens = []
  for (const [key, value] of Object.entries(fields)) {
    const field = typeof key === 'number' ? key : Number(String(key).replace(/^f/, ''))
    if (!Number.isInteger(field) || field <= 0) {
      throw new TypeError(`msg: 非法字段号 ${key}`)
    }
    if (typeof value === 'boolean') tokens.push({ field, wireType: 0, value: value ? 1 : 0 })
    else if (typeof value === 'number') tokens.push({ field, wireType: 0, value })
    else if (typeof value === 'string') tokens.push({ field, wireType: 2, value: Buffer.from(value, 'utf8') })
    else if (Buffer.isBuffer(value)) tokens.push({ field, wireType: 2, value })
    else if (Array.isArray(value)) {
      for (const entry of value) {
        tokens.push({ field, wireType: 2, value: Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), 'utf8') })
      }
    } else {
      throw new TypeError(`msg: 不支持的字段类型 ${key}=${typeof value}`)
    }
  }
  return encode(tokens)
}

/** 取某字段的 wt2（Buffer）值；不存在返回 undefined。 */
export function get(buf, field) {
  for (const t of parse(buf)) if (t.field === field && t.wireType === 2) return t.value
  return undefined
}

/** 取某字段的全部 wt2 值。 */
export function getAll(buf, field) {
  const out = []
  for (const t of parse(buf)) if (t.field === field && t.wireType === 2) out.push(t.value)
  return out
}

/** 取某字段的 varint 值。 */
export function getVar(buf, field) {
  for (const t of parse(buf)) if (t.field === field && t.wireType === 0) return t.value
  return undefined
}

/** 递归改写 path 指向的子消息字段（用于就地修改会话状态里的某段）。 */
export function editPath(buf, path, newValue) {
  const out = []
  let done = false
  for (const t of parse(buf)) {
    if (!done && t.field === path[0] && t.wireType === 2) {
      out.push({
        field: t.field,
        wireType: 2,
        value: path.length === 1 ? newValue : editPath(t.value, path.slice(1), newValue),
      })
      done = true
    } else {
      out.push(t)
    }
  }
  if (!done) throw new Error(`editPath: 路径不存在 ${path.join('.')}`)
  return encode(out)
}

/** Connect 流式帧：`[1B flags][4B 大端长度][payload]`。 */
export function frame(payload, flag = 0) {
  const head = Buffer.alloc(5)
  head.writeUInt8(flag, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/**
 * 解一连串 Connect 帧。返回 `[{flag, payload}, 剩余未成帧的字节]`。
 * flag 含 0x01 时按 gzip 解（失败则保留原样）。
 */
export function deframe(buf) {
  const out = []
  let i = 0
  while (buf.length - i >= 5) {
    const flag = buf[i]
    const len = buf.readUInt32BE(i + 1)
    if (buf.length - i - 5 < len) break
    let payload = buf.subarray(i + 5, i + 5 + len)
    if (flag & 0x01) {
      try {
        payload = gunzipSync(payload)
      } catch {
        /* 保留原始（非 gzip）负载 */
      }
    }
    out.push({ flag, payload: Buffer.from(payload) })
    i += 5 + len
  }
  return [out, buf.subarray(i)]
}
