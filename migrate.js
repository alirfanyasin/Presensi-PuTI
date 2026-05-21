const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = require('./db'); // This automatically handles MySQL setup!

const sqliteDbPath = path.join(__dirname, 'presensi.db');
const sqliteDb = new sqlite3.Database(sqliteDbPath);

// Helper to wrap sqlite3 queries in Promise
const sqliteAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Helper to wrap db wrapper methods in Promise
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

async function migrate() {
  try {
    console.log('Starting migration from SQLite to MySQL...');
    
    // Disable foreign keys check
    await dbRun('SET FOREIGN_KEY_CHECKS = 0');

    // 1. Clear existing data in MySQL tables
    console.log('Clearing existing data in MySQL...');
    await dbRun('TRUNCATE TABLE overtime_transfer');
    await dbRun('TRUNCATE TABLE overtime');
    await dbRun('TRUNCATE TABLE presensi');
    await dbRun('TRUNCATE TABLE karyawan');

    // 2. Migrate karyawan
    console.log('Migrating table: karyawan...');
    const karyawanRows = await sqliteAll('SELECT * FROM karyawan');
    for (const r of karyawanRows) {
      await dbRun('INSERT INTO karyawan (id, nama) VALUES (?, ?)', [r.id, r.nama]);
    }
    console.log(`Successfully migrated ${karyawanRows.length} karyawan rows.`);

    // 3. Migrate presensi
    console.log('Migrating table: presensi...');
    const presensiRows = await sqliteAll('SELECT * FROM presensi');
    for (const r of presensiRows) {
      await dbRun(
        `INSERT INTO presensi (id, karyawanId, tanggal, jamMasuk, jamPulang, pekerjaan, createdAt, updatedAt, hari, totalJam, foto, menitTambahan) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.karyawanId,
          r.tanggal,
          r.jamMasuk,
          r.jamPulang,
          r.pekerjaan,
          r.createdAt,
          r.updatedAt,
          r.hari,
          r.totalJam,
          r.foto,
          r.menitTambahan || 0
        ]
      );
    }
    console.log(`Successfully migrated ${presensiRows.length} presensi rows.`);

    // 4. Migrate overtime
    console.log('Migrating table: overtime...');
    const overtimeRows = await sqliteAll('SELECT * FROM overtime');
    for (const r of overtimeRows) {
      await dbRun(
        `INSERT INTO overtime (id, karyawanId, presensiId, tanggal, durasiMenit, sisaMenit, keterangan, createdAt, updatedAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.karyawanId,
          r.presensiId,
          r.tanggal,
          r.durasiMenit,
          r.sisaMenit,
          r.keterangan,
          r.createdAt,
          r.updatedAt
        ]
      );
    }
    console.log(`Successfully migrated ${overtimeRows.length} overtime rows.`);

    // 5. Migrate overtime_transfer
    console.log('Migrating table: overtime_transfer...');
    const transferRows = await sqliteAll('SELECT * FROM overtime_transfer');
    for (const r of transferRows) {
      await dbRun(
        `INSERT INTO overtime_transfer (id, karyawanId, overtimeId, presensiId, tanggalTransfer, durasiMenit, keterangan, createdAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.karyawanId,
          r.overtimeId,
          r.presensiId,
          r.tanggalTransfer,
          r.durasiMenit,
          r.keterangan,
          r.createdAt
        ]
      );
    }
    console.log(`Successfully migrated ${transferRows.length} overtime_transfer rows.`);

    // Enable foreign key checks back
    await dbRun('SET FOREIGN_KEY_CHECKS = 1');
    console.log('Migration finished successfully!');
  } catch (err) {
    console.error('Error during migration:', err.message);
  } finally {
    sqliteDb.close();
    db.close();
  }
}

migrate();
