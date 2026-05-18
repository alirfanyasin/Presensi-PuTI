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
                jamMulai TEXT NOT NULL,
                jamAkhir TEXT NOT NULL,
                pekerjaan TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                hari TEXT,
                totalJam TEXT,
                foto TEXT,
                FOREIGN KEY (karyawanId) REFERENCES karyawan (id)
            )`, (err) => {
                if (!err) {
                    // Try to alter table in case columns don't exist in an already existing database
                    db.run("ALTER TABLE presensi ADD COLUMN hari TEXT", (err) => {
                        // ignore error if column already exists
                    });
                    db.run("ALTER TABLE presensi ADD COLUMN totalJam TEXT", (err) => {
                        // ignore error if column already exists
                    });
                    db.run("ALTER TABLE presensi ADD COLUMN foto TEXT", (err) => {
                        // ignore error if column already exists
                    });
                }
            });
        });
    }
});

module.exports = db;
