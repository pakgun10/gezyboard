import { UPLOAD_DIR_PATH } from "./db";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB, sesuai rancangan
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export async function saveUpload(file: File): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!file || typeof file.size !== "number") return { ok: false, error: "Tidak ada file." };
  if (file.size === 0) return { ok: false, error: "File kosong." };
  if (file.size > MAX_BYTES) return { ok: false, error: "Ukuran file melebihi 5 MB." };
  const ext = EXT_BY_MIME[file.type];
  if (!ext) return { ok: false, error: "Hanya file gambar yang boleh diunggah (JPG/PNG/GIF/WebP/SVG)." };
  const name = crypto.randomUUID().replace(/-/g, "") + ext;
  await Bun.write(UPLOAD_DIR_PATH + "/" + name, file);
  return { ok: true, url: "/uploads/" + name };
}
