# GezyBoard 📌

Papan kolaboratif ala Padlet — keluarga GezyTech App.
Stack: **Bun + Hono + bun:sqlite (WAL) + WebSocket native**, satu proses.

## Menjalankan (di VPS)

```bash
bun install
bun run scripts/create-user.ts <username> <password>   # buat pemilik (sekali saja)
PORT=3100 bun run src/index.ts
```

Lalu arahkan reverse proxy (mis. `board.gezytech.web.id`) ke `127.0.0.1:3100` + HTTPS.

## Cara pakai

1. Buka halaman utama → login sebagai pemilik → **＋ Papan baru**.
2. Salin **tautan berbagi** (`/b/<token>`) dan bagikan ke peserta.
3. Peserta membuka tautan (tanpa login), isi nama, klik **＋ Tempel kartu**.
4. Semua perubahan muncul real-time di semua layar (< 1 detik).

## Backup

Salin `data/gezyboard.db` (beserta `data/gezyboard.db-wal` bila ada) secara berkala.

## Batas Fase 1

Upload gambar maks 5 MB (JPG/PNG/GIF/WebP/SVG). Siapa pun pemegang tautan bisa
tambah/pindah/ubah/hapus kartu (moderasi menyusul di Fase 3).

© 2026 GezyTech App · Dikembangkan oleh PakGun · Dilarang menyalin/menduplikat kode tanpa izin tertulis.
