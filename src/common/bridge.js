let interconnect = null
try {
  interconnect = require("@system.interconnect")
} catch (e) {
  interconnect = null
}

const TAG_HANDSHAKE = "__hs__"
const TAG_FETCH = "fetch"
const TAG_CHUNK = "fetch-chunk"
const TAG_ACK = "fetch-ack"

const HANDSHAKE_TIMEOUT = 6000
const DEFAULT_TIMEOUT = 30000

const LOCAL_CAPS = {
  version: 3,
  chunk: true,
  maxChunkSize: 4096,
  encodings: ["text", "base64", "hex"],
  compressions: ["none"],
  ack: true,
  ackWindow: 4
}

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

let connection = null
let initialized = false
let peerReady = false
let localId = 0
let negotiated = {
  version: 1,
  chunked: false,
  chunkSize: 0,
  ack: false,
  encodings: [],
  compressions: []
}

const pending = {}
const readyWaiters = []

function supported() {
  return !!interconnect
}

function init() {
  if (initialized || !interconnect) {
    return
  }
  initialized = true
  try {
    connection = interconnect.instance()
    connection.onmessage = function (frame) {
      let value = ""
      if (frame && typeof frame === "object") {
        value = frame.data !== undefined ? frame.data : frame.payloadText || ""
      } else {
        value = frame || ""
      }
      let message = null
      try {
        message = typeof value === "string" ? JSON.parse(value) : value
      } catch (e) {
        return
      }
      handleMessage(message)
    }
    connection.onopen = function () {
      sendHandshake(0)
    }
    connection.onclose = function () {
      peerReady = false
      failAll("соединение с телефоном прервано")
    }
    connection.onerror = function () {
      peerReady = false
    }
  } catch (e) {
    connection = null
  }
  sendHandshake(0)
}

function sendHandshake(count) {
  if (!connection) {
    return
  }
  try {
    connection.send({ data: { tag: TAG_HANDSHAKE, count: count, caps: LOCAL_CAPS } })
  } catch (e) {}
}

function intersect(left, right) {
  const out = []
  const src = Array.isArray(left) ? left : []
  const dst = Array.isArray(right) ? right : []
  for (let i = 0; i < src.length; i++) {
    if (dst.indexOf(src[i]) >= 0) {
      out.push(src[i])
    }
  }
  return out
}

function negotiate(peer) {
  if (!peer) {
    return { version: 1, chunked: false, chunkSize: 0, ack: false, encodings: [], compressions: [] }
  }
  const version = Math.min(Number(peer.version) || 1, LOCAL_CAPS.version)
  const chunked = !!peer.chunk && version >= 2
  const peerChunk = Number(peer.maxChunkSize) || LOCAL_CAPS.maxChunkSize
  return {
    version: version,
    chunked: chunked,
    chunkSize: chunked ? Math.max(256, Math.min(peerChunk, LOCAL_CAPS.maxChunkSize)) : 0,
    ack: chunked && !!peer.ack,
    encodings: intersect(peer.encodings, LOCAL_CAPS.encodings),
    compressions: intersect(peer.compressions, LOCAL_CAPS.compressions)
  }
}

function handleHandshake(message) {
  negotiated = negotiate(message && message.caps)
  peerReady = true
  while (readyWaiters.length) {
    const waiter = readyWaiters.shift()
    try {
      waiter(true)
    } catch (e) {}
  }
  const count = Number(message && message.count) || 0
  if (count < 2) {
    sendHandshake(count + 1)
  }
}

function base64ToBytes(text) {
  const clean = String(text || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "")
  const out = new Uint8Array(((clean.length / 4) | 0) * 3 + (clean.length % 4 > 1 ? (clean.length % 4) - 1 : 0))
  let offset = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const value = CHARSET.indexOf(clean.charAt(i))
    if (value < 0) {
      continue
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset] = (buffer >> bits) & 0xff
      offset++
    }
  }
  return out.subarray(0, offset)
}

function hexToBytes(text) {
  const source = String(text || "")
  const out = new Uint8Array((source.length / 2) | 0)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(source.substr(i * 2, 2), 16)
  }
  return out
}

