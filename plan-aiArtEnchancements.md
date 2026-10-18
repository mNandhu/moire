## Plan: Moiré AI Art Enhancements

**TL;DR:** To serve AI Art creators better, Moiré needs to evolve from a generic, manual-tagging image gallery into a metadata-first, fast curation workspace. We will prioritize extracting embedded generation data (ComfyUI/A1111), adding rapid curation tools (rating/quarantine), and optimizing storage, making Moiré an indispensable companion to diffusion workflows.

**Evaluation of Current State:**
- **Pros:** Fast masonry gallery, background library scanning, simple manual tagging, isolated architecture (MinIO).
- **Cons:** Manual tagging is too tedious for thousands of generated images. Copying originals to MinIO doubles storage requirements (a dealbreaker for large AI collections). Hidden context (prompts, seeds, models embedded in images are ignored).

**Steps (Proposed Features)**

1. **Native Generation Metadata Parsing**
   - Extract `prompt`, `negative_prompt`, `seed`, `model`, and `workflow JSON` directly from PNG/WebP files during the background scan phase.
   - *Value:* Eliminates 90% of manual tagging. Makes the image's origin instantly visible.

2. **Advanced Search & Metadata Filters**
   - Implement filters for parameters like Model/Checkpoint, Dimensions, and full-text search across the extracted `prompt` and `negative_prompt`.
   - *Value:* Enables users to instantly find "all images made with SDXL where the prompt contains 'cyberpunk'".

3. **Curation Workflows (Rating & Quarantine)**
   - Add a fast 1-5 star rating system and a "quarantine/trash" toggle with dedicated keyboard shortcuts (`1-5`, `Del`, `X`).
   - *Value:* AI generates many throwaway outputs. Rapid triage is essential to surface golden generations.

4. **"Copy Workflow" / Remix Button**
   - Add a prominent action to copy the exact generation parameters or ComfyUI JSON to the clipboard from the Image View.
   - *Value:* Closes the loop between organizing an image and dropping its parameters back into a generator to remix it.

5. **Storage Optimization ("Thumbs-Only" Mode)**
   - Switch from mirroring all original images to MinIO (which doubles storage) to serving originals directly off the local disk/library path, storing only lightweight thumbnails in MinIO.
   - *Value:* Prevents storage bloat for users with massive (100GB+) image libraries.

6. **Image Grouping (Variations)**
   - Visually group or stack images that share the same prompt and timestamp (or consecutive seeds) in the gallery.
   - *Value:* Declutters the gallery view significantly when users generate large batches of the same subject.


**Verification**
1. Test scanning a folder of A1111/ComfyUI generated images and verify generation parameters are correctly extracted into MongoDB.
2. Verify that searching 'masterpiece' in the frontend returns images with that word in their embedded prompt.
3. Validate "Thumbs-only" mode prevents huge MinIO bucket growth.

**Further Considerations**
1. **Which specific diffusion UIs should we prioritize parsing first?** (Automatic1111 vs ComfyUI vs SwarmUI have different metadata schemas).
2. **Do we want to maintain the MinIO mirror approach for remote deployment**, or strictly pivot to local-only path mounting for originals?
