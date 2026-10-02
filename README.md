# GRNLR_2002 — GitHub Pages Build

A browser-first standalone granular audio instrument. Drop in an MP3/WAV/FLAC/OGG file and process it locally in your browser. No server, API, cloud upload, Electron, or install is required.

## Features

- Drag/drop or load an audio file
- Large waveform display with position scanning
- HOLD / STEP / KEYS modes
- 8 or 16 slice cells
- Granular rate, grain length, position, stereo space, chaos, tune, and output
- Grain envelopes: Hann, Gaussian, Triangle, Square
- Spray, pitch jitter, reverse probability, stutter probability, crush, and reverb/air
- Micro Stutter, Reverse Lock, and Randomize controls
- Y2K/digital sound-design presets
- Live output recording
- All audio processing stays local in the browser

## Test it locally

You can open `index.html` directly, but serving the folder locally is more reliable for browser audio features.

### Python

```bash
python -m http.server 8080
```

Then visit:

```text
http://localhost:8080
```

## Publish with GitHub Pages

1. Create a new GitHub repository, for example `GRNLR_2002`.
2. Upload the contents of this folder to the repository root:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `README.md`
   - `.nojekyll`
3. Commit the files.
4. On GitHub, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select your main branch and `/ (root)`.
7. Save.
8. GitHub Pages will serve the app from your repository's Pages URL.

## Important

This build is intentionally browser-first. There is no Electron setup, `package.json`, `node_modules`, desktop installer, or backend. The same core app can be wrapped as a Windows desktop app later without changing the project direction.
