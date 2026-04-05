/**
 * content.js — 页面注入脚本
 *
 * 职责：
 *  1. 扫描页面上的 <video>/<audio> 元素
 *  2. 尝试通过 Web Audio API 的 createMediaElementSource 直接接管音频
 *     （若跨域，向 background 报告，建议用 tabCapture 模式）
 *  3. 将音频路由通过 AudioWorklet（noise-suppressor-processor）实时降噪
 *  4. 在 tabCapture 模式下配合静音 / 取消静音媒体元素
 *  5. 响应 Alt+S 快捷键（本地处理，与 background 同步）
 */

(function () {
  'use strict';

  // ── 状态 ──────────────────────────────────────────────────────
  let settings = {
    enabled:     false,
    strength:    70,
    mode:        'crowd-suppress',
    captureMode: 'direct',
  };

  // 已处理的媒体元素 → { sourceNode, workletNode, audioCtx }
  const processed = new WeakMap();
  // tabCapture 模式下被静音的元素
  const mutedByUs = new WeakSet();

  let audioCtx       = null;
  let workletLoaded  = false;

  // ── 获取初始设置 ──────────────────────────────────────────────
  chrome.storage.local.get(null, (data) => {
    settings = { ...settings, ...data };
    observeMedia();
    if (settings.enabled && settings.captureMode === 'direct') {
      attachAllMedia();
    }
  });

  // ── 监听来自 background/popup 的消息 ─────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'SETTINGS_UPDATED':
        settings = { ...settings, ...msg.settings };
        if (settings.enabled && settings.captureMode === 'direct') {
          attachAllMedia();
        }
        updateAllWorklets();
        sendResponse({ ok: true });
        break;

      case 'MUTE_ORIGINALS':
        muteAll();
        sendResponse({ ok: true });
        break;

      case 'UNMUTE_ORIGINALS':
        unmuteAll();
        sendResponse({ ok: true });
        break;

      case 'GET_MEDIA_STATUS':
        sendResponse({
          hasMedia: document.querySelectorAll('video, audio').length > 0,
          settings,
        });
        break;

      default:
        break;
    }
  });

  // ── 键盘快捷键（Alt+S）────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 's') {
      e.preventDefault();
      chrome.runtime.sendMessage({
        type:     'UPDATE_SETTINGS',
        settings: { enabled: !settings.enabled },
        tabId:    null, // background 通过 sender 获取
      });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 直接挂载模式（createMediaElementSource）
  // ────────────────────────────────────────────────────────────────
  async function initAudioContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  async function ensureWorkletLoaded() {
    if (workletLoaded) return;
    try {
      await audioCtx.audioWorklet.addModule(
        chrome.runtime.getURL('audio-processor.js')
      );
      workletLoaded = true;
    } catch (e) {
      console.warn('[WZQ Zero] AudioWorklet 加载失败:', e);
    }
  }

  async function attachMediaElement(el) {
    if (processed.has(el)) return;

    // 先占位，防止重复挂载
    processed.set(el, null);

    try {
      await initAudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await ensureWorkletLoaded();

      const sourceNode = audioCtx.createMediaElementSource(el);
      const workletNode = new AudioWorkletNode(audioCtx, 'noise-suppressor-processor', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });

      // 初始化处理器设置
      workletNode.port.postMessage({
        type:     'UPDATE_SETTINGS',
        enabled:  settings.enabled,
        strength: settings.strength / 100,
        mode:     settings.mode,
      });

      sourceNode.connect(workletNode);
      workletNode.connect(audioCtx.destination);

      processed.set(el, { sourceNode, workletNode });
      console.log('[WZQ Zero] 已挂载媒体元素:', el.src || el.currentSrc || '(未知)');
    } catch (err) {
      processed.delete(el);
      if (err.name === 'SecurityError' || err.message?.includes('cross-origin')) {
        console.warn('[WZQ Zero] 跨域媒体元素，无法直接挂载。建议切换到 tabCapture 模式。');
        chrome.runtime.sendMessage({ type: 'CONTENT_CORS_ERROR' });
      } else {
        console.error('[WZQ Zero] 挂载失败:', err);
      }
    }
  }

  function attachAllMedia() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (!processed.has(el)) attachMediaElement(el);
    });
  }

  function updateAllWorklets() {
    document.querySelectorAll('video, audio').forEach((el) => {
      const data = processed.get(el);
      if (data?.workletNode) {
        data.workletNode.port.postMessage({
          type:     'UPDATE_SETTINGS',
          enabled:  settings.enabled,
          strength: settings.strength / 100,
          mode:     settings.mode,
        });
      }
    });
  }

  // ── tabCapture 模式：静音 / 取消静音 ─────────────────────────
  function muteAll() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (!el.muted) {
        el.muted = true;
        mutedByUs.add(el);
      }
    });
  }

  function unmuteAll() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (mutedByUs.has(el)) {
        el.muted = false;
        mutedByUs.delete(el);
      }
    });
  }

  // ── 监控 DOM 变化，自动处理新增媒体元素 ─────────────────────
  function observeMedia() {
    function handleElement(el) {
      if (el.nodeName !== 'VIDEO' && el.nodeName !== 'AUDIO') return;
      el.addEventListener('play', () => {
        if (settings.enabled && settings.captureMode === 'direct') {
          attachMediaElement(el);
        }
      }, { once: false });
    }

    // 处理已有元素
    document.querySelectorAll('video, audio').forEach(handleElement);

    // 监听 DOM 新增
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO') {
            handleElement(node);
          }
          node.querySelectorAll?.('video, audio').forEach(handleElement);
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
