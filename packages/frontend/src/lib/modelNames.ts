/** File name without folder or extension, as LoRAs show in the library. Mirrors
 *  the backend's `model_stem` (services/model_names.py); where a model object
 *  from the models endpoint is at hand, its `stem` field is the same value. */
export function stemOf(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "").trim();
}
