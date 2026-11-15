"""Item 4: face detector session as shipped (CPU EP, default spin) vs no-spin vs
fewer threads: wall ms/img and process CPU s/img over N thumbnails.
usage: face_spin.py <db> <thumbs> <n>"""

import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv

benv.setup(sys.argv[1], sys.argv[2])
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image  # noqa: E402
from moire.services.ai import face_detect as fd  # noqa: E402

# The face model as the app downloads it; FACE_MODEL overrides the path.
M = os.environ.get("FACE_MODEL") or str(
    benv.BENCH / "models/deepghs_anime_face_detection/face_detect_v1.4_n/model.onnx"
)
keys = [
    r[0]
    for r in sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).execute(
        "select thumb_key from images where thumb_key is not null order by mtime desc limit ?",
        (int(sys.argv[3]),),
    )
]
from moire.services.library import storage_fs  # noqa: E402

xs = []
for k in keys:
    with Image.open(storage_fs.thumb_path(k)) as img:
        img = img.convert("RGB")
        w, h = img.size
        _, nw, nh, px, py = fd.letterbox(w, h)
        c = Image.new("RGB", (640, 640), (114, 114, 114))
        c.paste(img.resize((nw, nh)), (px, py))
    xs.append(np.asarray(c, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0)


def run(label, **cfg):
    o = ort.SessionOptions()
    if cfg.get("nospin"):
        o.add_session_config_entry("session.intra_op.allow_spinning", "0")
        o.add_session_config_entry("session.inter_op.allow_spinning", "0")
    if cfg.get("threads"):
        o.intra_op_num_threads = cfg["threads"]
    s = ort.InferenceSession(M, sess_options=o, providers=["CPUExecutionProvider"])
    n = s.get_inputs()[0].name
    s.run(None, {n: xs[0]})
    c0, t0 = benv.proc_cpu(), time.perf_counter()
    for x in xs:
        s.run(None, {n: x})
    dt, dc = time.perf_counter() - t0, benv.proc_cpu() - c0
    print(
        label,
        {
            "ms_per_img": round(dt * 1000 / len(xs), 1),
            "cpu_s_per_img": round(dc / len(xs), 3),
            "cores": round(dc / dt, 1),
        },
    )


run("shipped(default spin, all threads)")
run("nospin", nospin=True)
run("nospin+4threads", nospin=True, threads=4)
run("nospin+2threads", nospin=True, threads=2)
