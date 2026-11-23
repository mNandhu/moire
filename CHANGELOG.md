# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-11-23

The first public release. Moiré is a local gallery and ComfyUI studio for AI art. Point it at your output folders and it reads each image's prompt and settings, tags it with a local AI tagger and works out which characters and outfits are in it. With a ComfyUI connected, you can generate straight from your library. Moiré runs on your machine as one process with an embedded database, and it uploads nothing.

Install it with `uv tool install --python 3.12 "moire-gallery[cpu]"` (or `[gpu]` for an NVIDIA GPU), then run `moire run --open`. Docker works too; see the README.

### Added

- A virtualized masonry gallery that stays smooth with tens of thousands of images, sorted newest first, oldest first or by rating. Moiré watches your libraries and picks up new images by itself, and it can split a folder into one library per subfolder.
- Moiré reads the prompt, negative prompt, seed, sampler, checkpoint and LoRAs from ComfyUI and Automatic1111 PNGs, prompt weights like `(tag:1.2)` included, and every prompt term becomes a tag you can search. When a custom ComfyUI workflow's fields don't come through, you can map them by hand on the Rules page.
- A built-in WD tagger (ONNX, on the CPU or an NVIDIA GPU) adds tags and a content rating, with no cloud service involved. The model is about 380 MB and downloads from Hugging Face the first time. The AI Tagging page tags a whole backlog and estimates how long that will take, and auto-tag can tag new images as they arrive. In the viewer, the Tags tab shows what the prompt asked for next to what the tagger saw.
- Characters come from the tagger's list. Each one gets a page with their face, look, best images, outfits and a recipe for generating them again. You can save an outfit for one character or share it between them.
- You can filter by tags (match all or any), characters, outfits, LoRAs, embeddings, rating, stars and library. `Ctrl+K` searches all of it, image file names included.
- Rate images 1 to 5 stars, quarantine them without deleting, add your own tags, and select and edit in bulk.
- Generate works with a ComfyUI that is local, remote or behind a proxy. Pick characters and outfits, write the scene and queue it. Tags by part sorts the prompt into subject, hair, eyes, attire, pose and so on, flags tags that appear twice and suggests tags for each part. `Ctrl+Up`/`Ctrl+Down` change a tag's weight, `Ctrl+Enter` queues and `Ctrl+Z` undoes. You can use the built-in workflow or your own, from an exported workflow file or an image it made, and Remix starts from any image's prompt and settings.
- A sensitivity filter hides images and tags above the content level you pick, everywhere in the app. The server enforces it.
- It works on a phone over your LAN (`moire run --host 0.0.0.0`).
- Once a day Moiré asks PyPI whether a newer version is out. When one is, the sidebar and the terminal say "Update available" and show the upgrade command. The check sends nothing about your computer or your images. Turn it off under Settings > About, or for good with `UPDATE_CHECK=false`.
- `moire paths` shows where the database, thumbnails, tagger models and logs live. For an installed copy that's the OS app-data folder, unless `MOIRE_HOME` points somewhere else.

### Changed

- If you ran a pre-release Tagify checkout: the project is now Moiré. The database defaults to `moire.db`, environment variables are `MOIRE_*` (they were `TAGIFY_*`) and the Docker volume is `moire_data`. Nothing migrates on its own, so rename your `tagify.db` (with its `-wal` and `-shm` files) to `moire.db` by hand.

[Unreleased]: https://github.com/mNandhu/moire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mNandhu/moire/releases/tag/v0.1.0
