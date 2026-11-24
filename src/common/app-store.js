import storage from "@system.storage"

export const KEY_API_KEY = "deepseekband_api_key"
export const KEY_MODEL = "deepseekband_model"
export const KEY_RELAY = "deepseekband_relay"
export const KEY_NETWORK_MODE = "deepseekband_network_mode"
export const KEY_SSL_VERIFY = "deepseekband_ssl_verify"
export const KEY_SYSTEM_PROMPT = "deepseekband_system_prompt"
export const KEY_MAX_TOKENS = "deepseekband_max_tokens"
export const KEY_THINKING = "deepseekband_thinking"
export const KEY_THINKING_MODE = "deepseekband_thinking_mode"
export const KEY_KEYBOARD_MODE = "deepseekband_settings_keyboard_mode"
export const KEY_KEYBOARD_LANG = "deepseekband_keyboard_lang"
export const KEY_CHATS = "deepseekband_chats"
export const KEY_AUTO_DELETE = "deepseekband_auto_delete"

export const AUTO_DELETE_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_SYSTEM_PROMPT =
  "Ты — помощник DeepSeek на смарт-браслете Xiaomi. Решай школьные задачи кратко, по шагам и понятным языком на русском, без лишнего текста, чтобы поместилось на маленький экран."

export function getValue(key, fallback, callback) {
  storage.get({
    key: key,
    success: function (data) {
      if (data === undefined || data === null || data === "") {
        callback(fallback)
      } else {
        callback(data)
      }
    },
    fail: function () {
      callback(fallback)
    }
  })
}

export function setValue(key, value, callback) {
  storage.set({
    key: key,
    value: value === undefined || value === null ? "" : String(value),
    success: function () {
      if (callback) {
        callback(true)
      }
    },
    fail: function () {
      if (callback) {
        callback(false)
      }
    }
  })
}

export function removeValue(key, callback) {
  storage.delete({
    key: key,
    success: function () {
      if (callback) {
        callback(true)
      }
    },
    fail: function () {
      if (callback) {
        callback(false)
      }
    }
  })
}

export function getList(key, callback) {
  storage.get({
    key: key,
    success: function (data) {
      let list = []
      if (data) {
        try {
          list = JSON.parse(data)
        } catch (e) {
          list = []
        }
      }
      if (!list || !list.length) {
        list = []
      }
      callback(list)
    },
    fail: function () {
      callback([])
    }
  })
}

export function setList(key, list, callback) {
  setValue(key, JSON.stringify(list || []), callback)
}

export function messagesKey(chatId) {
  return "deepseekband_messages_" + chatId
}

export function cleanupOldChats(list, days) {
  const limit = days && days > 0 ? days : AUTO_DELETE_DAYS
  const cutoff = Date.now() - limit * DAY_MS
  const src = list || []
  const out = []
  for (let i = 0; i < src.length; i++) {
    const item = src[i]
    if (!item || !item.id) {
      continue
    }
    let ts = item.updatedAt || item.lastAt || item.createdAt || 0
    if (typeof ts !== "number") {
      ts = parseInt(ts)
    }
    if (!ts || isNaN(ts) || ts >= cutoff) {
      out.push(item)
    }
  }
  return out
}

export function cleanupInactiveChats(callback, days) {
  const done = typeof callback === "function" ? callback : function () {}
  getList(KEY_CHATS, function (list) {
    const src = list || []
    const keep = cleanupOldChats(src, days)
    const removed = src.length - keep.length
    if (!removed) {
      done(0)
      return
    }
    const keptIds = {}
    for (let i = 0; i < keep.length; i++) {
      keptIds[String(keep[i].id)] = true
    }
    for (let i = 0; i < src.length; i++) {
      const item = src[i]
      if (item && item.id && !keptIds[String(item.id)]) {
        removeValue(messagesKey(item.id))
      }
    }
    setList(KEY_CHATS, keep, function () {
      done(removed)
    })
  })
}

export function autoCleanupIfEnabled(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  getValue(KEY_AUTO_DELETE, "off", function (value) {
    if (value === "on") {
      cleanupInactiveChats(done, AUTO_DELETE_DAYS)
    } else {
      done(0)
    }
  })
}

export function clearAllChats(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  getList(KEY_CHATS, function (list) {
    const src = list || []
    for (let i = 0; i < src.length; i++) {
      const item = src[i]
      if (item && item.id) {
        removeValue(messagesKey(item.id))
      }
    }
    setList(KEY_CHATS, [], function () {
      done(src.length)
    })
  })
}

export default {
  KEY_API_KEY,
  KEY_MODEL,
  KEY_RELAY,
  KEY_NETWORK_MODE,
  KEY_SSL_VERIFY,
  KEY_SYSTEM_PROMPT,
  KEY_MAX_TOKENS,
  KEY_THINKING,
  KEY_THINKING_MODE,
  KEY_KEYBOARD_MODE,
  KEY_KEYBOARD_LANG,
  KEY_CHATS,
  KEY_AUTO_DELETE,
  AUTO_DELETE_DAYS,
  DEFAULT_SYSTEM_PROMPT,
  getValue,
  setValue,
  removeValue,
  getList,
  setList,
  messagesKey,
  cleanupOldChats,
  cleanupInactiveChats,
  autoCleanupIfEnabled,
  clearAllChats
}
