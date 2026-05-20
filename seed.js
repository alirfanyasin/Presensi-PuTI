const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "presensi.db");
const db = new sqlite3.Database(dbPath);

const defaultKaryawan = [
  "Irfan Yasin",
  "Amoure Chelsytrivia Daniella Purba",
  "Reza Eka Firmansyah",
];

db.serialize(() => {
  db.run("BEGIN TRANSACTION");

  // Hapus nama karyawan lama yang tidak ada di dalam daftar defaultKaryawan
  const placeholders = defaultKaryawan.map(() => "?").join(",");
  db.run(
    `DELETE FROM karyawan WHERE nama NOT IN (${placeholders})`,
    defaultKaryawan,
  );

  const stmt = db.prepare(
    "INSERT INTO karyawan (nama) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM karyawan WHERE nama = ?)",
  );
  defaultKaryawan.forEach((nama) => {
    stmt.run(nama, nama);
  });
  stmt.finalize();

  db.run("COMMIT", (err) => {
    if (err) {
      console.error("Error seeding data:", err);
    } else {
      console.log(
        "Seed karyawan berhasil disinkronisasi: " + defaultKaryawan.join(", "),
      );
    }
    db.close();
  });
});
