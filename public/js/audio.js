/** Tiny WebAudio synth for stamps and fanfares. No assets, off by default, created on first use. */
export function createAudio() {
  let context = null;
  let enabled = false;

  function ensure() {
    if (!enabled) return null;
    if (!context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === 'suspended') context.resume();
    return context;
  }

  function route(node, pan) {
    if (context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner);
      panner.connect(context.destination);
    } else node.connect(context.destination);
  }

  function tone({ freq, to, dur, type = 'sine', gain = 0.06, pan = 0, delay = 0 }) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp);
    route(amp, pan);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise({ dur, gain = 0.03, pan = 0 }) {
    const c = ensure();
    if (!c) return;
    const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = c.createBufferSource();
    const amp = c.createGain();
    amp.gain.value = gain;
    source.buffer = buffer;
    source.connect(amp);
    route(amp, pan);
    source.start();
  }

  const panFor = (deskIndex) => (deskIndex - 1) * 0.7;

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = value;
      if (value) ensure();
    },
    stamp(deskIndex, decision) {
      const pan = panFor(deskIndex);
      tone({ freq: 150, to: 55, dur: 0.1, gain: 0.09, pan });
      noise({ dur: 0.035, gain: 0.035, pan });
      if (decision === 'approve') tone({ freq: 880 + deskIndex * 110, dur: 0.05, type: 'square', gain: 0.012, pan });
      else tone({ freq: 210, to: 150, dur: 0.07, type: 'sawtooth', gain: 0.02, pan });
    },
    error(deskIndex) {
      tone({ freq: 110, to: 80, dur: 0.25, type: 'sawtooth', gain: 0.04, pan: panFor(deskIndex) });
    },
    fanfare(rank, deskIndex) {
      const notes = [523.25, 659.25, 783.99, 1046.5].slice(0, rank === 1 ? 4 : rank === 2 ? 3 : 2);
      notes.forEach((freq, i) => tone({ freq, dur: 0.18, type: 'triangle', gain: 0.05, pan: panFor(deskIndex), delay: i * 0.1 }));
    },
  };
}
