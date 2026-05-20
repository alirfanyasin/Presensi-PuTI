const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'presensi.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        // Initialize tables
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS karyawan (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nama TEXT NOT NULL
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS presensi (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                karyawanId INTEGER NOT NULL,
                tanggal TEXT NOT NULL,
                jamMasuk TEXT NOT NULL,
                jamPulang TEXT NOT NULL,
                pekerjaan TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                updatedAt TEXT,
                hari TEXT,
                totalJam TEXT,
                foto TEXT,
                FOREIGN KEY (karyawanId) REFERENCES karyawan (id)
            )`, (err) => {
                if (!err) {
                    // Check schema using table_info to handle migrations dynamically
                    db.all("PRAGMA table_info(presensi)", (err, columns) => {
                        if (!err && columns) {
                            const columnNames = columns.map(c => c.name);
                            
                            // Rename jamMulai to jamMasuk if it exists
                            if (columnNames.includes('jamMulai') && !columnNames.includes('jamMasuk')) {
                                db.run("ALTER TABLE presensi RENAME COLUMN jamMulai TO jamMasuk", (err) => {
                                    if (err) console.error("Error migrating jamMulai to jamMasuk:", err);
                                });
                            }
                            
                            // Rename jamAkhir to jamPulang if it exists
                            if (columnNames.includes('jamAkhir') && !columnNames.includes('jamPulang')) {
                                db.run("ALTER TABLE presensi RENAME COLUMN jamAkhir TO jamPulang", (err) => {
                                    if (err) console.error("Error migrating jamAkhir to jamPulang:", err);
                                });
                            }
                            
                            // Add columns if they don't exist
                            if (!columnNames.includes('updatedAt')) {
                                db.run("ALTER TABLE presensi ADD COLUMN updatedAt TEXT", (err) => {
                                    if (!err) {
                                        // Set existing records' updatedAt equal to createdAt
                                        db.run("UPDATE presensi SET updatedAt = createdAt WHERE updatedAt IS NULL");
                                    }
                                });
                            }
                            if (!columnNames.includes('hari')) {
                                db.run("ALTER TABLE presensi ADD COLUMN hari TEXT");
                            }
                            if (!columnNames.includes('totalJam')) {
                                db.run("ALTER TABLE presensi ADD COLUMN totalJam TEXT");
                            }
                            if (!columnNames.includes('foto')) {
                                db.run("ALTER TABLE presensi ADD COLUMN foto TEXT");
                            }
                            if (!columnNames.includes('menitTambahan')) {
                                db.run("ALTER TABLE presensi ADD COLUMN menitTambahan INTEGER DEFAULT 0");
                            }
                        }
                    });
                }
            });

            db.run(`CREATE TABLE IF NOT EXISTS overtime (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                karyawanId INTEGER NOT NULL,
                presensiId INTEGER,
                tanggal TEXT NOT NULL,
                durasiMenit INTEGER NOT NULL,
                sisaMenit INTEGER NOT NULL,
                keterangan TEXT,
                createdAt TEXT NOT NULL,
                updatedAt TEXT,
                FOREIGN KEY (karyawanId) REFERENCES karyawan (id),
                FOREIGN KEY (presensiId) REFERENCES presensi (id)
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS overtime_transfer (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                karyawanId INTEGER NOT NULL,
                overtimeId INTEGER NOT NULL,
                presensiId INTEGER NOT NULL,
                tanggalTransfer TEXT NOT NULL,
                durasiMenit INTEGER NOT NULL,
                keterangan TEXT,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (karyawanId) REFERENCES karyawan (id),
                FOREIGN KEY (overtimeId) REFERENCES overtime (id),
                FOREIGN KEY (presensiId) REFERENCES presensi (id)
            )`);
        });
    }
});

module.exports = db;
