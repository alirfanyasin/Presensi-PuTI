const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const moment = require('moment');

const backupDir = path.join(__dirname, 'backup');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
}

const today = moment().format('YYYY-MM-DD');
const sqliteBackupPath = path.join(backupDir, `backup_${today}.sqlite`);
const mysqlBackupPath = path.join(backupDir, `backup_${today}.sql`);

const sourceDbPath = path.join(__dirname, 'presensi.db');

// Backup SQLite (copy file)
if (fs.existsSync(sourceDbPath)) {
    fs.copyFileSync(sourceDbPath, sqliteBackupPath);
    console.log(`Backup SQLite berhasil: ${sqliteBackupPath}`);
} else {
    console.error(`Database SQLite tidak ditemukan di ${sourceDbPath}`);
    process.exit(1);
}

// Backup to MySQL dump
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
    sqlDump += `  \`jamMulai\` varchar(5) NOT NULL,\n`;
    sqlDump += `  \`jamAkhir\` varchar(5) NOT NULL,\n`;
    sqlDump += `  \`pekerjaan\` text NOT NULL,\n`;
    sqlDump += `  \`createdAt\` datetime NOT NULL,\n`;
    sqlDump += `  \`hari\` varchar(50) DEFAULT NULL,\n`;
    sqlDump += `  \`totalJam\` varchar(100) DEFAULT NULL,\n`;
    sqlDump += `  PRIMARY KEY (\`id\`),\n`;
    sqlDump += `  KEY \`karyawanId\` (\`karyawanId\`),\n`;
    sqlDump += `  CONSTRAINT \`presensi_ibfk_1\` FOREIGN KEY (\`karyawanId\`) REFERENCES \`karyawan\` (\`id\`)\n`;
    sqlDump += `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;

    db.all("SELECT * FROM karyawan", (err, rows) => {
        if (err) {
            console.error('Error reading karyawan:', err);
            return;
        }
        if (rows && rows.length > 0) {
            sqlDump += `INSERT INTO \`karyawan\` (\`id\`, \`nama\`) VALUES\n`;
            const values = rows.map(r => `(${r.id}, '${r.nama.replace(/'/g, "''")}')`);
            sqlDump += values.join(",\n") + ";\n\n";
        }

        db.all("SELECT * FROM presensi", (err, presensiRows) => {
            if (err) {
                console.error('Error reading presensi:', err);
                return;
            }
            if (presensiRows && presensiRows.length > 0) {
                sqlDump += `INSERT INTO \`presensi\` (\`id\`, \`karyawanId\`, \`tanggal\`, \`jamMulai\`, \`jamAkhir\`, \`pekerjaan\`, \`createdAt\`, \`hari\`, \`totalJam\`) VALUES\n`;
                const presensiValues = presensiRows.map(r => {
                    const hariVal = r.hari ? `'${r.hari.replace(/'/g, "''")}'` : 'NULL';
                    const totalJamVal = r.totalJam ? `'${r.totalJam.replace(/'/g, "''")}'` : 'NULL';
                    return `(${r.id}, ${r.karyawanId}, '${r.tanggal}', '${r.jamMulai}', '${r.jamAkhir}', '${r.pekerjaan.replace(/'/g, "''")}', '${r.createdAt}', ${hariVal}, ${totalJamVal})`;
                });
                sqlDump += presensiValues.join(",\n") + ";\n\n";
            }
            
            fs.writeFileSync(mysqlBackupPath, sqlDump);
            console.log(`Backup MySQL dump berhasil: ${mysqlBackupPath}`);
            db.close();
        });
    });
});