function bytesToText(bytes) {
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const first = bytes[i]
    let code = 0
    if (first < 0x80) {
      code = first
      i += 1
    } else if (first < 0xe0) {
      code = ((first & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
      i += 2
    } else if (first < 0xf0) {
      code = ((first & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 3
    } else {
      code =
        ((first & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)
      i += 4
    }
    if (code > 0xffff) {
      code -= 0x10000
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}

function responseText(response) {
  const compression = response.compression
  if (compression && compression !== "none") {
    throw { message: "мост: неподдерживаемое сжатие " + compression }
  }
  const encoding = response.bodyEncoding || (response.raw ? "base64" : "text")
  if (encoding === "text") {
    return String(response.body || "")
  }
  if (encoding === "base64") {
    return bytesToText(base64ToBytes(response.body))
  }
  if (encoding === "hex") {
    return bytesToText(hexToBytes(response.body))
  }
  throw { message: "мост: неизвестная кодировка " + encoding }
}

function decodeBody(options, text) {
  if (options && options.raw) {
    return text
  }
  if (options && options.responseType === "text") {
    return text
  }
  const source = String(text == null ? "" : text)
    .replace(/^\uFEFF/, "")
    .trim()
  if (!source) {
    return ""
  }
  try {
    return JSON.parse(source)
  } catch (e) {
    return String(text)
  }
}

function cleanup(slot) {
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = null
  }
  if (slot.id !== undefined) {
    delete pending[slot.id]
  }
}

function failAll(reason) {
  for (const id in pending) {
    const slot = pending[id]
    cleanup(slot)
    try {
      slot.reject({ code: 0, data: "мост: " + reason, bridge: true })
    } catch (e) {}
  }
}

function sendAck(id, ack) {
  if (!connection) {
    return
  }
  try {
    connection.send({ data: { tag: TAG_ACK, id: id, ack: ack } })
  } catch (e) {}
}

function handleHeader(message) {
  const slot = pending[message.id]
  if (!slot) {
    return
  }
  const response = message.resp || {}
  if (response.ok === false && !Number(response.status) && !response.chunked) {
    cleanup(slot)
    try {
      slot.reject({
        code: 0,
        data: "мост: " + (response.statusText || "телефон не смог выполнить запрос"),
        bridge: true
      })
    } catch (e) {}
    return
  }
  if (!response.chunked) {
    cleanup(slot)
    try {
      slot.resolve({
        code: Number(response.status) || 0,
        data: decodeBody(slot.options, responseText(response)),
        headers: response.headers || {}
      })
    } catch (err) {
      slot.reject({ code: 0, data: (err && err.message) || "мост: ошибка разбора", bridge: true })
    }
    return
  }
  slot.header = response
  slot.chunks = new Array(Number(response.chunkCount) || 0)
  slot.received = 0
}

function handleChunk(message) {
  const slot = pending[message.id]
  if (!slot || !slot.header) {
    return
  }
  const seq = message.seq | 0
  if (!slot.chunks[seq]) {
    const encoding = slot.header.bodyEncoding || "base64"
    slot.chunks[seq] = encoding === "hex" ? hexToBytes(message.data) : base64ToBytes(message.data)
    slot.received++
  }
  if (slot.header.ack === true) {
    let ack = 0
    while (ack < slot.chunks.length && slot.chunks[ack]) {
      ack++
    }
    sendAck(message.id, ack)
  }
  if (slot.received >= (Number(slot.header.chunkCount) || 0)) {
    finishChunks(slot)
  }
}

function finishChunks(slot) {
  const count = Number(slot.header.chunkCount) || 0
  const total = Number(slot.header.totalBytes) || 0
  let bytes = total > 0 ? new Uint8Array(total) : null
  let offset = 0
  const parts = []
  for (let i = 0; i < count; i++) {
    const part = slot.chunks[i]
    if (!part) {
      cleanup(slot)
      try {
        slot.reject({ code: 0, data: "мост: потерян фрагмент " + i, bridge: true })
      } catch (e) {}
      return
    }
    if (bytes) {
      bytes.set(part, offset)
      offset += part.length
    } else {
      parts.push(part)
    }
  }
  if (!bytes) {
    let size = 0
    for (let i = 0; i < parts.length; i++) {
      size += parts[i].length
    }
    bytes = new Uint8Array(size)
    offset = 0
    for (let i = 0; i < parts.length; i++) {
      bytes.set(parts[i], offset)
      offset += parts[i].length
    }
  }
  cleanup(slot)
  try {
    slot.resolve({
      code: Number(slot.header.status) || 0,
      data: decodeBody(slot.options, bytesToText(bytes)),
      headers: slot.header.headers || {}
    })
  } catch (err) {
    slot.reject({ code: 0, data: (err && err.message) || "мост: ошибка разбора", bridge: true })
  }
}

function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return
  }
  if (message.tag === TAG_HANDSHAKE) {
    handleHandshake(message)
  } else if (message.tag === TAG_FETCH) {
    handleHeader(message)
  } else if (message.tag === TAG_CHUNK) {
    handleChunk(message)
  }
}

function waitReady(timeout) {
  if (peerReady) {
    return Promise.resolve(true)
  }
  return new Promise(function (resolve) {
    const waiter = function (value) {
      resolve(value)
    }
    readyWaiters.push(waiter)
    setTimeout(function () {
      const index = readyWaiters.indexOf(waiter)
      if (index >= 0) {
        readyWaiters.splice(index, 1)
      }
      resolve(peerReady)
    }, timeout || HANDSHAKE_TIMEOUT)
    sendHandshake(0)
  })
}

export function bridgeFetch(options) {
  const opts = options || {}
  if (!interconnect) {return Promise.reject({ code: 0, data: "на этой модели нет канала связи с телефоном", bridge: true })
}
init()
if (!connection) {
return Promise.reject({ code: 0, data: "не удалось открыть канал связи с телефоном", bridge: true })
}
return waitReady(HANDSHAKE_TIMEOUT).then(function (ok) {
if (!ok) {
return Promise.reject({
code: 0,
data: "телефон не отвечает: включите мост FetchBridge",
bridge: true
})
}
const id = String(++localId)
const body = opts.data === undefined || opts.data === null ? undefined : String(opts.data)
const frame = {
tag: TAG_FETCH,
id: id,
url: opts.url,
options: {
method: String(opts.method || "GET").toUpperCase(),
headers: opts.header || {},
body: body,
raw: false,
followRedirects: true
}
}
return new Promise(function (resolve, reject) {
const slot = {
id: id,
options: { raw: !!opts.raw, responseType: opts.responseType || "json" },
resolve: resolve,
reject: reject,
timer: null,
header: null,
chunks: null,
received: 0
}
pending[id] = slot
slot.timer = setTimeout(function () {
if (!pending[id]) {
return
}
cleanup(slot)
reject({ code: 0, data: "мост: телефон не ответил вовремя", bridge: true, timeout: true })
}, opts.timeout || DEFAULT_TIMEOUT)
try {
connection.send({
data: frame,
success: function () {},
fail: function (data, code) {
if (!pending[id]) {
return
}
cleanup(slot)
if (code === 1006) {
peerReady = false
}
reject({ code: 0, data: "мост: отправка не удалась (" + (code || "?") + ")", bridge: true })
}
})
} catch (e) {
cleanup(slot)
reject({ code: 0, data: "мост: канал недоступен", bridge: true })
}
})
})
}
export function bridgeSupported() {
return supported()
}
export function bridgeReady() {
init()
return supported() && peerReady
}
export function bridgePing() {
init()
sendHandshake(0)
return bridgeReady()
}
export function bridgeDiagnose(timeout) {
return new Promise(function (resolve) {
if (!interconnect) {
resolve({ status: -1, message: "нет модуля interconnect" })
return
}
init()
if (!connection) {
resolve({ status: -2, message: "канал не открылся" })
return
}
try {
connection.diagnosis({
timeout: timeout || 8000,
success: function (data) {
resolve({ status: Number(data && data.status) })
},
fail: function (data, code) {
resolve({ status: -3, message: (data && data.data) || "диагностика не удалась " + code })
}
})
} catch (e) {
resolve({ status: -4, message: "диагностика недоступна" })
}
})
}
export default {
bridgeFetch,
bridgeSupported,
bridgeReady,
bridgePing,
bridgeDiagnose
}
