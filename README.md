# Node Panel

Panel hosting Node.js ala Pterodactyl: server nyata (proses Node.js/Docker), file manager lengkap,
backup, admin, tunnel Cloudflare otomatis. Tanpa dependency (Node 24, `node:sqlite` bawaan).

## A. Jalankan di GitHub Actions (disarankan: repo PRIVATE)
1. Buat repo **private**, upload seluruh isi folder ini (termasuk folder `.github`).
2. Repo > Settings > Secrets and variables > Actions > New repository secret:
   - `ADMIN_USER` = admin
   - `ADMIN_PASS` = password admin lo
3. Tab Actions > **Panel** > Run workflow.
4. URL panel muncul di: (a) Issue bernama **Panel URL** (ada notifikasi GitHub ke HP),
   (b) Summary run, (c) log step "Jalankan panel".

Cara kerja:
- Satu run maksimal ~5 jam 35 menit, lalu otomatis menjalankan run berikutnya. Ada jeda sekitar 1-2 menit
  dan URL trycloudflare berubah (URL baru dikirim ke Issue).
- Data (database, file server, backup) disimpan ke Actions cache di akhir tiap run dan dipulihkan di run berikutnya.
  Kalau runner mati mendadak, perubahan sejak run mulai bisa hilang. Buat backup dan download berkala.
- Server user yang sedang menyala otomatis dinyalakan lagi setelah panel start.
- Mode Docker aktif di Actions (limit RAM/CPU nyata, pilih versi Node 18/20/22/24).
- Hentikan panel: Actions > run yang berjalan > Cancel (run berikutnya tidak dibuat).
- Password admin diambil dari Secret tiap run (ADMIN_RESET=1). Ganti password lewat Secret.

Batasan: runner gratis ~2 vCPU/7 GB (private) dan Actions bukan layanan hosting. Syarat layanan GitHub
membatasi pemakaian Actions untuk hosting/serverless, jadi anggap ini untuk pemakaian pribadi
dan ada risiko akun dibatasi.

## B. Jalankan biasa (VPS / hosting)
    cp .env.example .env   # isi ADMIN_USER / ADMIN_PASS
    node server.js
Mode Docker (isolasi + limit asli): `DOCKER=1 node server.js`. Docker Compose: `docker compose up -d --build`.

## Env
PORT (3000), DOCKER, TUNNEL=0 (matikan tunnel), CLOUDFLARED_BIN, PUBLIC_DOMAIN, MAX_USER_SERVERS (3),
MAX_UPLOAD_MB (500), DATA_DIR, ADMIN_USER, ADMIN_PASS, ADMIN_RESET=1.
