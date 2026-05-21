const fs = require('fs');
const path = require('path');
const moment = require('moment');
const db = require('./db');

const runBackup = () => {
    return new Promise((resolve, reject) => {
        const backupDir = path.join(__dirname, 'backup');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const today = moment().format('YYYY-MM-DD');
        const mysqlBackupPath = path.join(backupDir, `backup_${today}.sql`);
        const imagesBackupDir = path.join(backupDir, `backup_foto_${today}`);
        const uploadsBackupDir = path.join(backupDir, `backup_uploads_${today}`);

        const sourceUploadsDir = path.join(__dirname, 'uploads');

        // Helper function to safely escape SQL values for MySQL Dump
        function escapeSqlValue(val) {
            if (val === null || val === undefined) {
                return 'NULL';
            }
            return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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

        // 1. Backup physical uploads folder
        if (fs.existsSync(sourceUploadsDir)) {
            try {
                fs.cpSync(sourceUploadsDir, uploadsBackupDir, { recursive: true });
                console.log(`Backup folder uploads berhasil: ${uploadsBackupDir}`);
            } catch (err) {
                console.error(`Gagal mem-backup folder uploads: ${err.message}`);
            }
        }

        // 2. Helper wrappers to fetch data using promises
        const dbAll = (sql, params = []) => {
            return new Promise((res, rej) => {
                db.all(sql, params, (err, rows) => {
                    if (err) rej(err);
                    else res(rows);
                });
            });
        };

        // 3. Perform backup to SQL Dump
        (async () => {
            try {
                let sqlDump = `-- MySQL Dump \n-- Date: ${today}\n\n`;
                sqlDump += `SET FOREIGN_KEY_CHECKS = 0;\n`;
                sqlDump += `DROP TABLE IF EXISTS \`overtime_transfer\`;\n`;
                sqlDump += `DROP TABLE IF EXISTS \`overtime\`;\n`;
                sqlDump += `DROP TABLE IF EXISTS \`presensi\`;\n`;
                sqlDump += `DROP TABLE IF EXISTS \`karyawan\`;\n`;
                sqlDump += `SET FOREIGN_KEY_CHECKS = 1;\n\n`;

                // Schema Definitions
                sqlDump += `CREATE TABLE \`karyawan\` (\n`;
                sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
                sqlDump += `  \`nama\` varchar(255) NOT NULL,\n`;
                sqlDump += `  PRIMARY KEY (\`id\`)\n`;
                sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

                sqlDump += `CREATE TABLE \`presensi\` (\n`;
                sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
                sqlDump += `  \`karyawanId\` int NOT NULL,\n`;
                sqlDump += `  \`tanggal\` varchar(50) NOT NULL,\n`;
                sqlDump += `  \`jamMasuk\` varchar(50) NOT NULL,\n`;
                sqlDump += `  \`jamPulang\` varchar(50) DEFAULT NULL,\n`;
                sqlDump += `  \`pekerjaan\` text DEFAULT NULL,\n`;
                sqlDump += `  \`createdAt\` varchar(100) NOT NULL,\n`;
                sqlDump += `  \`updatedAt\` varchar(100) DEFAULT NULL,\n`;
                sqlDump += `  \`hari\` varchar(50) DEFAULT NULL,\n`;
                sqlDump += `  \`totalJam\` varchar(100) DEFAULT NULL,\n`;
                sqlDump += `  \`foto\` longtext DEFAULT NULL,\n`;
                sqlDump += `  \`menitTambahan\` int DEFAULT 0,\n`;
                sqlDump += `  PRIMARY KEY (\`id\`),\n`;
                sqlDump += `  KEY \`karyawanId\` (\`karyawanId\`),\n`;
                sqlDump += `  CONSTRAINT \`presensi_ibfk_1\` FOREIGN KEY (\`karyawanId\`) REFERENCES \`karyawan\` (\`id\`) ON DELETE CASCADE\n`;
                sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

                sqlDump += `CREATE TABLE \`overtime\` (\n`;
                sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
                sqlDump += `  \`karyawanId\` int NOT NULL,\n`;
                sqlDump += `  \`presensiId\` int DEFAULT NULL,\n`;
                sqlDump += `  \`tanggal\` varchar(50) NOT NULL,\n`;
                sqlDump += `  \`durasiMenit\` int NOT NULL,\n`;
                sqlDump += `  \`sisaMenit\` int NOT NULL,\n`;
                sqlDump += `  \`keterangan\` text DEFAULT NULL,\n`;
                sqlDump += `  \`createdAt\` varchar(100) NOT NULL,\n`;
                sqlDump += `  \`updatedAt\` varchar(100) DEFAULT NULL,\n`;
                sqlDump += `  PRIMARY KEY (\`id\`),\n`;
                sqlDump += `  KEY \`karyawanId\` (\`karyawanId\`),\n`;
                sqlDump += `  KEY \`presensiId\` (\`presensiId\`),\n`;
                sqlDump += `  CONSTRAINT \`overtime_ibfk_1\` FOREIGN KEY (\`karyawanId\`) REFERENCES \`karyawan\` (\`id\`) ON DELETE CASCADE,\n`;
                sqlDump += `  CONSTRAINT \`overtime_ibfk_2\` FOREIGN KEY (\`presensiId\`) REFERENCES \`presensi\` (\`id\`) ON DELETE SET NULL\n`;
                sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

                sqlDump += `CREATE TABLE \`overtime_transfer\` (\n`;
                sqlDump += `  \`id\` int NOT NULL AUTO_INCREMENT,\n`;
                sqlDump += `  \`karyawanId\` int NOT NULL,\n`;
                sqlDump += `  \`overtimeId\` int NOT NULL,\n`;
                sqlDump += `  \`presensiId\` int NOT NULL,\n`;
                sqlDump += `  \`tanggalTransfer\` varchar(50) NOT NULL,\n`;
                sqlDump += `  \`durasiMenit\` int NOT NULL,\n`;
                sqlDump += `  \`keterangan\` text DEFAULT NULL,\n`;
                sqlDump += `  \`createdAt\` varchar(100) NOT NULL,\n`;
                sqlDump += `  PRIMARY KEY (\`id\`),\n`;
                sqlDump += `  KEY \`karyawanId\` (\`karyawanId\`),\n`;
                sqlDump += `  KEY \`overtimeId\` (\`overtimeId\`),\n`;
                sqlDump += `  KEY \`presensiId\` (\`presensiId\`),\n`;
                sqlDump += `  CONSTRAINT \`overtime_transfer_ibfk_1\` FOREIGN KEY (\`karyawanId\`) REFERENCES \`karyawan\` (\`id\`) ON DELETE CASCADE,\n`;
                sqlDump += `  CONSTRAINT \`overtime_transfer_ibfk_2\` FOREIGN KEY (\`overtimeId\`) REFERENCES \`overtime\` (\`id\`) ON DELETE CASCADE,\n`;
                sqlDump += `  CONSTRAINT \`overtime_transfer_ibfk_3\` FOREIGN KEY (\`presensiId\`) REFERENCES \`presensi\` (\`id\`) ON DELETE CASCADE\n`;
                sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

                // Fetch & write karyawan
                const karyawanRows = await dbAll("SELECT * FROM karyawan");
                if (karyawanRows && karyawanRows.length > 0) {
                    sqlDump += `INSERT INTO \`karyawan\` (\`id\`, \`nama\`) VALUES\n`;
                    const values = karyawanRows.map(r => `(${r.id}, ${escapeSqlValue(r.nama)})`);
                    sqlDump += values.join(",\n") + ";\n\n";
                }

                // Fetch & write presensi + export legacy base64 images
                const presensiRows = await dbAll("SELECT * FROM presensi");
                let savedLegacyImagesCount = 0;
                if (presensiRows && presensiRows.length > 0) {
                    sqlDump += `INSERT INTO \`presensi\` (\`id\`, \`karyawanId\`, \`tanggal\`, \`jamMasuk\`, \`jamPulang\`, \`pekerjaan\`, \`createdAt\`, \`updatedAt\`, \`hari\`, \`totalJam\`, \`foto\`, \`menitTambahan\`) VALUES\n`;
                    
                    const values = presensiRows.map(r => {
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
                        return `(${r.id}, ${r.karyawanId}, ${escapeSqlValue(r.tanggal)}, ${escapeSqlValue(r.jamMasuk)}, ${escapeSqlValue(r.jamPulang)}, ${escapeSqlValue(r.pekerjaan)}, ${escapeSqlValue(r.createdAt)}, ${escapeSqlValue(r.updatedAt)}, ${escapeSqlValue(r.hari)}, ${escapeSqlValue(r.totalJam)}, ${escapeSqlValue(r.foto)}, ${r.menitTambahan || 0})`;
                    });
                    sqlDump += values.join(",\n") + ";\n\n";
                }

                // Fetch & write overtime
                const overtimeRows = await dbAll("SELECT * FROM overtime");
                if (overtimeRows && overtimeRows.length > 0) {
                    sqlDump += `INSERT INTO \`overtime\` (\`id\`, \`karyawanId\`, \`presensiId\`, \`tanggal\`, \`durasiMenit\`, \`sisaMenit\`, \`keterangan\`, \`createdAt\`, \`updatedAt\`) VALUES\n`;
                    const values = overtimeRows.map(r => `(${r.id}, ${r.karyawanId}, ${r.presensiId || 'NULL'}, ${escapeSqlValue(r.tanggal)}, ${r.durasiMenit}, ${r.sisaMenit}, ${escapeSqlValue(r.keterangan)}, ${escapeSqlValue(r.createdAt)}, ${escapeSqlValue(r.updatedAt)})`);
                    sqlDump += values.join(",\n") + ";\n\n";
                }

                // Fetch & write overtime_transfer
                const transferRows = await dbAll("SELECT * FROM overtime_transfer");
                if (transferRows && transferRows.length > 0) {
                    sqlDump += `INSERT INTO \`overtime_transfer\` (\`id\`, \`karyawanId\`, \`overtimeId\`, \`presensiId\`, \`tanggalTransfer\`, \`durasiMenit\`, \`keterangan\`, \`createdAt\`) VALUES\n`;
                    const values = transferRows.map(r => `(${r.id}, ${r.karyawanId}, ${r.overtimeId}, ${r.presensiId}, ${escapeSqlValue(r.tanggalTransfer)}, ${r.durasiMenit}, ${escapeSqlValue(r.keterangan)}, ${escapeSqlValue(r.createdAt)})`);
                    sqlDump += values.join(",\n") + ";\n\n";
                }

                // Write SQL file
                fs.writeFileSync(mysqlBackupPath, sqlDump);
                console.log(`Backup MySQL dump berhasil: ${mysqlBackupPath}`);
                if (savedLegacyImagesCount > 0) {
                    console.log(`Backup gambar lama (Base64) berhasil: ${savedLegacyImagesCount} gambar disimpan di ${imagesBackupDir}`);
                }

                // Save backup metadata info
                const lastBackupInfoPath = path.join(backupDir, 'backup_info.json');
                fs.writeFileSync(lastBackupInfoPath, JSON.stringify({ lastBackup: moment().format('YYYY-MM-DD HH:mm:ss') }, null, 2));

                db.close(() => {
                    resolve();
                });
            } catch (err) {
                console.error("Gagal melakukan backup:", err.message);
                db.close(() => {
                    reject(err);
                });
            }
        })();
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
