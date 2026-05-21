const db = require("./db");

const defaultKaryawan = [
  "Irfan Yasin",
  "Amoure Chelsytrivia Daniella Purba",
  "Reza Eka Firmansyah",
];

// Perform seeding
const runSeeding = async () => {
  try {
    console.log("Memulai sinkronisasi seed karyawan...");
    
    // Helper wrapper for db.run to use promises
    const dbRun = (sql, params = []) => {
      return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };

    // Hapus nama karyawan lama yang tidak ada di dalam daftar defaultKaryawan
    const placeholders = defaultKaryawan.map(() => "?").join(",");
    await dbRun(
      `DELETE FROM karyawan WHERE nama NOT IN (${placeholders})`,
      defaultKaryawan
    );

    // Filter and insert karyawan if they don't exist
    for (const nama of defaultKaryawan) {
      await dbRun(
        "INSERT INTO karyawan (nama) SELECT * FROM (SELECT ? AS name) AS tmp WHERE NOT EXISTS (SELECT 1 FROM karyawan WHERE nama = ?)",
        [nama, nama]
      );
    }

    console.log("Seed karyawan berhasil disinkronisasi: " + defaultKaryawan.join(", "));
  } catch (err) {
    console.error("Error seeding data:", err);
  } finally {
    db.close();
  }
};

runSeeding();
