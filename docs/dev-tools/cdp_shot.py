import asyncio, base64, json, os, sys, urllib.request
import websockets

async def main(url, draft, out, clicks):
    tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json"))
    ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
    async with websockets.connect(ws_url, max_size=50_000_000) as ws:
        n = 0
        async def call(method, **params):
            nonlocal n; n += 1; my = n
            await ws.send(json.dumps({"id": my, "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == my: return m.get("result")
        await call("Emulation.setDeviceMetricsOverride", width=int(os.environ.get("SHOT_W", 1440)), height=int(os.environ.get("SHOT_H", 1300)), deviceScaleFactor=1, mobile=False)
        await call("Page.navigate", url=url)
        await asyncio.sleep(3)
        await call("Runtime.evaluate", expression=f"localStorage.setItem('moire.generate.draft', {json.dumps(draft)})")
        await call("Page.reload")
        await asyncio.sleep(6)
        for js in clicks:
            await call("Runtime.evaluate", expression=js)
            await asyncio.sleep(1.5)
        r = await call("Page.captureScreenshot", format="png")
        open(out, "wb").write(base64.b64decode(r["data"]))

asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]))
