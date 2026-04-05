/**
 * background.js — 后台 Service Worker
 *
 * 职责：
 *  - 持久化插件设置（enabled/strength/mode）
 *  - 通过 tabCapture API 获取标签页音频流 ID
 *  - 创建 / 关闭 Offscreen Document，传递 streamId 供音频处理
 *  - 将标签页静音（tabCapture 模式下避免双重播放）
 *  - 路由 popup 与 content.js 之间的消息
 *  - 响应键盘快捷键命令
 */

// ── 默认设置 ──────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled:      false,
  strength:     70,          // 0–100
  mode:         'crowd-suppress', // 'crowd-suppress' | 'commentary-only' | 'passthrough'
  captureMode:  'direct',    // 'direct'（content.js）| 'tab'（tabCapture）
  capturedTabId: null,
};

// ── 安装时初始化 ──────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(DEFAULT_SETTINGS);
});

// ── 快捷键：Alt+S ─────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-noise-suppression') {
    const data = await chrome.storage.local.get(['enabled']);
    const newEnabled = !data.enabled;
    await chrome.storage.local.set({ enabled: newEnabled });
    // 广播到所有 content.js
    broadcastToTabs({ type: 'SETTINGS_UPDATED', settings: { enabled: newEnabled } });
    // 同步 tabCapture 状态
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      if (newEnabled) await startCapture(tab.id);
      else            await stopCapture();
    }
  }
});

// ── 消息中枢 ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'GET_SETTINGS':
      chrome.storage.local.get(null, (data) => sendResponse({ ...DEFAULT_SETTINGS, ...data }));
      return true; // 保持信道异步

    case 'UPDATE_SETTINGS': {
      const newSettings = message.settings;
      chrome.storage.local.set(newSettings, async () => {
        broadcastToTabs({ type: 'SETTINGS_UPDATED', settings: newSettings });

        // 处理 tabCapture 模式开关
        if ('enabled' in newSettings || 'captureMode' in newSettings) {
          const allData = await chrome.storage.local.get(null);
          const cfg = { ...DEFAULT_SETTINGS, ...allData, ...newSettings };
          if (cfg.enabled && cfg.captureMode === 'tab') {
            const tabId = message.tabId;
            if (tabId) await startCapture(tabId);
          } else {
            await stopCapture();
          }
        }
        sendResponse({ success: true });
      });
      return true;
    }

    case 'CONTENT_CORS_ERROR':
      // content.js 无法用 createMediaElementSource（跨域），通知 popup 建议 tabCapture
      sendResponse({ suggestion: 'tab-capture' });
      return true;

    case 'GET_OFFSCREEN_STATUS':
      sendResponse({ active: offscreenActive });
      return true;

    default:
      break;
  }
});

// ── tabCapture + Offscreen Document 管理 ─────────────────────────
let offscreenActive = false;
let capturedTabId   = null;

async function startCapture(tabId) {
  if (offscreenActive) await stopCapture();

  // 1. 获取标签页音频流 ID
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(id);
    });
  }).catch((e) => {
    console.warn('[WZQ Zero] tabCapture.getMediaStreamId 失败:', e);
    return null;
  });

  if (!streamId) return;

  // 2. 创建 Offscreen Document
  try {
    await chrome.offscreen.createDocument({
      url:         chrome.runtime.getURL('offscreen.html'),
      reasons:     ['USER_MEDIA'],
      justification: '用于实时音频降噪处理',
    });
    offscreenActive = true;
    capturedTabId   = tabId;

    // 3. 将流 ID 及设置发送给 offscreen.js
    const settings = await chrome.storage.local.get(null);
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_INIT',
      streamId,
      settings: { ...DEFAULT_SETTINGS, ...settings },
    });

    // 4. 静音原标签页（防止双重播音）
    await chrome.tabs.update(tabId, { muted: true });

    // 5. 告知 content.js 切换到静音模式
    chrome.tabs.sendMessage(tabId, { type: 'MUTE_ORIGINALS' }).catch(() => {});
  } catch (err) {
    console.error('[WZQ Zero] 创建 Offscreen Document 失败:', err);
  }
}

async function stopCapture() {
  if (!offscreenActive) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) { /* 可能已被关闭 */ }
  offscreenActive = false;

  if (capturedTabId !== null) {
    // 取消静音原标签页
    chrome.tabs.update(capturedTabId, { muted: false }).catch(() => {});
    // 告知 content.js 恢复音频
    chrome.tabs.sendMessage(capturedTabId, { type: 'UNMUTE_ORIGINALS' }).catch(() => {});
    capturedTabId = null;
  }
}

// ── 工具函数 ─────────────────────────────────────────────────────
function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
