/* spectral-engine-v2-band.js
   ORANGE PHONE: v2 band source for the visualizers.

   The visualizer joins a room on the shared sync server with a room code, the same as the instruments.
   It does not listen to any audio. It reads the room's clock, tempo and the patterns each instrument slot
   is playing, works out which drum hits and notes are sounding at this moment, and builds the same
   spectrum and waveform arrays the twelve visualizers already draw from. Every screen in the room
   draws from the same server clock, so the pictures land on the beat with no microphone and no sound.

   An audio file that is playing takes priority. When no file plays and the room is live, the band drives the picture.
   This file loads after the main script and replaces analyzeFrame, currentT and updateTime with band aware versions. */
(function(){
"use strict";
const URL_ = (window.SPECTRAL_CONFIG && window.SPECTRAL_CONFIG.syncUrl) || "";
if (!URL_ || !window.createBoardSync || !window.createServerClock || !window.StompboxPattern) return;
const P = window.StompboxPattern;

const N = 1024, SR = 44100, BIN_HZ = SR / 2048;
const acc = new Float32Array(N);
const FAKE = { fftSize: 2048, frequencyBinCount: N, getByteFrequencyData: function(){}, getByteTimeDomainData: function(){} };
let room = null, phones = 0, bandFrame = false;

/* ---------- panel ---------- */
const panel = document.createElement("div");
panel.className = "transport";
panel.id = "band-panel";
panel.innerHTML = '<span style="font-size:0.62rem;letter-spacing:0.15em;color:var(--green-dark)">BAND</span>' +
  '<input id="band-room" type="text" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="room code" aria-label="Room code" ' +
  'style="font-family:inherit;font-size:0.8rem;color:var(--green-dark);background:var(--bg);border:1px solid var(--border);padding:6px 10px;width:150px">' +
  '<span id="band-status" style="font-size:0.62rem;color:var(--dim);letter-spacing:0.06em">band off</span>';
const transport = document.querySelector(".transport");
transport.parentNode.insertBefore(panel, transport.nextSibling);

/* ---------- connection ---------- */
const clock = createServerClock({ send: function(m){ sync.send(m.type, m); }, onChange: function(){ render(); } });
const sync = createBoardSync({
  app: "spectral-engine", schema: 1, url: URL_,
  exportState: function(){ return null; }, loadState: function(){ return false; }, applyChange: function(){},
  onStatus: function(s){ if (s === "live") clock.start(); else { clock.stop(); room = null; } render(); kick(); }
});
sync.on("pong", function(m){ clock.pong(m); });
sync.on("loop", function(m){
  const s = m.state;
  room = s && typeof s.tempo === "number" && s.tempo > 0 && typeof s.epoch === "number" ? s : null;
  phones = m.phones || 0;
  render(); kick();
});

function ready(){ return !isPlaying && sync.status === "live" && clock.synced && !!room; }
const partAt = function(s, bar){ return s.pending && bar >= s.pending.atBar ? s.pending : s; };

/* Starts the animation loop if nothing is running it. */
let running = false;
function kick(){
  if (!ready() || running) return;
  running = true;
  if (typeof animId !== "undefined" && animId) cancelAnimationFrame(animId);
  resetModeState();
  loop();
}

function render(){
  const st = sync.status;
  let text = st === "off" ? "band off" : st === "no room" ? "type a room code" : st;
  if (st === "live") {
    text = phones + (phones === 1 ? " screen or phone" : " screens and phones") + " in room, ";
    if (!clock.synced) text += "locking clock";
    else if (room && room.playing) {
      const bar = P.barAt(room, clock.now());
      text += "following the band at " + partAt(room, bar).tempo + " bpm, groove " + (partAt(room, bar).groove || "");
    } else text += "band stopped, drifting until it starts";
    if (isPlaying) text += ", a file is playing so the file drives the picture";
  }
  document.getElementById("band-status").textContent = text;
}
setInterval(render, 1000);

/* ---------- building the spectrum from the band ---------- */
function bump(centerHz, widthBins, amp){
  const c = centerHz / BIN_HZ;
  const lo = Math.max(0, Math.floor(c - widthBins * 3)), hi = Math.min(N - 1, Math.ceil(c + widthBins * 3));
  for (let i = lo; i <= hi; i++) { const d = (i - c) / widthBins; acc[i] += amp * Math.exp(-d * d); }
}
function band(loHz, hiHz, amp, rough){
  const lo = Math.max(0, Math.floor(loHz / BIN_HZ)), hi = Math.min(N - 1, Math.ceil(hiHz / BIN_HZ));
  for (let i = lo; i <= hi; i++) acc[i] += amp * (1 - rough + rough * Math.random());
}
const DRUM_DECAY = { bd: 0.22, sd: 0.16, hh: 0.05, oh: 0.25, cp: 0.12, ck: 0.05, cl: 0.05 };
function drum(name, amp){
  if (name === "bd") { bump(55, 2.2, amp); bump(110, 2, amp * 0.6); }
  else if (name === "sd") { bump(190, 3, amp * 0.7); band(400, 5000, amp * 0.45, 0.6); }
  else if (name === "hh") band(7000, 14000, amp * 0.5, 0.7);
  else if (name === "oh") band(6000, 15000, amp * 0.55, 0.7);
  else if (name === "cp") band(900, 3000, amp * 0.6, 0.6);
  else if (name === "ck") bump(1600, 1.5, amp * 0.8);
  else if (name === "cl") bump(1000, 1.5, amp * 0.6);
}
const hz = function(m){ return 440 * Math.pow(2, (m - 69) / 12); };

function fill(){
  const sNow = clock.now(), tNow = sNow / 1000;
  acc.fill(0);
  const tones = [];
  let noise = 0, loudest = 0, loudHz = 0;
  if (room.playing) {
    const bar = P.barAt(room, sNow);
    for (let b = bar - 1; b <= bar; b++) {
      if (b < room.barOffset) continue;
      const t0 = P.barTime(room, b), part = partAt(room, b), ms = 240000 / part.tempo;
      ["drums", "bass", "lead", "pad"].forEach(function(slot){
        const src = part.slots && part.slots[slot];
        if (typeof src !== "string" || src.length > 400) return;
        const evs = P.events(src, b);
        for (let k = 0; k < evs.length; k++) {
          const ev = evs[k], ts = t0 + ev.pos * ms, age = (sNow - ts) / 1000;
          if (age < 0) continue;
          if (ev.drum) {
            const amp = Math.exp(-age / (DRUM_DECAY[ev.drum] || 0.1));
            if (amp < 0.02) continue;
            drum(ev.drum, amp);
            if (ev.drum !== "bd") noise += amp * 0.3;
          } else {
            const len = ev.dur * ms / 1000 * (slot === "pad" ? 1 : 0.85);
            const base = slot === "bass" ? 0.95 : slot === "pad" ? 0.45 : 0.75;
            const amp = base * (age < len ? Math.exp(-age * (slot === "pad" ? 0.3 : 1.6)) : Math.exp(-(age - len) / 0.12) * Math.exp(-len * 1.6));
            if (amp < 0.02) continue;
            const f = hz(ev.note);
            for (let h = 1; h <= 4; h++) bump(f * h, 1.4, amp / (h * h * 0.8 + 0.2));
            tones.push({ f: f, a: amp });
            if (amp > loudest) { loudest = amp; loudHz = f; }
          }
        }
      });
    }
    /* A soft pulse on every beat so a sparse pattern still breathes with the tempo. */
    const part = partAt(room, bar), beatMs = 60000 / part.tempo;
    const intoBeat = (sNow - P.barTime(room, bar)) % beatMs / 1000;
    bump(70, 4, 0.25 * Math.exp(-intoBeat / 0.15));
  } else {
    /* Band stopped: a slow shared drift so the screens stay alive and move together. */
    const breath = 0.18 + 0.12 * Math.sin(tNow * 0.9);
    bump(80 + 40 * Math.sin(tNow * 0.3), 6, breath);
    bump(440 + 200 * Math.sin(tNow * 0.21), 10, breath * 0.6);
    tones.push({ f: 110 + 30 * Math.sin(tNow * 0.3), a: breath });
  }
  for (let i = 0; i < N; i++) {
    const floor = 0.04 * Math.exp(-i / 260) + 0.015 * Math.random();
    const v = Math.min(1, acc[i] + floor);
    freqData[i] = Math.round(freqData[i] * 0.55 + v * 255 * 0.45);
  }
  for (let i = 0; i < N; i++) {
    const t = tNow + i / SR;
    let v = 0;
    for (let k = 0; k < tones.length; k++) v += tones[k].a * Math.sin(2 * Math.PI * tones[k].f * t);
    v = v * 0.45 + (Math.random() * 2 - 1) * Math.min(0.5, noise);
    timeData[i] = Math.max(0, Math.min(255, Math.round(128 + v * 100)));
  }
  return loudHz;
}

/* ---------- replacing the frame functions ---------- */
const origAnalyze = analyzeFrame, origCurrentT = currentT, origUpdateTime = updateTime, origLoad = loadFile;

currentT = function(){ return bandFrame ? clock.now() / 1000 : origCurrentT(); };

updateTime = function(t){
  if (!ready()) { origUpdateTime(t); return; }
  if (room.playing) {
    const now = clock.now(), bar = P.barAt(room, now), part = partAt(room, bar);
    const beat = Math.floor((now - P.barTime(room, bar)) / (60000 / part.tempo)) + 1;
    document.getElementById("timeDisplay").textContent = "BAR " + (bar + 1) + "." + beat;
    document.getElementById("progressFill").style.width = (beat / 4 * 100) + "%";
  } else {
    document.getElementById("timeDisplay").textContent = "BAND STOPPED";
    document.getElementById("progressFill").style.width = "0%";
  }
};

analyzeFrame = function(){
  if (!ready()) { bandFrame = false; if (analyser && analyser !== FAKE) origAnalyze(); return; }
  if (!freqData || freqData.length !== N) { freqData = new Uint8Array(N); timeData = new Uint8Array(N); }
  bufLen = N;
  const loudHz = fill();
  const real = analyser;
  analyser = FAKE;
  bandFrame = true;
  try { origAnalyze(); } finally { analyser = real || FAKE; bandFrame = false; }
  if (loudHz) { dominantStep = freqToEdo(loudHz); document.getElementById("sNote").textContent = SHORT[dominantStep] + "(" + dominantStep + ")"; }
  if (room.playing) { bpmEst = partAt(room, P.barAt(room, clock.now())).tempo; document.getElementById("sBpm").textContent = bpmEst; }
};

/* The real analyser is only built when no analyser exists, so the stand in is cleared before a file loads. */
loadFile = function(file){
  if (analyser === FAKE) analyser = null;
  return origLoad(file);
};

/* ---------- room code ---------- */
const roomEl = document.getElementById("band-room");
roomEl.value = sync.room;
roomEl.addEventListener("change", function(){ roomEl.value = sync.setRoom(roomEl.value); });
roomEl.addEventListener("keydown", function(e){ if (e.key === "Enter") roomEl.blur(); });
setInterval(kick, 1000);
sync.connect();
render();
})();
