
import React, { useEffect, useRef, useState } from "react";

export default function App() {
  return <SynthLab />;
}

// SynthLab: low-latency Web Audio + Web MIDI playground
// - Uses AudioWorklet for reliable scheduling and minimal jitter
// - Polyphonic (8 voices), ADSR, basic waveforms, low-pass filter
// - MIDI input + computer keyboard mapping
function SynthLab() {
  const audioCtxRef = useRef(null);
  const workletNodeRef = useRef(null);
  const filterRef = useRef(null);
  const gainRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [waveform, setWaveform] = useState("saw");
  const [voices, setVoices] = useState(8);
  const [adsr, setADSR] = useState({ attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 });
  const [filter, setFilter] = useState({ cutoff: 12000, q: 0.7 });
  const [master, setMaster] = useState(0.6);
  const midiAccessRef = useRef(null);

  // --- Computer keyboard mapping (QWERTY): row starting at 'a' -> white keys
  const keyToNote = {
    a: 60, s: 62, d: 64, f: 65, g: 67, h: 69, j: 71, k: 72, l: 74,
    w: 61, e: 63, t: 66, y: 68, u: 70, o: 73, p: 75,
  };

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // Create AudioWorklet from inline processor source
  async function ensureWorklet(ctx) {
    if (workletNodeRef.current) return;
    const processorCode = `
      class Voice {
        constructor() {
          this.active = false;
          this.note = -1;
          this.freq = 0.0;
          this.phase = 0.0;
          this.env = 0.0;
          this.gate = false;
          this.a = 0.01; this.d = 0.1; this.s = 0.7; this.r = 0.2;
          this.wave = 'saw';
        }
      }

      class SynthProcessor extends AudioWorkletProcessor {
        static get parameterDescriptors() { return []; }
        constructor() {
          super();
          this.sampleRate = sampleRate;
          this.voices = Array.from({length: 32}, () => new Voice());
          this.maxVoices = 8;
          this.master = 0.6;
          this.filterCutoff = 12000;
          this.filterQ = 0.7;
          this.wave = 'saw';

          this.lp_z = 0.0;
          this.lp_a = 0.0;

          this.port.onmessage = (e) => {
            const msg = e.data;
            switch (msg.type) {
              case 'setParams': {
                const { attack, decay, sustain, release, waveform, voices, master, cutoff, q } = msg;
                this.wave = waveform ?? this.wave;
                this.maxVoices = Math.max(1, Math.min(32, voices ?? this.maxVoices));
                this.master = Math.max(0, Math.min(1, master ?? this.master));
                this.filterCutoff = Math.max(50, Math.min(20000, cutoff ?? this.filterCutoff));
                this.filterQ = Math.max(0.0001, Math.min(20, q ?? this.filterQ));
                for (let v of this.voices) {
                  v.a = (attack ?? v.a) || v.a;
                  v.d = (decay ?? v.d) || v.d;
                  v.s = (sustain ?? v.s) || v.s;
                  v.r = (release ?? v.r) || v.r;
                  v.wave = this.wave;
                }
                break;
              }
              case 'noteOn': {
                this.noteOn(msg.note, msg.velocity ?? 1.0);
                break;
              }
              case 'noteOff': {
                this.noteOff(msg.note);
                break;
              }
              case 'allNotesOff': {
                for (let v of this.voices) { v.gate = false; }
                break;
              }
            }
          };
        }

        midiToFreq(note) { return 440 * Math.pow(2, (note - 69) / 12); }

        noteOn(note, velocity) {
          for (let v of this.voices) {
            if (v.active && v.note === note) { v.gate = true; return; }
          }
          let v = this.voices.find(v => !v.active || (!v.gate && v.env < 0.001));
          if (!v) v = this.voices[0];
          v.active = true;
          v.gate = true;
          v.note = note;
          v.freq = this.midiToFreq(note);
          if (v.env < 0.0001) v.phase = 0.0;
        }

        noteOff(note) {
          for (let v of this.voices) {
            if (v.active && v.note === note) { v.gate = false; }
          }
        }

        polyBLEP(t, dt) {
          if (t < dt) { const x = t/dt; return x + x - x*x - 1.0; }
          if (t > 1.0 - dt) { const x = (t - 1.0)/dt; return x*x + x + x + 1.0; }
          return 0.0;
        }

        process(inputs, outputs) {
          const output = outputs[0];
          const ch0 = output[0];
          const dt = 1 / this.sampleRate;

          const wc = 2 * Math.PI * Math.min(this.filterCutoff, this.sampleRate * 0.45);
          const alpha = wc * dt;
          const a = alpha / (1 + alpha);
          this.lp_a = a;

          for (let i = 0; i < ch0.length; i++) {
            let s = 0.0;
            let activeCount = 0;
            for (let v of this.voices) {
              if (!v.active) continue;
              v.phase += v.freq * dt;
              if (v.phase >= 1.0) v.phase -= 1.0;

              let sample = 0.0;
              if (v.wave === 'sine') {
                sample = Math.sin(2*Math.PI*v.phase);
              } else if (v.wave === 'square') {
                let t = v.phase;
                let val = (t < 0.5 ? 1 : -1);
                val += this.polyBLEP(t, v.freq*dt) - this.polyBLEP((t+0.5)%1, v.freq*dt);
                sample = val;
              } else { // saw
                let t = v.phase;
                let val = 2*t - 1;
                val -= this.polyBLEP(t, v.freq*dt);
                sample = val;
              }

              if (v.gate) {
                if (v.env < 1.0) v.env += Math.max(1e-6, dt / Math.max(1e-5, v.a));
                v.env = Math.min(v.env, 1.0);
                if (v.env > v.s) v.env += (v.s - v.env) * Math.max(1e-6, dt / Math.max(1e-5, v.d));
              } else {
                v.env += (0.0 - v.env) * Math.max(1e-6, dt / Math.max(1e-5, v.r));
                if (v.env < 1e-4) { v.env = 0.0; v.active = false; }
              }

              s += sample * v.env;
              activeCount++;
              if (activeCount >= this.maxVoices) break;
            }

            s *= this.master * 0.2;
            this.lp_z = this.lp_z + this.lp_a * (s - this.lp_z);
            ch0[i] = this.lp_z;
            if (output.length > 1) output[1][i] = ch0[i];
          }
          return true;
        }
      }

      registerProcessor('synth-processor', SynthProcessor);
    `;

    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'synth-processor', { numberOfOutputs: 1, outputChannelCount: [2] });
    workletNodeRef.current = node;
  }

  async function initAudio() {
    if (audioCtxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });
    audioCtxRef.current = ctx;

    await ensureWorklet(ctx);

    const filterNode = ctx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = filter.cutoff ?? 12000;
    filterNode.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = master;

    workletNodeRef.current.connect(filterNode);
    filterNode.connect(gain);
    gain.connect(ctx.destination);

    filterRef.current = filterNode;
    gainRef.current = gain;

    postParams();
    setIsReady(true);
  }

  function postParams() {
    const node = workletNodeRef.current;
    if (!node) return;
    node.port.postMessage({
      type: 'setParams',
      attack: adsr.attack,
      decay: adsr.decay,
      sustain: adsr.sustain,
      release: adsr.release,
      waveform,
      voices,
      master,
      cutoff: filter.cutoff,
      q: filter.q,
    });
    if (filterRef.current) {
      filterRef.current.frequency.value = filter.cutoff;
      filterRef.current.Q.value = filter.q;
    }
    if (gainRef.current) gainRef.current.gain.value = master;
  }

  useEffect(() => { if (isReady) postParams(); }, [adsr, waveform, voices, master, filter, isReady]);

  // Keyboard handling
  useEffect(() => {
    const down = new Set();
    function onKeyDown(e) {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key in keyToNote) {
        down.add(key);
        noteOn(keyToNote[key]);
      }
      if (key === 'z') transpose(-12);
      if (key === 'x') transpose(12);
    }
    function onKeyUp(e) {
      const key = e.key.toLowerCase();
      if (down.has(key)) {
        down.delete(key);
        noteOff(keyToNote[key]);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // MIDI setup
  async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI not supported');
      setMidiEnabled(false);
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      midiAccessRef.current = access;
      access.inputs.forEach((input) => {
        input.onmidimessage = onMIDIMessage;
      });
      access.onstatechange = () => {
        access.inputs.forEach((input) => (input.onmidimessage = onMIDIMessage));
      };
      setMidiEnabled(true);
    } catch (e) {
      console.error('MIDI init failed', e);
      setMidiEnabled(false);
    }
  }

  function onMIDIMessage(e) {
    const [status, data1, data2] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && data2 > 0) {
      noteOn(data1, data2 / 127);
    } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
      noteOff(data1);
    } else if (cmd === 0xE0) {
      // pitch bend TODO
    }
  }

  const transposeRef = useRef(0);
  function transpose(semi) {
    transposeRef.current = clamp(transposeRef.current + semi, -24, 24);
  }

  function noteOn(note, velocity = 1.0) {
    if (!workletNodeRef.current) return;
    const n = note + transposeRef.current;
    workletNodeRef.current.port.postMessage({ type: 'noteOn', note: n, velocity });
  }
  function noteOff(note) {
    if (!workletNodeRef.current) return;
    const n = note + transposeRef.current;
    workletNodeRef.current.port.postMessage({ type: 'noteOff', note: n });
  }

  async function handleStart() {
    await initAudio();
    await audioCtxRef.current.resume();
    setIsRunning(true);
  }
  async function handleStop() {
    if (!audioCtxRef.current) return;
    workletNodeRef.current?.port.postMessage({ type: 'allNotesOff' });
    await audioCtxRef.current.suspend();
    setIsRunning(false);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Synth Lab</h1>
          <div className="flex gap-2">
            {!isRunning ? (
              <button onClick={handleStart} className="px-4 py-2 rounded-2xl bg-emerald-500 hover:bg-emerald-600 shadow">
                Power On
              </button>
            ) : (
              <button onClick={handleStop} className="px-4 py-2 rounded-2xl bg-rose-500 hover:bg-rose-600 shadow">
                Power Off
              </button>
            )}
            <button onClick={initMIDI} className={`px-4 py-2 rounded-2xl shadow ${midiEnabled ? 'bg-indigo-600' : 'bg-indigo-500 hover:bg-indigo-600'}`}>
              {midiEnabled ? 'MIDI Ready' : 'Enable MIDI'}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <section className="md:col-span-1 p-4 rounded-2xl bg-slate-900 shadow">
            <h2 className="text-lg font-medium mb-3">Oscillator</h2>
            <div className="flex items-center gap-3 mb-3">
              {['sine','saw','square'].map(w => (
                <button key={w} onClick={() => setWaveform(w)} className={`px-3 py-1 rounded-xl border ${waveform===w?'bg-slate-100 text-slate-900 border-slate-100':'border-slate-700'}`}>{w}</button>
              ))}
            </div>
            <label className="block text-sm mb-1">Voices: {voices}</label>
            <input type="range" min={1} max={32} value={voices} onChange={e=>setVoices(parseInt(e.target.value))} className="w-full" />
          </section>

          <section className="md:col-span-1 p-4 rounded-2xl bg-slate-900 shadow">
            <h2 className="text-lg font-medium mb-3">ADSR Envelope</h2>
            {(['attack','decay','sustain','release']).map((k) => (
              <div key={k} className="mb-3">
                <label className="block text-sm mb-1 capitalize">{k}: {k==='sustain' ? adsr[k].toFixed(2) : adsr[k].toFixed(3)}{k==='sustain'?'':'s'}</label>
                <input
                  type="range"
                  min={k==='sustain'?0:0.001}
                  max={k==='sustain'?1:2}
                  step={k==='sustain'?0.01:0.001}
                  value={adsr[k]}
                  onChange={(e)=> setADSR(prev => ({...prev, [k]: parseFloat(e.target.value)}))}
                  className="w-full"
                />
              </div>
            ))}
          </section>

          <section className="md:col-span-1 p-4 rounded-2xl bg-slate-900 shadow">
            <h2 className="text-lg font-medium mb-3">Filter & Master</h2>
            <div className="mb-3">
              <label className="block text-sm mb-1">Cutoff: {Math.round(filter.cutoff)} Hz</label>
              <input type="range" min={50} max={20000} value={filter.cutoff} onChange={(e)=> setFilter(prev=>({...prev, cutoff: parseFloat(e.target.value)}))} className="w-full" />
            </div>
            <div className="mb-3">
              <label className="block text-sm mb-1">Resonance (Q): {filter.q.toFixed(2)}</label>
              <input type="range" min={0.1} max={20} step={0.1} value={filter.q} onChange={(e)=> setFilter(prev=>({...prev, q: parseFloat(e.target.value)}))} className="w-full" />
            </div>
            <div>
              <label className="block text-sm mb-1">Master: {master.toFixed(2)}</label>
              <input type="range" min={0} max={1} step={0.01} value={master} onChange={(e)=> setMaster(parseFloat(e.target.value))} className="w-full" />
            </div>
          </section>
        </div>

        <section className="mt-6 p-4 rounded-2xl bg-slate-900 shadow">
          <h2 className="text-lg font-medium mb-2">How to play</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm text-slate-300">
            <li>Click <span className="text-slate-100 font-medium">Power On</span> once to unlock audio (browser gesture requirement).</li>
            <li>Enable Web MIDI and play a connected controller, or use your keyboard: <code className="px-1 bg-slate-800 rounded">A S D F G H J K L</code> for white keys, sharps on <code className="px-1 bg-slate-800 rounded">W E T Y U O P</code>.</li>
            <li>Transpose with <code className="px-1 bg-slate-800 rounded">Z</code>/<code className="px-1 bg-slate-800 rounded">X</code> (-12/+12 semitones).</li>
          </ul>
        </section>

        <footer className="mt-6 text-xs text-slate-400">
          Built with Web Audio (AudioWorklet) for low-latency. Tip: keep your CPU performance mode on for best results.
        </footer>
      </div>
    </div>
  );
}
