import http from "@system.fetch"
import { bridgeFetch, bridgeSupported } from "./bridge.js"

function getFetch() {
  try {
    if (http && typeof http.fetch === "function") {
      return http.fetch.bind(http)
    }
    if (typeof fetch === "function") {
      return fetch
    }
    const mod = require ? require("@system.fetch") : null
    if (mod && typeof mod.fetch === "function") {
      return mod.fetch.bind(mod)
    }
    if (mod && mod.default && typeof mod.default.fetch === "function") {
      return mod.default.fetch.bind(mod.default)
    }
  } catch (e) {}
  return null
}

export const API_HOST = "openrouter.ai"
export const API_PREFIX = "/api/v1"
export const DEFAULT_MODEL = "deepseek/deepseek-chat:free"
export const REASONER_MODEL = "deepseek/deepseek-r1:free"
export const DEFAULT_MAX_TOKENS = 1500
export const DEFAULT_TIMEOUT = 35000
export const DNS_TIMEOUT = 8000

export const MODEL_LIST = [
  { id: "deepseek/deepseek-chat:free", title: "DeepSeek Chat (Free)" },
  { id: "deepseek/deepseek-r1:free", title: "DeepSeek R1 (Free)" }
]

export const NETWORK_MODES = [
  { id: "auto", title: "Авто" },
  { id: "bridge", title: "Через телефон" },
  { id: "direct", title: "Напрямую" },
  { id: "doh", title: "DNS через DoH" },
  { id: "relay", title: "Свой прокси" }
]

export function hasDirectFetch() {
  return !!getFetch()
}

const DOH_SERVERS = [
  { url: "https://cloudflare-dns.com{host}&type=A", json: true },
  { url: "https://yandex.net{host}&type=A", json: false },
  { url: "https://dns.google{host}&type=A", json: false },
  { url: "https://1.1.1{host}&type=A", json: true }
]

function trim(value) {
  return typeof value === "string" ? value.replace(/^\s+|\s+$/g, "") : ""
}

function joinBase(base, path) {
  let b = trim(base)
  while (b.length > 0 && b.charAt(b.length - 1) === "/") {
    b = b.slice(0, b.length - 1)
  }
  return b + path
}

export function normalizeResponse(res) {
  const top = res || {}
  let status = typeof top.code === "number" ? top.code : 0
  let body = null
  let rawText = ""

  let data = top.data
  if (data === undefined || data === null) {
    data = top
  }

  if (typeof data === "string") {
    rawText = data
    try {
      body = JSON.parse(data)
    } catch (e) {
      body = null
    }
  } else if (typeof data === "object") {
    if (data.choices || data.error || data.data) {
      body = data
    } else {
      body = data
    }
  }

  if (!status && body && typeof body.code === "number") {
    status = body.code
  }

  return { status: status, body: body, raw: top, text: rawText }
}

function httpRequest(url, options) {
  const opts = options || {}
  const timeout = opts.timeout || DEFAULT_TIMEOUT

  return new Promise(function (resolve, reject) {
    let settled = false
    let timer = null

    function finish(handler, value) {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      handler(value)
    }

    timer = setTimeout(function () {
      finish(reject, { code: -1, data: "timeout", network: true })
    }, timeout)

    let request = null
    try {
      const fetchFn = getFetch()
      if (!fetchFn) {
        finish(reject, {
          code: -1,
          data: "no-direct-network",
          noFetch: true,
          network: true
        })
        return
      }
      request = fetchFn({
        url: url,
        method: opts.method || "POST",
        header: opts.header || {},
        data: opts.data,
        responseType: opts.responseType || "json",
        sslVerify: opts.sslVerify === false ? false : true,
        connectTimeout: timeout,
        responseTimeout: timeout
      })
    } catch (e) {
      finish(reject, {
        code: -1,
        data: (e && e.message) || "request error",
        network: true
      })
      return
    }

    if (request && typeof request.then === "function") {
      request.then(
        function (res) {
          finish(resolve, res)
        },
        function (err) {
          finish(reject, {
            code: err && err.code,
            data: err && err.data,
            message: err && err.message,
            network: true
          })
        }
      )
    } else if (request && typeof request.success === "function") {
      request.success(function (res) {
        finish(resolve, res)
      })
      request.fail(function (err) {
        finish(reject, {
          code: err && err.code,
          data: err && err.data,
          network: true
        })
      })
    }
  })
}

