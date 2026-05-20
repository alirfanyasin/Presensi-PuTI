const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const moment = require('moment');

const runBackup = () => {
    return new Promise((resolve, reject) => {
        const backupDir = path.join(__dirname, 'backup');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const today = moment().format('YYYY-MM-DD');
        const sqliteBackupPath = path.join(backupDir, `backup_${today}.sqlite`);
        const mysqlBackupPath = path.join(backupDir, `backup_${today}.sql`);
        const imagesBackupDir = path.join(backupDir, `backup_foto_${today}`);
        const uploadsBackupDir = path.join(backupDir, `backup_uploads_${today}`);

        const sourceDbPath = path.join(__dirname, 'presensi.db');
        const sourceUploadsDir = path.join(__dirname, 'uploads');

        // Helper function to safely escape SQL values for MySQL Dump
        function escapeSqlValue(val) {
            if (val === null || val === undefined) {
                return 'NULL';
            }
            return `'${String(val).replace(/'/g, "''")}'`;
        }

        // Helper function to extract and save base64 image from database (legacy support)
        function saveBase64Image(base64Str, destDir, fileNameWithoutExt) {
            if (!base64Str) return null;

            // Match data URI pattern
            const matches = base64Str.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (!matches) {
                try {
                    const buffer = Buffer.from(base64Str, 'base64');
                    const destPath = path.join(destDir, `${fileNameWithoutExt}.png`);
                    fs.writeFileSync(destPath, buffer);
                    return `${fileNameWithoutExt}.png`;
                } catch (e) {
                    console.error(`Gagal menyimpan gambar mentah base64: ${e.message}`);
                    return null;
                }
            }

            const contentType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');

            // Determine extension
            let ext = 'png';
            if (contentType.includes('jpeg') || contentType.includes('jpg')) {
                ext = 'jpg';
            } else if (contentType.includes('gif')) {
                ext = 'gif';
            } else if (contentType.includes('webp')) {
                ext = 'webp';
            }

            const fileName = `${fileNameWithoutExt}.${ext}`;
            const destPath = path.join(destDir, fileName);
            try {
                fs.writeFileSync(destPath, buffer);
                return fileName;
            } catch (e) {
                console.error(`Gagal menyimpan gambar: ${e.message}`);
                return null;
            }
        }

        // 1. Backup SQLite (copy database file)
        if (fs.existsSync(sourceDbPath)) {
            fs.copyFileSync(sourceDbPath, sqliteBackupPath);
            console.log(`Backup SQLite berhasil: ${sqliteBackupPath}`);
        } else {
            const err = new Error(`Database SQLite tidak ditemukan di ${sourceDbPath}`);
            console.error(err.message);
            return reject(err);
        }

        // 2. Backup physical uploads folder
        if (fs.existsSync(sourceUploadsDir)) {
            try {
                fs.cpSync(sourceUploadsDir, uploadsBackupDir, { recursive: true });
                console.log(`Backup folder uploads berhasil: ${uploadsBackupDir}`);
            } catch (err) {
                console.error(`Gagal mem-backup folder uploads: ${err.message}`);
            }
        }

        // 3. Backup to MySQL dump & Export Legacy Images
        const db = new sqlite3.Database(sourceDbPath);

        db.serialize(() => {
            let sqlDump = `-- MySQL Dump \n-- Date: ${today}\n\n`;
            sqlDump += `DROP TABLE IF EXISTS \`presensi\`;\n`;
            sqlDump += `DROP TABLE IF EXISTS \`karyawan\`;\n\n`;

            sqlDump += `CREATE TABLE \`karyawan\` (\n`;
            sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
            sqlDump += `  \`nama\` varchar(255) NOT NULL,\n`;
            sqlDump += `  PRIMARY KEY (\`id\`)\n`;
            sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

            sqlDump += `CREATE TABLE \`presensi\` (\n`;
            sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
            sqlDump += `  \`karyawanId\` int NOT NULL,\n`;
            sqlDump += `  \`tanggal\` date NOT NULL,\n`;
            sqlDump += `  \`jamMasuk\` varchar(20) DEFAULT NULL,\n`;
            sqlDump += `  \`jamPulang\` varchar(20) DEFAULT NULL,\n`;
            sqlDump += `  \`pekerjaan\` text DEFAULT NULL,\n`;
            sqlDump += `  \`createdAt\` datetime DEFAULT NULL,\n`;
            sqlDump += `  \`updatedAt\` datetime DEFAULT NULL,\n`;
            sqlDump += `  \`hari\` varchar(50) DEFAULT NULL,\n`;
            sqlDump += `  \`totalJam\` varchar(100) DEFAULT NULL,\n`;
            sqlDump += `  \`foto\` longtext DEFAULT NULL,\n`;
            sqlDump += `  PRIMARY KEY (\`id\`),\n`;
            sqlDump += `  KEY \`karyawanId\` (\`karyawanId\`),\n`;
            sqlDump += `  CONSTRAINT \`presensi_ibfk_1\` FOREIGN KEY (\`karyawanId\`) REFERENCES \`karyawan\` (\`id\`)\n`;
            sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

            db.all("SELECT * FROM karyawan", (err, rows) => {
                if (err) {
                    console.error('Error reading karyawan:', err);
                    db.close();
                    return reject(err);
                }
                if (rows && rows.length > 0) {
                    sqlDump += `INSERT INTO \`karyawan\` (\`id\`, \`nama\`) VALUES\n`;
                    const values = rows.map(r => `(${r.id}, ${escapeSqlValue(r.nama)})`);
                    sqlDump += values.join(",\n") + ";\n\n";
                }

                db.all("SELECT * FROM presensi", (err, presensiRows) => {
                    if (err) {
                        console.error('Error reading presensi:', err);
                        db.close();
                        return reject(err);
                    }

                    let savedLegacyImagesCount = 0;

                    if (presensiRows && presensiRows.length > 0) {
                        sqlDump += `INSERT INTO \`presensi\` (\`id\`, \`karyawanId\`, \`tanggal\`, \`jamMasuk\`, \`jamPulang\`, \`pekerjaan\`, \`createdAt\`, \`updatedAt\`, \`hari\`, \`totalJam\`, \`foto\`) VALUES\n`;

                        const presensiValues = presensiRows.map(r => {
                            if (r.foto && !r.foto.startsWith('/uploads/')) {
                                if (!fs.existsSync(imagesBackupDir)) {
                                    fs.mkdirSync(imagesBackupDir, { recursive: true });
                                }

                                const fileNameWithoutExt = `presensi_${r.id}_karyawan_${r.karyawanId}_${r.tanggal}`;
                                const savedFileName = saveBase64Image(r.foto, imagesBackupDir, fileNameWithoutExt);
                                if (savedFileName) {
                                    savedLegacyImagesCount++;
                                }
                            }

                            return `(${r.id}, ${r.karyawanId}, ${escapeSqlValue(r.tanggal)}, ${escapeSqlValue(r.jamMasuk)}, ${escapeSqlValue(r.jamPulang)}, ${escapeSqlValue(r.pekerjaan)}, ${escapeSqlValue(r.createdAt)}, ${escapeSqlValue(r.updatedAt)}, ${escapeSqlValue(r.hari)}, ${escapeSqlValue(r.totalJam)}, ${escapeSqlValue(r.foto)})`;
                        });

                        sqlDump += presensiValues.join(",\n") + ";\n\n";
                    }

                    try {
                        fs.writeFileSync(mysqlBackupPath, sqlDump);
                        console.log(`Backup MySQL dump berhasil: ${mysqlBackupPath}`);
                        if (savedLegacyImagesCount > 0) {
                            console.log(`Backup gambar lama (Base64) berhasil: ${savedLegacyImagesCount} gambar disimpan di ${imagesBackupDir}`);
                        }

                        // Save backup metadata info
                        const lastBackupInfoPath = path.join(backupDir, 'backup_info.json');
                        fs.writeFileSync(lastBackupInfoPath, JSON.stringify({ lastBackup: moment().format('YYYY-MM-DD HH:mm:ss') }, null, 2));

                        db.close();
                        resolve();
                    } catch (writeErr) {
                        console.error('Gagal menulis file MySQL dump:', writeErr.message);
                        db.close();
                        reject(writeErr);
                    }
                });
            });
        });
    });
};

module.exports = { runBackup };

if (require.main === module) {
    runBackup()
        .then(() => {
            console.log("Proses backup selesai.");
            process.exit(0);
        })
        .catch((err) => {
            console.error("Backup gagal:", err);
            process.exit(1);
        });
}
