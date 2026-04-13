/**
 * Динамический фон: декодированные треки из music/manifest.json, кроссфейд, анти-повтор, фазы.
 * Пустые списки в manifest → этап не использует стриминг (остаётся процедурная музыка).
 */

/** @typedef {{ url: string; loopStart?: number; loopEnd?: number }} ManifestTrack */

export const BGM_PHASE = /** @type {const} */ ({
  MENU: "menu",
  PRE_ROUND: "preRound",
  CALM: "calm",
  TENSION: "tension",
  BATTLE: "battle",
  CRITICAL: "critical",
  POST_ROUND: "postRound",
  FINAL: "final",
});

/** @type {Set<string>} */
const GAMEPLAY_PHASES = new Set(["calm", "tension", "battle", "critical"]);

/**
 * @typedef {{
 *   crossfadeSec: number;
 *   gameplayTransitionCooldownMs: number;
 *   preRoundCountdownBoostSec: number;
 *   preRoundCountdownGainMul: number;
 *   pauseMusicGainMul: number;
 *   pauseLowpassHz: number;
 *   tracks: Record<string, ManifestTrack[]>;
 * }} BgmManifest
 */

const DEFAULT_MANIFEST = /** @type {BgmManifest} */ ({
  crossfadeSec: 2.2,
  gameplayTransitionCooldownMs: 14000,
  preRoundCountdownBoostSec: 12,
  preRoundCountdownGainMul: 1.1,
  pauseMusicGainMul: 0.5,
  pauseLowpassHz: 950,
  tracks: {
    menu: [],
    preRound: [],
    calm: [],
    tension: [],
    battle: [],
    critical: [],
    postRound: [],
    final: [],
  },
});

function resolveManifestUrl(relativePath) {
  const base = new URL(".", window.location.href).href;
  try {
    return new URL(relativePath, base).href;
  } catch {
    return relativePath;
  }
}

