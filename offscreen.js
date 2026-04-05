/**
 * offscreen.js — Offscreen Document 音频处理
 *
 * 接收来自 background.js 的 OFFSCREEN_INIT 消息，
 * 利用 tabCapture streamId 获取标签页音频流，
 * 经过 AudioWorklet 降噪处理后输出到扬声器。
 */

let audioCtx     = null;
let workletNode  = null;
let sourceNode   = null;
let currentStream = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'OFFSCREEN_INIT':
      initProcessing(msg.streamId, msg.settings)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error('[WZQ Zero Offscreen] 初始化失败:', e);
          sendResponse({ ok: false, error: e.message });
        });
      return true; // 保持信道开放（异步）

    case 'SETTINGS_UPDATED':
      updateSettings(msg.settings);
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_STOP':
      stopProcessing();
      sendResponse({ ok: true });
      break;

    default:
      break;
  }
});

async function initProcessing(streamId, settings) {
  if (audioCtx) stopProcessing();

  // 1. 通过 tabCapture 流 ID 获取 MediaStream
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  currentStream = stream;

  // 2. 创建 AudioContext
  audioCtx = new AudioContext();

  // 3. 加载 AudioWorklet 处理器
  const processorUrl = chrome.runtime.getURL('audio-processor.js');
  await audioCtx.audioWorklet.addModule(processorUrl);

  // 4. 构建处理链：MediaStream → AudioWorklet → 扬声器
  sourceNode  = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'noise-suppressor-processor', {
    numberOfInputs:     1,
    numberOfOutputs:    1,
    outputChannelCount: [2],
  });

  applySettings(settings);

  sourceNode.connect(workletNode);
  workletNode.connect(audioCtx.destination);

  console.log('[WZQ Zero Offscreen] 音频处理链已建立');
}

function applySettings(settings) {
  if (!workletNode) return;
  workletNode.port.postMessage({
    type:     'UPDATE_SETTINGS',
    enabled:  settings.enabled,
    strength: (settings.strength ?? 70) / 100,
    mode:     settings.mode ?? 'crowd-suppress',
  });
}

function updateSettings(settings) {
  applySettings({ ...{ enabled: true, strength: 70, mode: 'crowd-suppress' }, ...settings });
}

function stopProcessing() {
  try {
    sourceNode?.disconnect();
    workletNode?.disconnect();
    audioCtx?.close();
    currentStream?.getTracks().forEach((t) => t.stop());
  } catch (_) { /* 忽略关闭错误 */ }
  audioCtx      = null;
  workletNode   = null;
  sourceNode    = null;
  currentStream = null;
}
