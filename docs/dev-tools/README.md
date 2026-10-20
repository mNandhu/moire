# Dev tools for the Generate feature

Throwaway helpers used while building the ComfyUI integration. Not part of the app.

- `fake_comfy_server.py`: a fake ComfyUI (FastAPI) that writes small real PNGs.
  Run: `FAKE_COMFY_OUT=/tmp/x/out uv --directory packages/backend run uvicorn fake_comfy_server:app --port 8190 --app-dir docs/dev-tools`
- `cdp_shot.py`: screenshots a page through headless Chrome's DevTools protocol,
  after seeding the Generate draft in localStorage and running JS steps.
  Start Chrome: `google-chrome --headless=new --no-sandbox --remote-debugging-port=9333 --user-data-dir=/tmp/x/profile about:blank &`
  Run: `uv --directory packages/backend run python docs/dev-tools/cdp_shot.py <url> '<draft json>' out.png ["js step" ...]`
  Picker options react to `mousedown`, not `click`.

Sandbox (keeps the user's `pnpm dev` on 8000/5173 untouched):
- backend: `SQLITE_PATH=/tmp/x/t.db THUMB_ROOT=/tmp/x/thumbs uv run uvicorn src.main:app --port 8010` (no --reload: restart after backend edits)
- vite: copy `vite.config.ts` to a temp config with port 5180 and proxy target 127.0.0.1:8010, run `vite --config <it>`, delete it afterwards.
- PUT `/api/v1/generate/comfyui` with address `http://127.0.0.1:8190` and `output_path` = FAKE_COMFY_OUT, then POST the builtin test run.
- Stop servers by port (`ss -ltnp`), never `pkill -f` (it kills its own shell).
