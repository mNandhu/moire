# Moiré

**A local gallery for your AI art: browse it, tag it, find it, and make more of it.**

Point Moiré at the folders your ComfyUI or Automatic1111 output lands in. It reads every image's prompt and settings, tags it with a local AI tagger, works out which characters and outfits are in it, and gives you a fast gallery to sort through thousands of generations. Hook it up to ComfyUI and you can generate straight from your library.

Everything runs on your machine: one process, one port, an embedded database. Nothing is uploaded anywhere.

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/python-3.11%2B-blue)

![The gallery, sorted by your own star ratings](docs/images/gallery.webp)

## What it does

- **Reads your generations.** Prompt, negative prompt, seed, sampler, checkpoint and LoRAs come straight out of ComfyUI and A1111 PNGs. Prompt weights like `(foreshortening:1.2)` are kept, and every prompt term becomes a searchable tag.
- **Tags them for you.** A built-in WD tagger (ONNX, CPU or NVIDIA GPU) adds AI tags and a content rating. No cloud service, no API key.
- **Knows your characters.** Moiré spots characters from the tagger's list, gives each one a page with their face, look, best images and the outfits they wear, and remembers a recipe for generating them again.
- **Finds anything.** Filter by tags with AND/OR, characters, outfits, LoRAs, embeddings, rating, stars or library. `Ctrl+K` searches everything.
- **Lets you curate.** Rate 1 to 5 stars, quarantine without deleting, tag by hand, select in bulk.
- **Generates.** Connect a ComfyUI, pick characters and outfits, write the scene, and queue. Use the built-in workflow or set up your own from an exported workflow file or any image it made. Remix any image from the viewer.
- **Stays fast.** A virtualized masonry grid and keyset paging keep scrolling smooth in libraries of tens of thousands of images. Libraries are watched, so new images show up on their own.
- **Works on your phone.** Run it on your LAN and browse from the couch.

## Screenshots

| | |
|---|---|
| ![Image viewer](docs/images/viewer.webp) | ![Character page](docs/images/character.webp) |
| **The viewer**: characters, outfit, rating, the full generation data, Remix | **A character page**: look, best of, outfits, generation recipe |
| ![Generate](docs/images/generate.webp) | ![Tags](docs/images/tags.webp) |
| **Generate**: characters and outfits as layers, then your scene | **Tags**: characters first, every tag with a cover |
| ![Outfits](docs/images/outfits.webp) | ![Generations](docs/images/generations.webp) |
| **Outfits** saved per character, reusable in Generate | **Generations**: every batch you queued |

![Moiré on a phone](docs/images/phone.webp)

The images in these screenshots were made with Moiré's own Generate page.

## Install

You need [uv](https://docs.astral.sh/uv/getting-started/installation/). It brings its own Python.

```bash
uv tool install "moire-studio[cpu]"   # or "moire-studio[gpu]" for tagging on an NVIDIA GPU
moire run --open                       # opens http://localhost:8000
```

> [!NOTE]
> Moiré isn't on PyPI yet. Until the first release, run it from a source checkout: see [CONTRIBUTING.md](CONTRIBUTING.md#setup), or use Docker below.

That's the whole app: the API and the UI on one port. To reach it from other devices on your network, use `moire run --host 0.0.0.0`.

The GPU build (Linux and Windows) pulls the CUDA and cuDNN runtime from pip, about 2 GB, and needs only the NVIDIA driver. Tagging is roughly 9x faster than on the CPU.

### Docker

```bash
git clone https://github.com/mNandhu/moire.git
cd moire
docker compose up --build              # UI on http://localhost:5173
```

Moiré can only see folders mounted into the container. Add yours in `docker-compose.override.yml`, then add the library in the UI by its path inside the container:

```yaml
services:
  backend:
    volumes:
      - /absolute/path/to/your/images:/mnt/images:ro
```

[docs/docker-guide.md](docs/docker-guide.md) covers the data volume, logs and settings.

## First run

The welcome screen walks you through three steps, and you can skip any of them:

1. **Folders.** Add the folders your images are in. Tick "each subfolder becomes its own library" to split a big output folder. Moiré previews what it will add, then scans in the background.
2. **AI tagging.** Download the tagger model (about 380 MB, from Hugging Face, once) and tag what you have. Later, the AI Tagging page tags whatever is still untagged in one click.
3. **ComfyUI.** Give it your ComfyUI address (`127.0.0.1:8188`). Generate shows up in the sidebar once it connects.

Change any of it later in Settings.

## Generating with ComfyUI

Moiré talks to ComfyUI over its normal API, so any ComfyUI works: on this machine, on another box, or behind a reverse proxy.

- **Address**, plus a certificate path for a self-signed HTTPS setup and extra headers (for example an `Authorization` token) if your ComfyUI needs them.
- **Output folder**: where ComfyUI saves. If Moiré can read that folder, new images are linked where they are. If it can't (a remote ComfyUI), turn on "Download images from ComfyUI" and they are downloaded into a library instead.
- **Workflows**: the built-in one is ComfyUI's default text-to-image graph with your checkpoint. To use your own, pick an image it made or upload an *Export (API)* file; Moiré finds the prompt, seed, size and sampler inputs, and you run a test image before it's ready.

Characters you pick in Generate bring their recipe (the tags that make them look right) and the outfit you choose. Prefixes, negative prompts and style LoRAs can be saved as presets.

## Where your data lives

```bash
moire paths
```

prints the database, thumbnails, tagger models and logs. An installed Moiré keeps them in your app-data folder:

| OS | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Moire` |
| macOS | `~/Library/Application Support/Moire` |
| Linux | `~/.local/share/moire` |

Set `MOIRE_HOME` to put them somewhere else. A `.env` file in that folder holds optional settings (see [`.env.example`](packages/backend/.env.example)).

Your images are never moved or changed. Moiré only reads them and writes thumbnails next to its database. Deleting an image from disk takes an explicit confirmation. Back up the database (`moire.db`); thumbnails can always be rebuilt by a rescan.

## Upgrading

```bash
uv tool upgrade moire-studio
```

The database updates itself on the next start; no migration step is needed. With Docker, `git pull` and `docker compose up --build`; the data volume carries over.

## Custom workflows and the Rules page

Moiré parses standard ComfyUI graphs on its own. A workflow with unusual nodes can leave the prompt or model empty. On the **Rules** page, pick that workflow, point each field at the node it comes from, check the preview, and save. Every image from that workflow, in every library, is re-read at once.

## Contributing

Setup, tests and the project layout are in [CONTRIBUTING.md](CONTRIBUTING.md). See [CHANGELOG.md](CHANGELOG.md) for what changed and [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT. See [LICENSE](LICENSE).