export function buildPayload(options) {
  const opts = options || {}
  const messages = []

  if (opts.systemInstruction) {
    messages.push({
      role: "system",
      content: String(opts.systemInstruction)
    })
  }

  const history = opts.history || []
  for (let i = 0; i < history.length; i++) {
    const item = history.slice(i, i + 1).pop()
    if (!item || !item.text) {
      continue
    }
    messages.push({
      role: item.role === "assistant" || item.role === "model" || item.role === "deepseek" ? "assistant" : "user",
      content: String(item.text)
    })
  }

  let selectedModel = DEFAULT_MODEL
  if (opts.thinking === "on" || opts.thinking === "high" || opts.thinking === "reasoner") {
    selectedModel = REASONER_MODEL
  }

  const payload = {
    model: selectedModel,
    messages: messages,
    max_tokens: opts.maxOutputTokens || DEFAULT_MAX_TOKENS,
    stream: false
  }

  if (selectedModel !== REASONER_MODEL) {
    payload.temperature = 0.7
  }

  return payload
}

function authHeader(options) {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + trim(options.apiKey),
    "HTTP-Referer": "https://github.com",
    "X-Title": "DeepSeekB"
  }
}

function directRoute(options, path) {
  const url = "https://" + API_HOST + API_PREFIX + path
  const sslVerify = options.sslVerify !== false

  return httpRequest(url, {
    method: "POST",
    header: authHeader(options),
    data: JSON.stringify(buildPayload(options)),
    responseType: "json",
    sslVerify: sslVerify,
    timeout: options.timeout
  }).then(function (res) {
    const norm = normalizeResponse(res)
    norm.route = "direct"
    norm.url = url
    return norm
  })
}

function relayRoute(options, path) {
  const base = trim(options.relay)
  if (!base) {
    return Promise.reject({ code: -1, data: "relay is not set", network: true })
  }
  const url = joinBase(base, API_PREFIX + path)

  return httpRequest(url, {
    method: "POST",
    header: authHeader(options),
    data: JSON.stringify(buildPayload(options)),
    responseType: "json",
    sslVerify: options.sslVerify !== false,
    timeout: options.timeout
  }).then(function (res) {
    const norm = normalizeResponse(res)
    norm.route = "relay"
    norm.url = url
    return norm
  })
}

function pinnedRoute(options, path) {
  return resolveHostIp(API_HOST, options.dohServers).then(function (ip) {
    const url = "https://" + ip + API_PREFIX + path
    const displayUrl = "https://" + API_HOST + API_PREFIX + path
    const header = authHeader(options)
    header["Host"] = API_HOST

    return httpRequest(url, {
      method: "POST",
      header: header,
      data: JSON.stringify(buildPayload(options)),
      responseType: "json",
      sslVerify: false,
      timeout: options.timeout
    }).then(function (res) {
      const norm = normalizeResponse(res)
      norm.route = "doh"
      norm.url = displayUrl
      return norm
    })
  })
}

function bridgeRoute(options, path) {
  const url = "https://" + API_HOST + API_PREFIX + path

  return bridgeFetch({
    url: url,
    method: "POST",
    header: authHeader(options),
    data: JSON.stringify(buildPayload(options)),
    responseType: "json",
    timeout: options.timeout
  }).then(function (res) {
    const norm = normalizeResponse(res)
    norm.route = "bridge"
    norm.url = url
    return norm
  })
}