function pickTrackExcluding(tracks, lastUrl) {
  if (!tracks?.length) return null;
  const candidates = tracks.filter((t) => t && t.url && t.url !== lastUrl);
  const pool = candidates.length ? candidates : tracks;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

export class StreamingBgmDirector {
  constructor() {
    /** @type {BgmManifest} */
    this.m = { ...DEFAULT_MANIFEST, tracks: { ...DEFAULT_MANIFEST.tracks } };
    /** @type {Map<string, AudioBuffer>} */
    this.bufferByUrl = new Map();
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {GainNode | null} */
    this.outGain = null;
    /** @type {GainNode | null} */
    this.reactiveGain = null;
    /** @type {BiquadFilterNode | null} */
    this.reactiveLp = null;
    /** @type {BiquadFilterNode | null} */
    this.pauseLp = null;
    /** @type {{ gain: GainNode; lp: BiquadFilterNode } | null} */
    this.slotA = null;
    /** @type {{ gain: GainNode; lp: BiquadFilterNode } | null} */
    this.slotB = null;
    /** @type {AudioBufferSourceNode | null} */
    this.srcA = null;
    /** @type {AudioBufferSourceNode | null} */
    this.srcB = null;
    /** @type {boolean} */
    this.aIsHot = true;
    /** @type {string | null} */
    this.phase = null;
    /** @type {string | null} */
    this.lastUrlA = null;
    /** @type {string | null} */
    this.lastUrlB = null;
    /** @type {number} */
    this.lastGameplaySwitchWallMs = 0;
    /** @type {boolean} */
    this.gameplayPaused = false;
    /** @type {boolean} */
    this.loadStarted = false;
    /** @type {boolean} */
    this.muted = false;
    /** @type {number} */
    this.masterMusicMul = 1;
  }

  /**
   * @param {AudioContext} ctx
   * @param {GainNode} musicDuckInput — узел, куда суммируется музыка (напр. musicDuck)
   */
  attach(ctx, musicDuckInput) {
    this.ctx = ctx;
    this.outGain = ctx.createGain();
    this.outGain.gain.value = 0.0001;
    this.reactiveGain = ctx.createGain();
    this.reactiveGain.gain.value = 1;
    this.reactiveLp = ctx.createBiquadFilter();
    this.reactiveLp.type = "lowpass";
    this.reactiveLp.frequency.value = 20000;
    this.reactiveLp.Q.value = 0.55;
    this.pauseLp = ctx.createBiquadFilter();
    this.pauseLp.type = "lowpass";
    this.pauseLp.frequency.value = 20000;
    this.pauseLp.Q.value = 0.7;
    this.outGain.connect(this.reactiveGain);
    this.reactiveGain.connect(this.reactiveLp);
    this.reactiveLp.connect(this.pauseLp);
    this.pauseLp.connect(musicDuckInput);

    const mkSlot = () => {
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 20000;
      lp.Q.value = 0.65;
      g.connect(lp);
      lp.connect(this.outGain);
      return { gain: g, lp };
    };
    this.slotA = mkSlot();
    this.slotB = mkSlot();
  }

  async loadManifestAndBuffers() {
    if (this.loadStarted) return;
    this.loadStarted = true;
    try {
      const res = await fetch(resolveManifestUrl("music/manifest.json"), { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      if (j && typeof j === "object") {
        this.m.crossfadeSec =
          typeof j.crossfadeSec === "number" && j.crossfadeSec > 0.3 ? j.crossfadeSec : this.m.crossfadeSec;
        this.m.gameplayTransitionCooldownMs =
          typeof j.gameplayTransitionCooldownMs === "number" && j.gameplayTransitionCooldownMs >= 0
            ? j.gameplayTransitionCooldownMs
            : this.m.gameplayTransitionCooldownMs;
        this.m.preRoundCountdownBoostSec =
          typeof j.preRoundCountdownBoostSec === "number" && j.preRoundCountdownBoostSec > 0
            ? j.preRoundCountdownBoostSec
            : this.m.preRoundCountdownBoostSec;
        this.m.preRoundCountdownGainMul =
          typeof j.preRoundCountdownGainMul === "number" && j.preRoundCountdownGainMul >= 1
            ? j.preRoundCountdownGainMul
            : this.m.preRoundCountdownGainMul;
        this.m.pauseMusicGainMul =
          typeof j.pauseMusicGainMul === "number" && j.pauseMusicGainMul > 0 && j.pauseMusicGainMul <= 1
            ? j.pauseMusicGainMul
            : this.m.pauseMusicGainMul;
        this.m.pauseLowpassHz =
          typeof j.pauseLowpassHz === "number" && j.pauseLowpassHz > 200 ? j.pauseLowpassHz : this.m.pauseLowpassHz;
        if (j.tracks && typeof j.tracks === "object") {
          for (const k of Object.keys(DEFAULT_MANIFEST.tracks)) {
            const arr = Array.isArray(j.tracks[k]) ? j.tracks[k] : [];
            this.m.tracks[k] = arr
              .filter((x) => x && typeof x.url === "string" && x.url.length)
              .map((x) => ({ url: x.url, loopStart: x.loopStart, loopEnd: x.loopEnd }));
          }
        }
      }
    } catch {
      /* manifest optional */
    }

    const urls = new Set();
    for (const list of Object.values(this.m.tracks)) {
      for (const t of list) urls.add(t.url);
    }
    if (!this.ctx || urls.size === 0) return;
    for (const url of urls) {
      if (this.bufferByUrl.has(url)) continue;
      try {
        const r = await fetch(resolveManifestUrl(url));
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(ab.slice(0));
        this.bufferByUrl.set(url, buf);
      } catch {
        /* skip broken file */
      }
    }
  }

  /**
   * @param {boolean} paused
   */
  setGameplayPaused(paused) {
    this.gameplayPaused = !!paused;
    this.applyPauseFilter();
  }

  applyPauseFilter() {
    if (!this.ctx || !this.pauseLp) return;
    const t = this.ctx.currentTime;
    const dur = 0.35;
    const cur = Math.max(400, Math.min(20000, this.pauseLp.frequency.value));
    this.pauseLp.frequency.cancelScheduledValues(t);
    this.pauseLp.frequency.setValueAtTime(cur, t);
    const targetHi = 20000;
    const targetLo = Math.max(220, this.m.pauseLowpassHz);
    if (this.gameplayPaused) {
      this.pauseLp.frequency.linearRampToValueAtTime(targetLo, t + dur);
    } else {
      this.pauseLp.frequency.linearRampToValueAtTime(targetHi, t + dur);
    }
  }

  /**
   * @param {boolean} muted
   * @param {number} masterTimesMusic 0..1
   */
  setOutputLevel(muted, masterTimesMusic) {
    this.muted = !!muted;
    this.masterMusicMul = Math.max(0, Math.min(1, masterTimesMusic));
    this.applyOutGainTarget();
  }

  applyOutGainTarget() {
    if (!this.ctx || !this.outGain || !this.reactiveGain) return;
    const t = this.ctx.currentTime;
    let peak = this.muted ? 0.0001 : this.masterMusicMul * (this.gameplayPaused ? this.m.pauseMusicGainMul : 1);
    if (peak > 0.98) peak = 0.98;
    this.outGain.gain.cancelScheduledValues(t);
    this.outGain.gain.setValueAtTime(this.outGain.gain.value, t);
    this.outGain.gain.linearRampToValueAtTime(peak, t + 0.25);
  }

  stopAllSources() {
    try {
      this.srcA?.stop();
    } catch {
      /* */
    }
    try {
      this.srcB?.stop();
    } catch {
      /* */
    }
    this.srcA = null;
    this.srcB = null;
    if (this.slotA) this.slotA.gain.gain.value = 0.0001;
    if (this.slotB) this.slotB.gain.gain.value = 0.0001;
    this.phase = null;
    this.applyReactiveBattleMix({
      uiPhase: "menu",
      gameplayIntensity: 0,
      battlePulse01: 0,
      sustainDread01: 0,
    });
  }

  /**
   * «Живой» микс: микродинамика и открытие спектра по ходу боя (не только смена трека).
   * @param {{
   *   uiPhase: string;
   *   gameplayIntensity?: number;
   *   battlePulse01?: number;
   *   sustainDread01?: number;
   *   preRoundSecondsLeft?: number;
   * }} p
   */
  applyReactiveBattleMix(p) {
    if (!this.ctx || !this.reactiveGain || !this.reactiveLp || !this.slotA || !this.slotB) return;
    const t = this.ctx.currentTime;
    const dur = 0.11;
    const inten = Math.min(3, Math.max(0, p.gameplayIntensity ?? 0));
    const pulse = Math.min(1, Math.max(0, p.battlePulse01 ?? 0));
    const sustain = Math.min(1, Math.max(0, p.sustainDread01 ?? 0));
    const pausedAtten = this.gameplayPaused ? 0.38 : 1;

    let mainOpenHz = 20000;
    let gainMul = 1;
    let slotOpenHz = 20000;

    if (this.phase === "preRound" && typeof p.preRoundSecondsLeft === "number" && p.preRoundSecondsLeft > 0) {
      const ramp = Math.min(1, Math.max(0, (18 - p.preRoundSecondsLeft) / 14));
      mainOpenHz = 9600 + ramp * 9200;
      gainMul = 1 + 0.04 * ramp;
      slotOpenHz = 5200 + ramp * 14800;
    } else if (this.phase && GAMEPLAY_PHASES.has(this.phase)) {
      const baseOpen = 4800 + inten * 3200;
      mainOpenHz = Math.min(
        20000,
        baseOpen + sustain * 7200 + pulse * 5600 + inten * 900
      );
      gainMul =
        1 +
        (0.052 * pulse + 0.038 * sustain + inten * 0.012 + (this.phase === "critical" ? 0.018 : 0)) *
          pausedAtten;
      gainMul = Math.min(1.095, gainMul);
      slotOpenHz = Math.min(
        20000,
        2200 + sustain * 11000 + pulse * 7500 + inten * 2400
      );
    } else {
      mainOpenHz = 20000;
      gainMul = 1;
      slotOpenHz = 20000;
    }

    this.reactiveLp.frequency.cancelScheduledValues(t);
    this.reactiveLp.frequency.setValueAtTime(
      Math.max(400, Math.min(20000, this.reactiveLp.frequency.value)),
      t
    );
    this.reactiveLp.frequency.linearRampToValueAtTime(mainOpenHz, t + dur);

    const rg = Math.max(0.92, Math.min(1.1, gainMul));
    this.reactiveGain.gain.cancelScheduledValues(t);
    this.reactiveGain.gain.setValueAtTime(this.reactiveGain.gain.value, t);
    this.reactiveGain.gain.linearRampToValueAtTime(rg, t + dur);

    for (const slot of [this.slotA, this.slotB]) {
      if (!slot) continue;
      slot.lp.frequency.cancelScheduledValues(t);
      slot.lp.frequency.setValueAtTime(Math.max(400, Math.min(20000, slot.lp.frequency.value)), t);
      slot.lp.frequency.linearRampToValueAtTime(slotOpenHz, t + dur);
    }
  }

  /**
   * @param {{ uiPhase: string; gameplayIntensity?: number; preRoundSecondsLeft?: number }} p
   * @returns {boolean}
   */
  syncFromMain(p) {
    const phaseKey = p.uiPhase;
    const opts = { preRoundSecondsLeft: p.preRoundSecondsLeft };
    if (!this.ctx || !this.outGain || !this.reactiveGain || !this.reactiveLp || !this.slotA || !this.slotB)
      return false;

    const nowWall = performance.now();
    let effectivePhase = phaseKey;

    if (phaseKey === "gameplay") {
      const order = ["calm", "tension", "battle", "critical"];
      const targetIdx = Math.min(3, Math.max(0, p.gameplayIntensity ?? 0));
      const curKey = this.phase && GAMEPLAY_PHASES.has(this.phase) ? this.phase : null;
      const curIdx = curKey ? order.indexOf(curKey) : -1;

      if (curIdx < 0) {
        effectivePhase = order[targetIdx];
        this.lastGameplaySwitchWallMs = nowWall;
      } else if (targetIdx > curIdx) {
        effectivePhase = order[targetIdx];
        this.lastGameplaySwitchWallMs = nowWall;
      } else if (targetIdx < curIdx) {
        if (nowWall - this.lastGameplaySwitchWallMs >= this.m.gameplayTransitionCooldownMs) {
          effectivePhase = order[targetIdx];
          this.lastGameplaySwitchWallMs = nowWall;
        } else {
          effectivePhase = /** @type {string} */ (curKey);
        }
      } else {
        effectivePhase = /** @type {string} */ (curKey);
      }
    } else {
      this.lastGameplaySwitchWallMs = nowWall;
    }

    const tracks = this.m.tracks[effectivePhase];
    if (!tracks?.length) {
      if (this.srcA || this.srcB) this.fadeStreamingOut();
      return false;
    }

    const lastHot = this.aIsHot ? this.lastUrlA : this.lastUrlB;
    const pick = pickTrackExcluding(tracks, lastHot);
    if (!pick) return false;
    const buf = this.bufferByUrl.get(pick.url);
    if (!buf) {
      void this.loadManifestAndBuffers();
      return false;
    }

    if (this.phase === effectivePhase && (this.aIsHot ? this.srcA : this.srcB)) {
      this.applyPreRoundGain(opts.preRoundSecondsLeft);
      return true;
    }

    this.crossfadeToBuffer(buf, pick);
    this.phase = effectivePhase;
    this.applyPreRoundGain(opts.preRoundSecondsLeft);
    return true;
  }

  /**
   * @param {number|undefined} secLeft
   */
  applyPreRoundGain(secLeft) {
    if (!this.ctx || this.phase !== "preRound") return;
    const hot = this.aIsHot ? this.slotA : this.slotB;
    if (!hot) return;
    const t = this.ctx.currentTime;
    const mul =
      typeof secLeft === "number" &&
      secLeft > 0 &&
      secLeft <= this.m.preRoundCountdownBoostSec &&
      Number.isFinite(secLeft)
        ? this.m.preRoundCountdownGainMul
        : 1;
    const base = this.muted ? 0.0001 : this.masterMusicMul * (this.gameplayPaused ? this.m.pauseMusicGainMul : 1) * mul;
    hot.gain.cancelScheduledValues(t);
    const cur = hot.gain.value;
    hot.gain.setValueAtTime(cur, t);
    hot.gain.linearRampToValueAtTime(Math.min(0.98, base), t + 0.4);
  }

  fadeStreamingOut() {
    if (!this.ctx || !this.slotA || !this.slotB) return;
    const t = this.ctx.currentTime;
    const cf = Math.min(2.5, this.m.crossfadeSec);
    this.slotA.gain.cancelScheduledValues(t);
    this.slotB.gain.cancelScheduledValues(t);
    this.slotA.gain.setValueAtTime(this.slotA.gain.value, t);
    this.slotB.gain.setValueAtTime(this.slotB.gain.value, t);
    this.slotA.gain.linearRampToValueAtTime(0.0001, t + cf);
    this.slotB.gain.linearRampToValueAtTime(0.0001, t + cf);
    window.setTimeout(() => {
      this.stopAllSources();
    }, Math.ceil(cf * 1000) + 80);
  }

  /**
   * @param {AudioBuffer} buffer
   * @param {ManifestTrack} track
   */
  crossfadeToBuffer(buffer, track) {
    const ctx = this.ctx;
    if (!ctx || !this.slotA || !this.slotB) return;
    const cf = Math.min(3.5, Math.max(0.5, this.m.crossfadeSec));
    const t = ctx.currentTime;
    const cold = this.aIsHot ? this.slotB : this.slotA;
    const hot = this.aIsHot ? this.slotA : this.slotB;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    if (typeof track.loopStart === "number" && track.loopStart >= 0) src.loopStart = track.loopStart;
    if (typeof track.loopEnd === "number" && track.loopEnd > (track.loopStart || 0)) src.loopEnd = track.loopEnd;

    try {
      this.aIsHot ? this.srcB?.stop() : this.srcA?.stop();
    } catch {
      /* */
    }
    if (this.aIsHot) this.srcB = src;
    else this.srcA = src;

    src.connect(cold.gain);
    const peak = this.muted ? 0.0001 : this.masterMusicMul * (this.gameplayPaused ? this.m.pauseMusicGainMul : 1);
    cold.gain.cancelScheduledValues(t);
    cold.gain.setValueAtTime(0.0001, t);
    cold.gain.linearRampToValueAtTime(Math.min(0.98, peak), t + cf);
    hot.gain.cancelScheduledValues(t);
    hot.gain.setValueAtTime(hot.gain.value, t);
    hot.gain.linearRampToValueAtTime(0.0001, t + cf);

    src.start(t);
    this.aIsHot = !this.aIsHot;
    if (this.aIsHot) {
      this.lastUrlA = track.url;
    } else {
      this.lastUrlB = track.url;
    }
    window.setTimeout(() => {
      try {
        if (this.aIsHot) this.srcB?.stop();
        else this.srcA?.stop();
      } catch {
        /* */
      }
      if (this.aIsHot) {
        this.srcB = null;
      } else {
        this.srcA = null;
      }
    }, Math.ceil(cf * 1000) + 120);
  }

  hasTracksForPhase(key) {
    const list = this.m.tracks[key];
    return Array.isArray(list) && list.length > 0;
  }

  anyStreamingConfigured() {
    for (const list of Object.values(this.m.tracks)) {
      if (list && list.length) return true;
    }
    return false;
  }

  /** Процедурные осцилляторы глушим, пока играет стрим с треками для текущей фазы. */
  shouldSuppressProcedural() {
    if (!this.phase) return false;
    const list = this.m.tracks[this.phase];
    if (!list?.length) return false;
    return !!(this.srcA || this.srcB);
  }
}

export const streamingBgm = new StreamingBgmDirector();
