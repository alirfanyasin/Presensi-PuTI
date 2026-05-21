# Presensi PuTI

Aplikasi pencatatan presensi karyawan PuTI menggunakan Express.js dan database MySQL.

## Persyaratan
- Node.js (v14 atau lebih baru)
- MySQL / MariaDB (misalnya dari Laragon, XAMPP, atau instalasi standalone)

## Instalasi & Setup

1. **Install dependensi:**
   ```bash
   npm install
   ```

2. **Konfigurasi Database:**
   Salin file `.env.example` menjadi `.env` dan sesuaikan detail koneksi MySQL Anda:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=
   DB_DATABASE=nama_database
   DB_PORT=3306
   ```

3. **Migrasi Data (Opsional / Satu Kali):**
   *Catatan: Jika Anda meng-upgrade dari SQLite, jalankan perintah ini sekali untuk memindahkan semua data lama Anda dari `presensi.db` ke database MySQL:*
   ```bash
   node migrate.js
   ```

4. **Seed Data Awal:**
   Gunakan perintah ini untuk menyinkronkan data default karyawan:
   ```bash
   npm run seed
   ```

5. **Jalankan Aplikasi:**
   ```bash
   npm run start
   ```
   Aplikasi akan berjalan di `http://localhost:3000`.

## Backup
Gunakan perintah berikut untuk mem-backup data presensi (akan menghasilkan dump MySQL `.sql` dan mencadangkan folder file unggahan):
```bash
npm run backup
```
Hasil backup akan disimpan secara teratur di dalam folder `backup/`.
