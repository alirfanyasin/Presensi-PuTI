const mysql = require('mysql2');
require('dotenv').config();

class MySQLWrapper {
  constructor() {
    this.queue = [];
    this.running = false;
    this.initialized = false;
    this.pool = null;

    this.init();
  }

  async init() {
    try {
      const config = {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        port: parseInt(process.env.DB_PORT || '3306', 10),
      };

      const dbName = process.env.DB_DATABASE || 'presensi_puti';

      // 1. Connect without database to create it if it doesn't exist
      const connection = mysql.createConnection(config);
      
      await new Promise((resolve, reject) => {
        connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      connection.end();

      // 2. Create pool with database and dateStrings config (to keep Date as String type)
      this.pool = mysql.createPool({
        ...config,
        database: dbName,
        dateStrings: true,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });

      // 3. Initialize tables sequentially
      await this.createTables();

      // Migration: Add foto column to tasks if it doesn't exist
      await new Promise((resolve) => {
        this.pool.query("SHOW COLUMNS FROM tasks LIKE 'foto'", (err, rows) => {
          if (!err && rows && rows.length === 0) {
            this.pool.query("ALTER TABLE tasks ADD COLUMN foto LONGTEXT", () => resolve());
          } else {
            resolve();
          }
        });
      });

      // Migration: Add code column to tasks if it doesn't exist
      await new Promise((resolve) => {
        this.pool.query("SHOW COLUMNS FROM tasks LIKE 'code'", (err, rows) => {
          if (!err && rows && rows.length === 0) {
            this.pool.query("ALTER TABLE tasks ADD COLUMN code VARCHAR(50) UNIQUE DEFAULT NULL", (errAlt) => {
              if (errAlt) {
                console.error("Failed to add code column to tasks:", errAlt.message);
                resolve();
              } else {
                this.pool.query("UPDATE tasks SET code = CONCAT('#', LPAD(id, 4, '0')) WHERE code IS NULL", () => resolve());
              }
            });
          } else {
            resolve();
          }
        });
      });

      // Migration: Add workspace, requester, source, and priority columns if they don't exist
      const addColumnIfNotExist = (colName, colDef) => {
        return new Promise((resolve) => {
          this.pool.query(`SHOW COLUMNS FROM tasks LIKE '${colName}'`, (err, rows) => {
            if (!err && rows && rows.length === 0) {
              this.pool.query(`ALTER TABLE tasks ADD COLUMN ${colName} ${colDef}`, (errAlt) => {
                if (errAlt) {
                  console.error(`Failed to add column ${colName} to tasks:`, errAlt.message);
                }
                resolve();
              });
            } else {
              resolve();
            }
          });
        });
      };

      await addColumnIfNotExist('workspace', "VARCHAR(100) DEFAULT 'General'");
      await addColumnIfNotExist('requester', "VARCHAR(255) DEFAULT NULL");
      await addColumnIfNotExist('source', "VARCHAR(100) DEFAULT 'Sistem'");
      await addColumnIfNotExist('priority', "VARCHAR(50) DEFAULT 'Low'");
      await addColumnIfNotExist('link', "VARCHAR(500) DEFAULT NULL");
      await addColumnIfNotExist('order_index', "INT DEFAULT 0");

      // Migration: Add type and role columns to karyawan if they don't exist
      const addKaryawanColIfNotExist = (colName, colDef) => {
        return new Promise((resolve) => {
          this.pool.query(`SHOW COLUMNS FROM karyawan LIKE '${colName}'`, (err, rows) => {
            if (!err && rows && rows.length === 0) {
              this.pool.query(`ALTER TABLE karyawan ADD COLUMN ${colName} ${colDef}`, (errAlt) => {
                if (errAlt) console.error(`Failed to add column ${colName} to karyawan:`, errAlt.message);
                resolve();
              });
            } else {
              resolve();
            }
          });
        });
      };
      await addKaryawanColIfNotExist('type', "VARCHAR(100) DEFAULT NULL");
      await addKaryawanColIfNotExist('role', "VARCHAR(100) DEFAULT NULL");

      // Migration: Drop nim column from karyawan if it still exists
      await new Promise((resolve) => {
        this.pool.query("SHOW COLUMNS FROM karyawan LIKE 'nim'", (err, rows) => {
          if (!err && rows && rows.length > 0) {
            this.pool.query("ALTER TABLE karyawan DROP COLUMN nim", (errDrop) => {
              if (errDrop) console.error("Failed to drop nim column:", errDrop.message);
              resolve();
            });
          } else {
            resolve();
          }
        });
      });

      // Seed default workspaces if empty
      await new Promise((resolve) => {
        this.pool.query("SELECT COUNT(*) AS cnt FROM workspaces", (err, rows) => {
          if (!err && rows && rows[0].cnt === 0) {
            const defaults = ['General', 'IT Support & Jaringan', 'Administrasi & Surat', 'Layanan Mahasiswa', 'Sarana & Prasarana'];
            const vals = defaults.map(n => `('${n}')`).join(',');
            this.pool.query(`INSERT INTO workspaces (nama) VALUES ${vals}`, () => resolve());
          } else {
            resolve();
          }
        });
      });

      this.initialized = true;
      console.log('Connected to MySQL database and tables verified.');
      this._next();
    } catch (err) {
      console.error('Failed to initialize MySQL database:', err.message);
      process.exit(1);
    }
  }

  createTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS karyawan (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nama VARCHAR(255) NOT NULL,
          nim VARCHAR(50) DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS presensi (
          id INT AUTO_INCREMENT PRIMARY KEY,
          karyawanId INT NOT NULL,
          tanggal VARCHAR(50) NOT NULL,
          jamMasuk VARCHAR(50) NOT NULL,
          jamPulang VARCHAR(50),
          pekerjaan TEXT,
          createdAt VARCHAR(100) NOT NULL,
          updatedAt VARCHAR(100),
          hari VARCHAR(50),
          totalJam VARCHAR(100),
          foto LONGTEXT,
          menitTambahan INT DEFAULT 0,
          FOREIGN KEY (karyawanId) REFERENCES karyawan (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS overtime (
          id INT AUTO_INCREMENT PRIMARY KEY,
          karyawanId INT NOT NULL,
          presensiId INT,
          tanggal VARCHAR(50) NOT NULL,
          durasiMenit INT NOT NULL,
          sisaMenit INT NOT NULL,
          keterangan TEXT,
          createdAt VARCHAR(100) NOT NULL,
          updatedAt VARCHAR(100),
          FOREIGN KEY (karyawanId) REFERENCES karyawan (id) ON DELETE CASCADE,
          FOREIGN KEY (presensiId) REFERENCES presensi (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS overtime_transfer (
          id INT AUTO_INCREMENT PRIMARY KEY,
          karyawanId INT NOT NULL,
          overtimeId INT NOT NULL,
          presensiId INT NOT NULL,
          tanggalTransfer VARCHAR(50) NOT NULL,
          durasiMenit INT NOT NULL,
          keterangan TEXT,
          createdAt VARCHAR(100) NOT NULL,
          FOREIGN KEY (karyawanId) REFERENCES karyawan (id) ON DELETE CASCADE,
          FOREIGN KEY (overtimeId) REFERENCES overtime (id) ON DELETE CASCADE,
          FOREIGN KEY (presensiId) REFERENCES presensi (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS tasks (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(50) UNIQUE DEFAULT NULL,
          task TEXT NOT NULL,
          tanggal VARCHAR(50) NOT NULL,
          deadline VARCHAR(50) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'Todo',
          foto LONGTEXT,
          workspace VARCHAR(100) DEFAULT 'General',
          requester VARCHAR(255) DEFAULT NULL,
          source VARCHAR(100) DEFAULT 'Sistem',
          priority VARCHAR(50) DEFAULT 'Low'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS task_karyawan (
          taskId INT NOT NULL,
          karyawanId INT NOT NULL,
          PRIMARY KEY (taskId, karyawanId),
          FOREIGN KEY (taskId) REFERENCES tasks (id) ON DELETE CASCADE,
          FOREIGN KEY (karyawanId) REFERENCES karyawan (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS workspaces (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nama VARCHAR(100) NOT NULL UNIQUE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];

    return new Promise((resolve, reject) => {
      let index = 0;
      const runNext = () => {
        if (index >= queries.length) {
          resolve();
          return;
        }
        this.pool.query(queries[index], (err) => {
          if (err) {
            console.error(`Error creating table at query index ${index}:`, err.message);
            reject(err);
          } else {
            index++;
            runNext();
          }
        });
      };
      runNext();
    });
  }

  _exec(fn, sql, params, callback) {
    const task = () => {
      this.running = true;
      this.pool.query(sql, params, (err, results) => {
        try {
          if (fn === 'run') {
            if (callback) {
              const ctx = {
                lastID: results ? results.insertId : null,
                changes: results ? results.affectedRows : 0
              };
              callback.call(ctx, err);
            }
          } else if (fn === 'get') {
            if (callback) {
              callback(err, results && results.length > 0 ? results[0] : undefined);
            }
          } else if (fn === 'all') {
            if (callback) {
              callback(err, results);
            }
          }
        } finally {
          this.running = false;
          this._next();
        }
      });
    };

    this.queue.push(task);
    if (this.initialized && !this.running) {
      this._next();
    }
  }

  _next() {
    if (!this.initialized) return;
    if (this.queue.length > 0 && !this.running) {
      const task = this.queue.shift();
      task();
    }
  }

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    this._exec('all', sql, params, callback);
  }

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    this._exec('get', sql, params, callback);
  }

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    this._exec('run', sql, params, callback);
  }

  serialize(callback) {
    // Queries are already serialized by our queue, so we run the callback immediately
    callback();
  }

  prepare(sql) {
    return {
      run: (...args) => {
        let callback = undefined;
        if (typeof args[args.length - 1] === 'function') {
          callback = args.pop();
        }
        this.run(sql, args, callback);
      },
      finalize: (callback) => {
        if (callback) callback();
      }
    };
  }

  close(callback) {
    const checkAndClose = () => {
      if (this.queue.length > 0 || this.running || !this.initialized) {
        setTimeout(checkAndClose, 50);
      } else {
        this.pool.end((err) => {
          if (callback) callback(err);
        });
      }
    };
    checkAndClose();
  }
}

const db = new MySQLWrapper();
module.exports = db;
