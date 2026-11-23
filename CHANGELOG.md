# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

The first public release. Moiré is a local gallery and ComfyUI studio for AI art: point it at your output folders and it reads every image's prompt and settings, tags it with a local AI tagger, works out the characters and outfits in it, and lets you generate from your library on your own ComfyUI. It runs on your machine as one process with an embedded database, and nothing is uploaded.

Install with `uv tool install --python 3.12 "moire-studio[cpu]"` (or `[gpu]` for an NVIDIA GPU), then `moire run --open`. Docker works too; see the README.

### Added

- Gallery: a virtualized masonry grid that stays smooth with tens of thousands of images, newest first, oldest first or top rated. Libraries are watched, so new images show up by themselves, and a folder can be split into one library per subfolder.
- Generation data: the prompt, negative prompt, seed, sampler, checkpoint and LoRAs are read from ComfyUI and Automatic1111 PNGs, prompt weights like `(tag:1.2)` included. Every prompt term becomes a searchable tag. The Rules page maps a custom ComfyUI workflow's fields by hand when they don't come through.
- AI tagging: a built-in WD tagger (ONNX, on the CPU or an NVIDIA GPU) adds tags and a content rating without a cloud service. The model, about 380 MB, downloads from Hugging Face the first time. The AI Tagging page tags a whole backlog with a time estimate, and auto-tag can tag new images as they arrive. The viewer's Tags tab sets what the prompt asked for beside what the tagger saw.
- Characters and outfits: characters are recognised from the tagger's list and get a page with their face, look, best images, outfits and a recipe for generating them again. Outfits are saved per character or shared.
- Search and filters: tags (match all or any), characters, outfits, LoRAs, embeddings, rating, stars and library, and `Ctrl+K` searches across all of it, image file names included.
- Curation: 1 to 5 star ratings, quarantine without deleting, manual tags, bulk select and edit.
- Generate: with a ComfyUI connected (local, remote or behind a proxy), pick characters and outfits, write the scene and queue. Tags by part sorts the prompt into subject, hair, eyes, attire, pose and so on, flags repeats and suggests tags for each part. `Ctrl+Up`/`Ctrl+Down` change a tag's weight, `Ctrl+Enter` queues and `Ctrl+Z` undoes. Use the built-in workflow or your own, from an exported workflow file or an image it made. Remix starts from any image's prompt and settings.
- Sensitivity filter: hide images and tags above a chosen content level everywhere in the app, enforced by the server.
- Works on a phone over your LAN (`moire run --host 0.0.0.0`).
- Update notice: once a day Moiré asks PyPI whether a newer version is out and shows "Update available" in the sidebar and the terminal, with the upgrade command. Turn it off under Settings > About, or for good with `UPDATE_CHECK=false`. Nothing about your computer or images is sent.
- `moire paths` shows where the database, thumbnails, tagger models and logs live: the OS app-data folder for an installed copy, or wherever `MOIRE_HOME` points.

### Changed

- For anyone running a pre-release Tagify checkout: the project is now Moiré. The database defaults to `moire.db`, environment variables are `MOIRE_*` (formerly `TAGIFY_*`) and the Docker volume is `moire_data`. Nothing is migrated for you: rename an existing `tagify.db` (with its `-wal`/`-shm` files) to `moire.db` by hand.

[Unreleased]: https://github.com/mNandhu/moire/commits/main