export function resolveHostIp(host, servers) {
  const list = servers && servers.length ? servers : DOH_SERVERS
  let chain = Promise.reject(new Error("no resolver"))

  for (let i = list.length - 1; i >= 0; i--) {
    const server = list.slice(i, i + 1).pop()
    chain = chain.catch(function () {
      const url = server.url.replace("{host}", host)
      return httpRequest(url, {
        method: "GET",
        header: { accept: "application/dns-json" },
        responseType: "json",
        sslVerify: true,
        timeout: DNS_TIMEOUT
      }).then(function (res) {
        const norm = normalizeResponse(res)
        const body = norm.body
        if (!body || !body.Answer) {
          throw new Error("no answer")
        }
        for (let j = 0; j < body.Answer.length; j++) {
          const answer = body.Answer.slice(j, j + 1).pop()
          if (answer && answer.type === 1 && answer.data) {
            return answer.data
          }
        }
        throw new Error("no A record")
      })
    })
  }

  return chain
}

export function generateContent(options) {
  const opts = options || {}
  const apiKey = trim(opts.apiKey)

  if (!apiKey) {
    return Promise.reject({
      kind: "api",
      text: "Не задан API-ключ",
      hint: "Откройте настройки и укажите ключ OpenRouter"
    })
  }

  const path = "/chat/completions"
  const mode = opts.networkMode || "auto"
  const routes = []
  const hasBridge = bridgeSupported()
  const directReady = hasDirectFetch()

  if (mode === "relay") {
    routes.push(function () {
      return relayRoute(opts, path)
    })
  } else if (mode === "bridge") {
    routes.push(function () {
      return bridgeRoute(opts, path)
    })
  } else {
    if (hasBridge) {
      routes.push(function () {
        return bridgeRoute(opts, path)
      })
    }
    if (directReady) {
      routes.push(function () {
        return directRoute(opts, path)
      })
    }
    if (trim(opts.relay)) {
      routes.push(function () {
return relayRoute(opts, path)
})
}
if (mode === "auto" || mode === "doh") {
routes.push(function () {
return pinnedRoute(opts, path)
})
}
}
return new Promise(function (resolve, reject) {
runRoutes(routes, 0, null, resolve, reject)
})
}
function runRoutes(routes, index, lastError, resolve, reject) {
if (index >= routes.length) {
reject(
lastError || {
kind: "network",
text: "Сеть недоступна",
hint: "Включите мост через телефон (FetchBridge) в настройках"
}
)
return
}
const routeFn = routes.slice(index, index + 1).pop()
routeFn().then(
function (norm) {
const status = norm.status || 0
if (status >= 200 && status < 300) {
resolve(norm)
return
}
if (status === 429 || status >= 500) {
runRoutes(
routes,
index + 1,
{
kind: "api",
status: status,
body: norm.body,
text: norm.text,
url: norm.url,
route: norm.route
},
resolve,
reject
)
return
}
reject({
kind: "api",
status: status,
body: norm.body,
text: norm.text,
url: norm.url,
route: norm.route
})
},
function (err) {
runRoutes(
routes,
index + 1,
{
kind: "network",
code: err && err.code,
data: err && err.data,
message: err && err.message,
route: err && err.route,
bridge: !!(err && err.bridge),
noFetch: !!(err && err.noFetch)
},
resolve,
reject
)
}
)
}
export function extractText(body) {
if (!body || !body.choices || !body.choices.length) {
return ""
}
const choice = body.choices.slice(0, 1).pop()
if (!choice || !choice.message) {
return ""
}
return trim(choice.message.content || "")
}
function snippet(value, limit) {
let text = String(value || "")
text = text
.replace(/<script[\s\S]?</script>/gi, " ")
.replace(/<style[\s\S]?</style>/gi, " ")
.replace(/<[^>]*>/g, " ")
.replace(/\s+/g, " ")
.replace(/^\s+|\s+$/g, "")
if (text.length > limit) {
text = text.slice(0, limit) + "…"
}
return text
}
export function describeError(err) {
if (!err) {
return { text: "Неизвестная ошибка", hint: "" }
}
if (err.kind === "api") {
const status = err.status || 0
let message = ""
if (err.body && err.body.error && err.body.error.message) {
message = String(err.body.error.message)
}
const low = message.toLowerCase()
if (err.empty) {
return {
text: "Пустой ответ от DeepSeek",
hint: "Бесплатный сервер перегружен. Повторите запрос."
}
}
if (status === 401 || low.indexOf("authentication") >= 0 || low.indexOf("invalid") >= 0) {
return {
text: "Неверный API-ключ",
hint: "Проверьте ключ (начинается с sk-or-v1-...) в настройках"
}
}
if (status === 402 || low.indexOf("insufficient") >= 0 || low.indexOf("credits") >= 0) {
return {
text: "Нет кредитов на ключе",
hint: "Проверьте бесплатный лимит на openrouter.ai"
}
}
if (status === 403) {
const raw = snippet(err.text, 120)
return {
text: "Доступ запрещён (403)",
hint: message || raw || "Проверьте настройки ключа OpenRouter"
}
}
if (status === 404) {
return {
text: "Модель не найдена",
hint: message || "Проверьте настройки модели"
}
}
if (status === 429) {
return {
text: "Лимит бесплатных запросов",
hint: "Подождите 10-20 секунд и повторите"
}
}
if (status >= 500) {
return {
text: "Ошибка сервера OpenRouter",
hint: message || "Повторите попытку позже"
}
}
return {
text: message || "Ошибка API (" + status + ")",
hint: ""
}
}
const data = err.data
if (err && err.bridge) {
return {
text: typeof data === "string" && data ? data : "Мост через телефон недоступен",
hint: "Откройте AstroBox NG с плагином FetchBridge на телефоне"
}
}
if (err && err.noFetch) {
return {
text: "Прямой интернет недоступен",
hint: "Включите режим «Через телефон» в настройках"
}
}
let text = "Сеть недоступна"
if (typeof data === "string" && data) {
text =
data === "timeout"
? "Превышено время ожидания"
: data.indexOf("resolve") >= 0 || data.indexOf("host") >= 0
? "Не удалось найти сервер"
: data
}
return {
text: text,
hint: "Проверьте подключение к телефону и плагин FetchBridge"
}
}
export function apiDiagnose(options) {
const opts = options || {}
const apiKey = trim(opts.apiKey)
if (!apiKey) {
return Promise.resolve({
ok: false,
status: 0,
route: "",
url: "",
text: "Не задан API-ключ",
hint: "Откройте настройки и укажите ключ OpenRouter"
})
}
const url = "https://" + API_HOST + API_PREFIX + "/auth/key"
return bridgeFetch({
url: url,
method: "GET",
header: {
"Authorization": "Bearer " + apiKey,
"Accept": "application/json"
},
responseType: "json",
timeout: opts.timeout || 15000
}).then(
function (res) {
const norm = normalizeResponse(res)
const ok = norm.status >= 200 && norm.status < 300
const d = ok
? { text: "Ключ OpenRouter работает!", hint: "" }
: describeError({
kind: "api",
status: norm.status,
body: norm.body,
text: norm.text,
url: url
})
return {
ok: ok,
status: norm.status,
route: "bridge",
url: url,
text: d.text,
hint: d.hint
}
},
function (err) {
const d = describeError({
kind: "network",
data: err && err.data,
bridge: !!(err && err.bridge),
noFetch: !!(err && err.noFetch)
})
return {
ok: false,
status: 0,
route: "bridge",
url: url,
text: d.text,
hint: d.hint
}
}
)
}
export default {
API_HOST,
DEFAULT_MODEL,
REASONER_MODEL,
DEFAULT_MAX_TOKENS,
DEFAULT_TIMEOUT,
DNS_TIMEOUT,
MODEL_LIST,
NETWORK_MODES,
normalizeResponse,
buildPayload,
generateContent,
extractText,
describeError,
apiDiagnose,
resolveHostIp
}
