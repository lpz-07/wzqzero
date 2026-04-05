/**
 * audio-processor.js — AudioWorkletProcessor
 *
 * 实时谱减法降噪处理器，用于抑制体育直播中观众的呐喊声。
 *
 * 算法原理：
 *  1. 将输入音频分帧（帧长 512 样本），相邻帧之间 75% 重叠
 *  2. 对每帧做 FFT，得到幅度谱和相位谱
 *  3. 用最小统计量法估计噪声底噪（观众背景声估计值）
 *  4. 采用 Wiener 滤波器计算增益：在人声频率范围内抑制低 SNR 频段
 *  5. 保留人声范围以外的频率（低频击球声、高频环境音）
 *  6. IFFT 重建信号，叠加还原（OLA 合成）
 *
 * 处理延迟：FFT_SIZE/sampleRate ≈ 11.6 ms（44100 Hz），对直播观赛体验无影响。
 */

class NoiseSuppressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── 可调参数 ────────────────────────────────────────────────
    this.enabled  = false;
    this.strength = 0.7;   // 0.0（不抑制）~ 1.0（最强抑制）
    this.mode     = 'crowd-suppress'; // 'crowd-suppress' | 'commentary-only' | 'passthrough'
    this.aiEnabled = false;
    this.aiSensitivity = 0.55;

    // ── FFT 参数 ────────────────────────────────────────────────
    this.FFT_SIZE = 512;
    this.HOP_SIZE = 128;   // 75% 重叠
    this.HALF     = this.FFT_SIZE / 2 + 1;

    // ── Hann 窗 ─────────────────────────────────────────────────
    this.win = new Float32Array(this.FFT_SIZE);
    for (let i = 0; i < this.FFT_SIZE; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.FFT_SIZE);
    }
    // 75% 重叠 Hann 窗的叠加归一化因子恒为 2.0
    this.WIN_NORM = 2.0;

    // ── 每声道缓冲区（最多 2 声道）──────────────────────────────
    const MAX_CH = 2;
    // 输入队列：线性缓冲，使用 copyWithin 前移
    this.inBuf    = Array.from({ length: MAX_CH }, () => new Float32Array(this.FFT_SIZE * 4));
    this.inBufLen = new Int32Array(MAX_CH);
    // OLA 叠加缓冲（长度 = FFT_SIZE，每帧处理后前移 HOP_SIZE）
    this.olaBuf   = Array.from({ length: MAX_CH }, () => new Float32Array(this.FFT_SIZE));
    // 输出队列
    this.outBuf    = Array.from({ length: MAX_CH }, () => new Float32Array(this.FFT_SIZE * 4));
    this.outBufLen = new Int32Array(MAX_CH);

    // ── FFT 工作区 ──────────────────────────────────────────────
    this.fRe = Array.from({ length: MAX_CH }, () => new Float32Array(this.FFT_SIZE));
    this.fIm = Array.from({ length: MAX_CH }, () => new Float32Array(this.FFT_SIZE));
    this.magBuf      = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.phaseBuf    = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.outMagBuf   = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.rawGainBuf  = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.smoothGainBuf = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.prevGain    = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF).fill(1));
    this.prevMag     = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF));
    this.transientHold = new Int32Array(MAX_CH);

    // ── 噪声底噪估计（最小统计量法）────────────────────────────
    this.noiseFloor  = Array.from({ length: MAX_CH }, () => new Float32Array(this.HALF).fill(1e-6));
    this.HIST_LEN    = 25;   // 历史帧数（≈ 370 ms @ 512/44100）
    this.NOISE_ALPHA = 0.08; // 噪声底噪平滑系数
    this.MIN_EPSILON = 1e-8; // 数值稳定下限，防止除零与极小值抖动
    this.NOISE_EST_SCALE = 1.8; // 噪声估计随强度放大系数（经验值，平衡抑制与失真）
    this.TRANSIENT_PROTECT_FREQ_LOW = 420; // 经验边界（Hz）：实测可覆盖击球瞬态低频冲击，同时尽量不放大女声喊话主体
    // 模式参数（经验调参值，用于平衡抑制强度与语音自然度）
    this.MODE_PARAMS = {
      'crowd-suppress': {
        gainFloor: 0.08,     // 增益下限，避免过度衰减导致金属感
        overSubBase: 1.2,    // 过减基值（越大越强）
        overSubScale: 1.3,   // 随 strength 增加的附加过减
        timeSmooth: 0.74,    // 帧间平滑，抑制增益抖动
        transientRatio: 6.0, // 瞬态保护门限，保护解说突发
        transientGainFloor: 0.75,
        femaleBandLow: 700,   // 女声“加油”主能量频带
        femaleBandHigh: 2800,
        femaleSuppressBoost: 1.35,
        femaleBandLowSnrClamp: 1.6, // 女声频段低 SNR 时进一步压低残留，减少乱音
        femaleBandLowSnrGainCeil: 0.22,
        femaleBandTimeSmooth: 0.90, // 女声频段增强时域平滑，降低增益抖动伪影
        transientFluxThreshold: 0.55, // 宽带瞬态阈值（保护击球）
        transientHoldFrames: 2,
        transientProtectScale: 0.60,  // 瞬态时降低抑制强度
      },
      'commentary-only': {
        gainFloor: 0.10,
        overSubBase: 1.4,
        overSubScale: 1.6,
        timeSmooth: 0.82,
        transientRatio: 4.5,
        transientGainFloor: 0.75,
        femaleBandLow: 650,
        femaleBandHigh: 3200,
        femaleSuppressBoost: 1.45,
        femaleBandLowSnrClamp: 1.8,
        femaleBandLowSnrGainCeil: 0.20,
        femaleBandTimeSmooth: 0.92,
        transientFluxThreshold: 0.60,
        transientHoldFrames: 2,
        transientProtectScale: 0.65,
      },
    };
    // 3 点频域平滑核，减少孤立频点“音乐噪声”
    this.FREQ_SMOOTH = {
      left: 0.2,
      center: 0.6,
      right: 0.2,
    };
    // 固定长度环形历史缓冲，避免实时分配引发杂音
    this.magHistory  = Array.from({ length: MAX_CH }, () =>
      Array.from({ length: this.HIST_LEN }, () => new Float32Array(this.HALF))
    );
    this.magHistLen  = new Int32Array(MAX_CH);
    this.magHistPos  = new Int32Array(MAX_CH);

    // ── 接收来自 content/offscreen 的控制消息 ──────────────────
    this.port.onmessage = (e) => {
      if (e.data.type === 'UPDATE_SETTINGS') {
        this.enabled  = !!e.data.enabled;
        this.strength = e.data.strength ?? 0.7;
        this.mode     = e.data.mode     ?? 'crowd-suppress';
        this.aiEnabled = !!e.data.aiEnabled;
        this.aiSensitivity = e.data.aiSensitivity ?? 0.55;
      }
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Cooley-Tukey 基-2 FFT（原位）
  // ────────────────────────────────────────────────────────────────
  _fft(re, im) {
    const n = re.length;
    // 比特反转置换
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // 蝶形运算
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang  = -2 * Math.PI / len;
      const wRe  = Math.cos(ang);
      const wIm  = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1.0, curIm = 0.0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
          const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
          re[i + j]        = uRe + vRe;
          im[i + j]        = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
          const newRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = newRe;
        }
      }
    }
  }

  _ifft(re, im) {
    const n = re.length;
    // 共轭 → FFT → 共轭 → 缩放
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this._fft(re, im);
    const inv = 1.0 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }

  // ────────────────────────────────────────────────────────────────
  // 处理一帧（对声道 ch）
  // ────────────────────────────────────────────────────────────────
  _processFrame(ch) {
    const N    = this.FFT_SIZE;
    const HALF = this.HALF;
    const re   = this.fRe[ch];
    const im   = this.fIm[ch];
    const buf  = this.inBuf[ch];
    const win  = this.win;

    // 1. 加窗
    for (let i = 0; i < N; i++) {
      re[i] = buf[i] * win[i];
      im[i] = 0;
    }

    // 2. FFT → 幅度谱 + 相位谱
    this._fft(re, im);
    const mag   = this.magBuf[ch];
    const phase = this.phaseBuf[ch];
    for (let k = 0; k < HALF; k++) {
      mag[k]   = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // 3. 更新噪声底噪估计（最小统计量）
    const hist = this.magHistory[ch];
    const histPos = this.magHistPos[ch];
    hist[histPos].set(mag); // 写入环形历史
    this.magHistPos[ch] = (histPos + 1) % this.HIST_LEN;
    if (this.magHistLen[ch] < this.HIST_LEN) this.magHistLen[ch]++;

    const floor = this.noiseFloor[ch];
    const histLen = this.magHistLen[ch];
    for (let k = 0; k < HALF; k++) {
      let minVal = Infinity;
      for (let h = 0; h < histLen; h++) {
        if (hist[h][k] < minVal) minVal = hist[h][k];
      }
      // 指数平滑：噪声底噪缓慢向最小值收敛
      const floorMin = Math.max(this.MIN_EPSILON, minVal);
      floor[k] = (1 - this.NOISE_ALPHA) * floor[k] + this.NOISE_ALPHA * floorMin;
    }

    // 4. 计算增益并抑制人声频段（频域+时域平滑，降低“兹拉兹拉”音乐噪声）
    const sr       = globalThis.sampleRate || 44100;
    const binHz    = sr / N;
    const outMag   = this.outMagBuf[ch];
    const rawGain  = this.rawGainBuf[ch];
    const smoothGain = this.smoothGainBuf[ch];
    const prevGain = this.prevGain[ch];
    const alpha    = this.strength;

    // 根据模式确定人声抑制频率范围
    let vocalLow  = 200;
    let vocalHigh = 4000;
    const modeParams = this.MODE_PARAMS[this.mode] || this.MODE_PARAMS['crowd-suppress'];
    let gainFloor = modeParams.gainFloor;
    let overSub   = modeParams.overSubBase + alpha * modeParams.overSubScale;
    let timeSmooth = modeParams.timeSmooth;
    let transientRatio = modeParams.transientRatio;
    let transientGainFloor = modeParams.transientGainFloor;
    let femaleBandLow = modeParams.femaleBandLow;
    let femaleBandHigh = modeParams.femaleBandHigh;
    let femaleSuppressBoost = modeParams.femaleSuppressBoost;
    let femaleBandLowSnrClamp = modeParams.femaleBandLowSnrClamp;
    let femaleBandLowSnrGainCeil = modeParams.femaleBandLowSnrGainCeil;
    let femaleBandTimeSmooth = modeParams.femaleBandTimeSmooth;
    let transientFluxThreshold = modeParams.transientFluxThreshold;
    let transientHoldFrames = modeParams.transientHoldFrames;
    let transientProtectScale = modeParams.transientProtectScale;
    if (this.mode === 'commentary-only') {
      vocalLow  = 80;
      vocalHigh = 6000;
    }

    // 帧级瞬态检测：乒乓球击球通常是宽带突发，观众“加油”更偏持续人声
    const prevMag = this.prevMag[ch];
    let fluxNum = 0;
    let fluxDen = 0;
    for (let k = 1; k < HALF; k++) {
      const cur = mag[k];
      const delta = cur - prevMag[k];
      if (delta > 0) fluxNum += delta;
      fluxDen += cur;
      prevMag[k] = cur;
    }
    prevMag[0] = mag[0];
    const spectralFlux = fluxNum / (fluxDen + this.MIN_EPSILON);
    if (spectralFlux > transientFluxThreshold) this.transientHold[ch] = transientHoldFrames;
    const transientActive = this.transientHold[ch] > 0;
    if (this.transientHold[ch] > 0) this.transientHold[ch]--;

    // 超小型 AI 判别层（无外部模型）：以频带能量比例 + 谱平坦度近似识别“持续加油”帧
    // 仅输出 0~1 的 cheeringProb，用于动态调节既有抑制强度，不替换主算法链路
    let cheeringProb = 0.0;
    if (this.aiEnabled) {
      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const ratioScore = (v, lo, hi) => clamp01((v - lo) / (hi - lo + this.MIN_EPSILON));
      let totalEnergy = this.MIN_EPSILON;
      let femaleBandEnergy = this.MIN_EPSILON;
      let lowBandEnergy = this.MIN_EPSILON;
      let geomLogSum = 0;
      let arithSum = 0;
      let flatBins = 0;

      for (let k = 1; k < HALF; k++) {
        const freq = k * binHz;
        const m = Math.max(mag[k], this.MIN_EPSILON);
        totalEnergy += m;
        if (freq >= femaleBandLow && freq <= femaleBandHigh) femaleBandEnergy += m;
        if (freq >= 80 && freq <= 350) lowBandEnergy += m;
        if (freq >= vocalLow && freq <= vocalHigh) {
          geomLogSum += Math.log(m);
          arithSum += m;
          flatBins++;
        }
      }

      const femaleRatio = femaleBandEnergy / totalEnergy;
      const lowRatio = lowBandEnergy / totalEnergy;
      const sfm = flatBins > 0 ? Math.exp(geomLogSum / flatBins) / (arithSum / flatBins + this.MIN_EPSILON) : 0;
      // 经验权重：加油声通常具备较高女声带占比、较低低频占比、且谱更“噪声化”
      const ratioProb = ratioScore(femaleRatio, 0.12, 0.40);
      const lowPenalty = ratioScore(lowRatio, 0.03, 0.12);
      const sfmProb = ratioScore(sfm, 0.22, 0.58);
      let rawProb = 0.60 * ratioProb + 0.35 * sfmProb - 0.25 * lowPenalty;
      rawProb = clamp01(rawProb);
      // 由敏感度映射触发门限：敏感度越高，越容易判为加油声
      const th = 0.55 - 0.25 * this.aiSensitivity;
      cheeringProb = clamp01((rawProb - th) / (1 - th + this.MIN_EPSILON));
    }

    for (let k = 0; k < HALF; k++) {
      const freq = k * binHz;
      rawGain[k] = 1.0;
      outMag[k] = mag[k];

      if (freq >= vocalLow && freq <= vocalHigh) {
        const noiseEst = floor[k] * (1.0 + alpha * this.NOISE_EST_SCALE);
        const curMag = Math.max(mag[k], this.MIN_EPSILON);
        let suppressScale = 1.0;
        // 对“女声加油”主频段加重抑制
        if (freq >= femaleBandLow && freq <= femaleBandHigh) suppressScale *= femaleSuppressBoost;
        // AI 判别到疑似加油帧时，仅在女声主频段进一步加重抑制
        if (this.aiEnabled && freq >= femaleBandLow && freq <= femaleBandHigh) {
          suppressScale *= (1.0 + 0.65 * cheeringProb);
        }
        // 瞬态保护：击球时仅在女声主频段之外放松抑制，避免“加油”声在保护窗口内被放出来
        if (transientActive && (freq < this.TRANSIENT_PROTECT_FREQ_LOW || freq > femaleBandHigh)) {
          suppressScale *= transientProtectScale;
        }

        let gain = Math.max(0, 1.0 - (overSub * suppressScale * noiseEst) / curMag);

        // 瞬态/解说突发保护，减少闷声与抽吸
        if (curMag > noiseEst * transientRatio) gain = Math.max(gain, transientGainFloor);
        // 女声“加油”主频段：低 SNR 时限制残留增益，减少嘈杂乱音
        if (freq >= femaleBandLow && freq <= femaleBandHigh && curMag < noiseEst * femaleBandLowSnrClamp) {
          gain = Math.min(gain, femaleBandLowSnrGainCeil);
        }

        rawGain[k] = Math.min(1.0, Math.max(gainFloor, gain));
      }
    }

    // 频域平滑：抑制孤立窄带尖刺（音乐噪声）
    for (let k = 0; k < HALF; k++) {
      const freq = k * binHz;
      const inFemaleBand = freq >= femaleBandLow && freq <= femaleBandHigh;
      const l = k > 0 ? k - 1 : k;
      const r = k < HALF - 1 ? k + 1 : k;
      if (inFemaleBand) {
        const l2 = k > 1 ? k - 2 : l;
        const r2 = k < HALF - 2 ? k + 2 : r;
        // 女声频段使用更宽核平滑，抑制窄带“音乐噪声”
        smoothGain[k] =
          0.1 * rawGain[l2] +
          0.2 * rawGain[l] +
          0.4 * rawGain[k] +
          0.2 * rawGain[r] +
          0.1 * rawGain[r2];
      } else {
        smoothGain[k] =
          this.FREQ_SMOOTH.left * rawGain[l] +
          this.FREQ_SMOOTH.center * rawGain[k] +
          this.FREQ_SMOOTH.right * rawGain[r];
      }
    }

    // 时域平滑：降低帧间增益抖动导致的“兹拉”感
    for (let k = 0; k < HALF; k++) {
      const freq = k * binHz;
      const inFemaleBand = freq >= femaleBandLow && freq <= femaleBandHigh;
      if (freq >= vocalLow && freq <= vocalHigh) {
        const localTimeSmooth = inFemaleBand
          ? Math.max(timeSmooth, femaleBandTimeSmooth)
          : timeSmooth;
        const g = localTimeSmooth * prevGain[k] + (1 - localTimeSmooth) * smoothGain[k];
        prevGain[k] = g;
        outMag[k] = mag[k] * g;
      } else {
        prevGain[k] = 1.0;
      }
    }

    // 5. 重建频谱（保留原始相位）
    for (let k = 0; k < HALF; k++) {
      re[k] = outMag[k] * Math.cos(phase[k]);
      im[k] = outMag[k] * Math.sin(phase[k]);
    }
    // 实信号对称性镜像（负频率部分）
    for (let k = HALF; k < N; k++) {
      re[k] =  re[N - k];
      im[k] = -im[N - k];
    }

    // 6. IFFT
    this._ifft(re, im);

    // 7. OLA 叠加（不对 IFFT 输出再加窗，叠加归一化因子=WIN_NORM=2）
    const ola = this.olaBuf[ch];
    for (let i = 0; i < N; i++) {
      ola[i] += re[i]; // 叠加到 OLA 缓冲
    }

    // 8. 将 OLA 缓冲前 HOP_SIZE 个样本放入输出队列（除以归一化因子）
    const outBuf    = this.outBuf[ch];
    const outBufLen = this.outBufLen[ch];
    const HOP       = this.HOP_SIZE;
    const norm      = this.WIN_NORM;
    for (let i = 0; i < HOP; i++) {
      outBuf[outBufLen + i] = ola[i] / norm;
    }
    this.outBufLen[ch] += HOP;

    // 9. OLA 缓冲前移 HOP_SIZE（清除已输出部分）
    ola.copyWithin(0, HOP);
    ola.fill(0, N - HOP); // 末尾清零，供下一帧叠加
  }

  // ────────────────────────────────────────────────────────────────
  // AudioWorklet 标准 process() 回调
  // ────────────────────────────────────────────────────────────────
  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input?.length) return true;

    const nCh = Math.min(input.length, output.length, 2);
    const bs  = input[0].length; // 通常为 128

    for (let ch = 0; ch < nCh; ch++) {
      if (!this.enabled || this.mode === 'passthrough') {
        // 透传模式
        output[ch].set(input[ch]);
        continue;
      }

      // ── 1. 将输入追加到输入队列 ────────────────────────────────
      const inLen = this.inBufLen[ch];
      this.inBuf[ch].set(input[ch], inLen);
      this.inBufLen[ch] += bs;

      // ── 2. 累积足够样本后逐帧处理 ──────────────────────────────
      while (this.inBufLen[ch] >= this.FFT_SIZE) {
        this._processFrame(ch);
        // 前移输入队列 HOP_SIZE（保留重叠部分供下一帧使用）
        const remaining = this.inBufLen[ch] - this.HOP_SIZE;
        this.inBuf[ch].copyWithin(0, this.HOP_SIZE, this.inBufLen[ch]);
        this.inBufLen[ch] = remaining;
      }

      // ── 3. 从输出队列读取 bs 个样本 ────────────────────────────
      const outData   = output[ch];
      const outBuf    = this.outBuf[ch];
      const available = this.outBufLen[ch];

      if (available >= bs) {
        outData.set(outBuf.subarray(0, bs));
        outBuf.copyWithin(0, bs, available);
        this.outBufLen[ch] -= bs;
      } else {
        // 启动期输出队列未满时，静音等待
        outData.fill(0);
      }
    }

    return true;
  }
}

registerProcessor('noise-suppressor-processor', NoiseSuppressorProcessor);
