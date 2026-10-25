class AudioEngine {
  constructor() {
    this.ctx = null;
    this.isInitialized = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.micStream = null;
    this.micSource = null;
    this.micGain = null;
    this.micAnalyser = null;
    this.fftData = new Uint8Array(64);
    this.masterGain = null;
    this.reverbConvolver = null;
    this.reverbGain = null;
    this.peerNodes = new Map();
    this.onMicChunk = null;
    this.captureNode = null;
    this.captureSink = null;
    this.targetCaptureRate = 16000;
    this.locallyMuted = new Set();
    this.distanceModel = 'inverse';
    this.rolloffFactor = 1.2;
    this.refDistance = 2.0;
    this.maxDistance = 45.0;
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.listenerHeading = 0;
  }

  async init() {
    if (this.isInitialized) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    this.initSyntheticReverb();

    this.isInitialized = true;
    console.log('[AudioEngine] Initialized Web Audio Context. Sample Rate:', this.ctx.sampleRate);
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  initSyntheticReverb() {
    const rate = this.ctx.sampleRate;
    const duration = 2.0;
    const decay = 2.5;
    const length = Math.floor(rate * duration);
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = i / length;
      const factor = Math.exp(-n * decay);
      left[i] = (Math.random() * 2 - 1) * factor;
      right[i] = (Math.random() * 2 - 1) * factor;
    }

    this.reverbConvolver = this.ctx.createConvolver();
    this.reverbConvolver.buffer = impulse;

    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.reverbConvolver.connect(this.reverbGain);
    this.reverbGain.connect(this.masterGain);
  }

  updateListener(x, y, z = 0, headingDeg = 0) {
    if (!this.ctx) return;

    this.listenerPos = { x, y, z };
    this.listenerHeading = headingDeg;

    const listener = this.ctx.listener;
    const headingRad = (headingDeg * Math.PI) / 180;
    const forwardX = Math.cos(headingRad);
    const forwardY = Math.sin(headingRad);
    const forwardZ = 0;
    const upX = 0;
    const upY = 0;
    const upZ = 1;
    const time = this.ctx.currentTime;
    const ramp = 0.05;

    if (listener.positionX) {
      listener.positionX.setTargetAtTime(x, time, ramp);
      listener.positionY.setTargetAtTime(y, time, ramp);
      listener.positionZ.setTargetAtTime(z, time, ramp);
      listener.forwardX.setTargetAtTime(forwardX, time, ramp);
      listener.forwardY.setTargetAtTime(forwardY, time, ramp);
      listener.forwardZ.setTargetAtTime(forwardZ, time, ramp);
      listener.upX.setTargetAtTime(upX, time, ramp);
      listener.upY.setTargetAtTime(upY, time, ramp);
      listener.upZ.setTargetAtTime(upZ, time, ramp);
    } else {
      listener.setPosition(x, y, z);
      listener.setOrientation(forwardX, forwardY, forwardZ, upX, upY, upZ);
    }
  }

  setAcousticEnvironment(zone) {
    if (!this.ctx || !this.reverbGain) return;

    const time = this.ctx.currentTime;
    const ramp = 0.1;

    if (zone && zone.reverb_level > 0) {
      this.reverbGain.gain.setTargetAtTime(Math.min(1.0, zone.reverb_level), time, ramp);
    } else {
      this.reverbGain.gain.setTargetAtTime(0.0, time, ramp);
    }
  }

  getOrCreatePeerChannel(peerId, isBot = false, soundConfig = {}, options = {}) {
    if (!this.ctx) return null;

    if (this.peerNodes.has(peerId)) {
      return this.peerNodes.get(peerId);
    }

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = this.distanceModel;
    panner.refDistance = this.refDistance;
    panner.maxDistance = this.maxDistance;
    panner.rolloffFactor = this.distanceModel === 'linear'
      ? Math.min(1, this.rolloffFactor)
      : this.rolloffFactor;

    if (options.omni) {
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1.0;
    } else {
      panner.coneInnerAngle = 120;
      panner.coneOuterAngle = 240;
      panner.coneOuterGain = 0.3;
    }

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(20000, this.ctx.currentTime);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.0, this.ctx.currentTime);

    filter.connect(panner);
    panner.connect(gain);
    gain.connect(this.masterGain);

    if (this.reverbConvolver) {
      gain.connect(this.reverbConvolver);
    }

    const channel = {
      panner,
      filter,
      gain,
      isBot,
      soundConfig,
      isBeacon: !!options.omni,
      positioned: false,
      lastPulse: 0
    };

    this.peerNodes.set(peerId, channel);

    if (isBot) {
      this.startBotAudioSynthesis(peerId, channel);
    }

    return channel;
  }

  updatePeerSpatialState(peerId, peerData, acousticFilter = null) {
    const channel = this.peerNodes.get(peerId);
    if (!channel || !this.ctx) return;

    const time = this.ctx.currentTime;
    const ramp = 0.05;
    const x = peerData.x;
    const y = peerData.y;
    const z = peerData.z || 0;
    const headingRad = ((peerData.heading || 0) * Math.PI) / 180;

    if (channel.panner.positionX) {
      const set = (param, value) => {
        if (channel.positioned) {
          param.setTargetAtTime(value, time, ramp);
        } else {
          param.setValueAtTime(value, time);
        }
      };

      set(channel.panner.positionX, x);
      set(channel.panner.positionY, y);
      set(channel.panner.positionZ, z);
      set(channel.panner.orientationX, Math.cos(headingRad));
      set(channel.panner.orientationY, Math.sin(headingRad));
      set(channel.panner.orientationZ, 0);
      channel.positioned = true;
    } else {
      channel.panner.setPosition(x, y, z);
      channel.panner.setOrientation(Math.cos(headingRad), Math.sin(headingRad), 0);
    }

    if (acousticFilter) {
      const cutoff = acousticFilter.cutoff || 20000;
      channel.filter.frequency.setTargetAtTime(cutoff, time, ramp);

      const targetGain = this.locallyMuted.has(peerId)
        ? 0
        : acousticFilter.gainMultiplier !== undefined
          ? acousticFilter.gainMultiplier
          : 1.0;

      channel.gain.gain.setTargetAtTime(targetGain, time, ramp);
    }
  }

  syncAudiblePeers(audibleIds) {
    for (const [id, channel] of Array.from(this.peerNodes.entries())) {
      if (channel.isBeacon) continue;
      if (!audibleIds.has(id)) this.removePeerChannel(id);
    }
  }

  setDistanceModel(model) {
    this.distanceModel = model;

    for (const ch of this.peerNodes.values()) {
      ch.panner.distanceModel = model;
      ch.panner.rolloffFactor = model === 'linear'
        ? Math.min(1, this.rolloffFactor)
        : this.rolloffFactor;
    }
  }

  setRolloffFactor(value) {
    this.rolloffFactor = value;

    for (const ch of this.peerNodes.values()) {
      ch.panner.rolloffFactor = this.distanceModel === 'linear'
        ? Math.min(1, value)
        : value;
    }
  }

  setMaxDistance(value) {
    this.maxDistance = value;

    for (const ch of this.peerNodes.values()) {
      if (!ch.isBeacon) ch.panner.maxDistance = value;
    }
  }

  removePeerChannel(peerId) {
    const channel = this.peerNodes.get(peerId);

    if (channel) {
      if (channel.botInterval) {
        clearInterval(channel.botInterval);
      }

      try {
        channel.gain.disconnect();
        channel.panner.disconnect();
        channel.filter.disconnect();
      } catch (e) {}

      this.peerNodes.delete(peerId);
    }
  }

  startBotAudioSynthesis(peerId, channel) {
    const freq = channel.soundConfig.audioFrequency || 440;
    const pattern = channel.soundConfig.soundPattern || 'pulse';

    const playTone = () => {
      if (!this.ctx || this.ctx.state !== 'running' || this.isDeafened) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();

      osc.type = pattern === 'chime' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);

      if (pattern === 'chime') {
        osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.1);
        osc.frequency.exponentialRampToValueAtTime(freq, now + 0.4);
      }

      env.gain.setValueAtTime(0.001, now);
      env.gain.exponentialRampToValueAtTime(0.25, now + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(env);
      env.connect(channel.filter);

      osc.start(now);
      osc.stop(now + 0.38);
    };

    playTone();
    channel.botInterval = setInterval(playTone, 1800);
  }

  playBeaconChime(beacon) {
    if (!this.ctx || this.isDeafened) return;

    const channel = this.getOrCreatePeerChannel(beacon.id, false, {}, { omni: true });
    if (!channel) return;

    this.updatePeerSpatialState(beacon.id, {
      x: beacon.x,
      y: beacon.y,
      z: 0
    });

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(beacon.frequency || 523.25, now);
    osc.frequency.exponentialRampToValueAtTime(
      (beacon.frequency || 523.25) * 0.8,
      now + 1.2
    );

    env.gain.setValueAtTime(0.001, now);
    env.gain.exponentialRampToValueAtTime(0.4, now + 0.05);
    env.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

    osc.connect(env);
    env.connect(channel.filter);

    osc.start(now);
    osc.stop(now + 1.6);
  }

  async setupMicrophone() {
    await this.init();
    await this.resume();

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      this.micGain = this.ctx.createGain();
      this.micGain.gain.setValueAtTime(
        this.isMuted ? 0 : 1.0,
        this.ctx.currentTime
      );

      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 128;
      this.micAnalyser.smoothingTimeConstant = 0.8;

      this.micSource.connect(this.micGain);
      this.micGain.connect(this.micAnalyser);
      this.startCapture();

      console.log('[AudioEngine] Microphone connected successfully');
      return true;
    } catch (err) {
      console.warn('[AudioEngine] Microphone access denied or unavailable:', err.message);
      return false;
    }
  }

  startCapture() {
    if (this.captureNode || !this.micGain) return;

    const node = this.ctx.createScriptProcessor(2048, 1, 1);

    node.onaudioprocess = (e) => {
      if (!this.onMicChunk || this.isMuted) return;

      const input = e.inputBuffer.getChannelData(0);
      const ratio = this.ctx.sampleRate / this.targetCaptureRate;
      const outLen = Math.floor(input.length / ratio);
      const pcm = new Int16Array(outLen);

      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;

        for (let j = start; j < end; j++) {
          sum += input[j];
        }

        const v = Math.max(
          -1,
          Math.min(1, sum / Math.max(1, end - start))
        );

        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }

      this.onMicChunk(
        AudioEngine.pcmToBase64(pcm),
        this.targetCaptureRate
      );
    };

    this.captureSink = this.ctx.createGain();
    this.captureSink.gain.value = 0;

    this.micGain.connect(node);
    node.connect(this.captureSink);
    this.captureSink.connect(this.ctx.destination);
    this.captureNode = node;
  }

  static pcmToBase64(pcm) {
    const bytes = new Uint8Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength
    );

    let binary = '';

    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + 0x8000)
      );
    }

    return btoa(binary);
  }

  static base64ToFloat32(b64) {
    const binary = atob(b64);
    const len = binary.length >> 1;
    const out = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      let v = binary.charCodeAt(2 * i) |
        (binary.charCodeAt(2 * i + 1) << 8);

      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 0x8000;
    }

    return out;
  }

  playVoiceChunk(senderId, b64, sampleRate, peerData = null, acousticFilter = null) {
    if (!this.ctx || this.ctx.state !== 'running' || this.isDeafened) return;
    if (this.locallyMuted.has(senderId)) return;

    const channel = this.getOrCreatePeerChannel(senderId, false);
    if (!channel) return;

    if (peerData) {
      this.updatePeerSpatialState(senderId, peerData, acousticFilter);
    } else if (!channel.positioned) {
      return;
    }

    const samples = AudioEngine.base64ToFloat32(b64);
    if (!samples.length) return;

    const buffer = this.ctx.createBuffer(
      1,
      samples.length,
      sampleRate || 16000
    );

    buffer.copyToChannel(samples, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(channel.filter);

    const now = this.ctx.currentTime;
    const jitter = 0.08;
    let startAt = channel.nextPlayTime || 0;

    if (startAt < now + 0.01 || startAt > now + 0.6) {
      startAt = now + jitter;
    }

    src.start(startAt);
    channel.nextPlayTime = startAt + buffer.duration;
    channel.lastVoice = performance.now();
  }

  isReceivingVoice(peerId) {
    const ch = this.peerNodes.get(peerId);

    return !!ch &&
      !!ch.lastVoice &&
      performance.now() - ch.lastVoice < 600;
  }

  setPeerLocallyMuted(peerId, muted) {
    if (muted) {
      this.locallyMuted.add(peerId);
    } else {
      this.locallyMuted.delete(peerId);
    }

    const ch = this.peerNodes.get(peerId);

    if (ch && this.ctx) {
      ch.gain.gain.setTargetAtTime(
        muted ? 0 : 1,
        this.ctx.currentTime,
        0.05
      );
    }
  }

  getMicLevel() {
    if (!this.micAnalyser || this.isMuted) {
      return {
        volume: 0,
        fft: new Uint8Array(64)
      };
    }

    this.micAnalyser.getByteFrequencyData(this.fftData);

    let sum = 0;

    for (let i = 0; i < this.fftData.length; i++) {
      sum += this.fftData[i];
    }

    const avg = sum / this.fftData.length;
    const normalized = Math.min(1.0, avg / 128.0);

    return {
      volume: normalized,
      fft: this.fftData
    };
  }

  toggleMute(state) {
    this.isMuted = state !== undefined ? state : !this.isMuted;

    if (this.micGain && this.ctx) {
      this.micGain.gain.setValueAtTime(
        this.isMuted ? 0 : 1.0,
        this.ctx.currentTime
      );
    }

    return this.isMuted;
  }

  toggleDeafen(state) {
    this.isDeafened = state !== undefined ? state : !this.isDeafened;

    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(
        this.isDeafened ? 0 : 1.0,
        this.ctx.currentTime
      );
    }

    return this.isDeafened;
  }
}

window.AudioEngine = AudioEngine;