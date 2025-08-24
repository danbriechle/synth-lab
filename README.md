
# Synth Lab (Vite + React + Tailwind)

Low-latency browser synth using Web Audio AudioWorklet and optional Web MIDI.

## Quickstart
```bash
npm install
npm run dev
```

Then open the printed local URL. Click **Power On** to unlock audio. Click **Enable MIDI** if you have a controller.

## Notes
- Uses 48kHz sample rate and `latencyHint: 'interactive'` for snappy response.
- Audio must be unlocked by a user gesture (browser policy).
- Web MIDI requires a secure context (https or localhost) and a recent browser.
- Laptop power-saving can increase audio jitter—use a high-performance mode for best feel.
