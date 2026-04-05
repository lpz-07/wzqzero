/**
 * popup.js — 弹出面板逻辑
 *
 * 从 storage 读取初始状态，提供：
 *  - 降噪开关
 *  - 强度滑块
 *  - 预设模式按钮
 *  - 捕获模式选择
 * 所有改动通过 background.js 持久化并广播到 content.js。
 */

// ── 元素引用 ───────────────────────────────────────────────────
const enableToggle     = document.getElementById('enableToggle');
const strengthSlider   = document.getElementById('strengthSlider');
const strengthVal      = document.getElementById('strengthVal');
const statusDot        = document.getElementById('statusDot');
const statusText       = document.getElementById('statusText');
const modeButtons      = document.querySelectorAll('.mode-btn');
const captureModeSelect = document.getElementById('captureModeSelect');
const aiToggle         = document.getElementById('aiToggle');
const aiSensitivitySlider = document.getElementById('aiSensitivitySlider');
const aiSensitivityVal = document.getElementById('aiSensitivityVal');
const corsWarning      = document.getElementById('corsWarning');

let currentSettings = {
  enabled:     false,
  strength:    70,
  mode:        'crowd-suppress',
  aiEnabled:   false,
  aiSensitivity: 55,
  captureMode: 'direct',
};

let activeTabId = null;

// ── 初始化 ─────────────────────────────────────────────────────
(async function init() {
  // 获取当前激活标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;

  // 从 storage 读取设置
  const stored = await chrome.storage.local.get(null);
  currentSettings = { ...currentSettings, ...stored };
  renderUI(currentSettings);

  // 向 content.js 查询媒体状态
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'GET_MEDIA_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        updateStatus('no-media');
      } else {
        updateStatus(resp.hasMedia ? (currentSettings.enabled ? 'active' : 'idle') : 'no-media');
      }
    });
  }

  // 监听跨域错误通知（通过 storage change）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.corsError) {
      corsWarning.classList.add('visible');
    }
  });
})();

// ── UI 渲染 ────────────────────────────────────────────────────
function renderUI(settings) {
  enableToggle.checked    = settings.enabled;
  strengthSlider.value    = settings.strength;
  strengthVal.textContent = settings.strength;
  aiToggle.checked        = !!settings.aiEnabled;
  aiSensitivitySlider.value = settings.aiSensitivity ?? 55;
  aiSensitivityVal.textContent = settings.aiSensitivity ?? 55;
  aiSensitivitySlider.disabled = !settings.aiEnabled;
  captureModeSelect.value = settings.captureMode || 'direct';

  modeButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === settings.mode);
  });

  updateStatus(settings.enabled ? 'active' : 'idle');
}

function updateStatus(state) {
  statusDot.className = 'status-dot';
  switch (state) {
    case 'active':
      statusDot.classList.add('active');
      statusText.textContent = '降噪运行中 ✓';
      break;
    case 'idle':
      statusText.textContent = '已就绪，等待开启';
      break;
    case 'no-media':
      statusDot.classList.add('warning');
      statusText.textContent = '未检测到媒体元素';
      break;
    default:
      statusText.textContent = '正在检测…';
  }
}

// ── 发送设置更新 ────────────────────────────────────────────────
function sendSettings(partial) {
  currentSettings = { ...currentSettings, ...partial };
  chrome.runtime.sendMessage({
    type:     'UPDATE_SETTINGS',
    settings: partial,
    tabId:    activeTabId,
  });
}

// ── 事件绑定 ───────────────────────────────────────────────────

// 开关
enableToggle.addEventListener('change', () => {
  const enabled = enableToggle.checked;
  sendSettings({ enabled });
  updateStatus(enabled ? 'active' : 'idle');
  if (!enabled) corsWarning.classList.remove('visible');
});

// 强度滑块
strengthSlider.addEventListener('input', () => {
  const strength = parseInt(strengthSlider.value, 10);
  strengthVal.textContent = strength;
  sendSettings({ strength });
});

// AI 开关
aiToggle.addEventListener('change', () => {
  const aiEnabled = aiToggle.checked;
  aiSensitivitySlider.disabled = !aiEnabled;
  sendSettings({ aiEnabled });
});

// AI 敏感度滑块
aiSensitivitySlider.addEventListener('input', () => {
  const aiSensitivity = parseInt(aiSensitivitySlider.value, 10);
  aiSensitivityVal.textContent = aiSensitivity;
  sendSettings({ aiSensitivity });
});

// 预设模式按钮
modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    const mode = btn.dataset.mode;
    sendSettings({ mode });

    // 切换到原声模式时自动关闭降噪
    if (mode === 'passthrough') {
      enableToggle.checked = false;
      sendSettings({ enabled: false });
      updateStatus('idle');
    }
  });
});

// 捕获模式
captureModeSelect.addEventListener('change', () => {
  const captureMode = captureModeSelect.value;
  sendSettings({ captureMode });
  corsWarning.classList.remove('visible');
});

// 监听来自 background 的消息（如 tabCapture 状态变化）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SETTINGS_UPDATED') {
    currentSettings = { ...currentSettings, ...msg.settings };
    renderUI(currentSettings);
  }
});
