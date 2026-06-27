const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const moment = require("moment");
const { isHoliday } = require("./holidayHelper");
const compression = require("compression");

const app = express();
const PORT = process.env.PORT || 3000;

// Registry of SSE clients for real-time notifications
const sseClients = new Set();

const sendSseEvent = (data) => {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      console.error("Gagal mengirim SSE ke client:", err);
      sseClients.delete(client);
    }
  }
};

// Retrieve Git versioning metadata for the footer
const { execSync } = require("child_process");
const pkg = require("./package.json");
let gitInfo = {
  version: pkg.version || "1.0.0",
  branch: "",
  hash: "",
  date: "",
};

try {
  gitInfo.branch = execSync("git rev-parse --abbrev-ref HEAD", {
    stdio: "pipe",
  })
    .toString()
    .trim();
  gitInfo.hash = execSync("git rev-parse --short HEAD", { stdio: "pipe" })
    .toString()
    .trim();
  gitInfo.date = execSync('git log -1 --format="%cs"', { stdio: "pipe" })
    .toString()
    .trim();
} catch (err) {
  console.warn("Gagal membaca metadata Git:", err.message);
}

app.locals.gitInfo = gitInfo;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(bodyParser.json({ limit: "50mb" }));

// Hindari meng-kompres route SSE agar notifikasi suara (real-time) tidak tertahan di buffer
app.use(
  compression({
    filter: (req, res) => {
      if (req.headers["accept"] === "text/event-stream") {
        return false; // Jangan kompres SSE
      }
      return compression.filter(req, res); // Default filter untuk yang lain
    },
  }),
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper to determine the pay period month (16th of prev month to 15th of current month)
const getPeriodMonthStr = (dateStr) => {
  const d = new Date(dateStr);
  let year = d.getFullYear();
  let month = d.getMonth() + 1; // 1-indexed
  const day = d.getDate();
  if (day >= 16) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return `${year}-${String(month).padStart(2, "0")}`;
};

// Helper to get actual period bounds (startDate and endDate as YYYY-MM-DD strings, shifted for weekends/holidays)
const getActualPeriodBounds = async (periodMonthStr) => {
  const [yearStr, monthStr] = periodMonthStr.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  let startMonth = month - 1;
  let startYear = year;
  if (startMonth === 0) {
    startMonth = 12;
    startYear = year - 1;
  }

  // Start date: 16th of previous month, shifted forward to the first non-holiday/non-weekend
  let startMoment = moment(
    `${startYear}-${String(startMonth).padStart(2, "0")}-16`,
    "YYYY-MM-DD",
  );
  while (true) {
    const check = await isHoliday(startMoment.format("YYYY-MM-DD"));
    if (!check.isHoliday) {
      break;
    }
    startMoment.add(1, "day");
  }

  // End date: 15th of current month, shifted backward to the first non-holiday/non-weekend
  let endMoment = moment(
    `${year}-${String(month).padStart(2, "0")}-15`,
    "YYYY-MM-DD",
  );
  while (true) {
    const check = await isHoliday(endMoment.format("YYYY-MM-DD"));
    if (!check.isHoliday) {
      break;
    }
    endMoment.subtract(1, "day");
  }

  return {
    startDate: startMoment.format("YYYY-MM-DD"),
    endDate: endMoment.format("YYYY-MM-DD"),
    startMoment,
    endMoment,
  };
};

// Helper to get formatted Indonesian range string for a given period month (YYYY-MM)
const getPeriodRangeString = async (periodMonthStr) => {
  const { startMoment, endMoment } =
    await getActualPeriodBounds(periodMonthStr);
  return `${startMoment.locale("id").format("D MMMM")} – ${endMoment.locale("id").format("D MMMM YYYY")}`;
};

// Helper to save Base64 image to physical file
const saveBase64Image = (base64Str, recordId) => {
  if (!base64Str) return null;

  // Check if it's already a URL/path
  if (base64Str.startsWith("/uploads/")) {
    return base64Str;
  }

  // Match data URI pattern
  const matches = base64Str.match(
    /^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/,
  );
  let ext = "jpg"; // default extension
  let base64Data = base64Str;

  if (matches) {
    const contentType = matches[1];
    base64Data = matches[2];

    if (contentType.includes("png")) {
      ext = "png";
    } else if (contentType.includes("webp")) {
      ext = "webp";
    } else if (contentType.includes("gif")) {
      ext = "gif";
    }
  }

  const buffer = Buffer.from(base64Data, "base64");
  const formattedDate = moment().format("DD-MM-YYYY_HH-mm-ss");
  const filename = `foto_${recordId}_${formattedDate}.${ext}`;
  const filepath = path.join(uploadsDir, filename);

  fs.writeFileSync(filepath, buffer);
  return `/uploads/${filename}`;
};

// Helper to calculate check-out time from check-in time and minutes
const calculateEndTime = (startStr, minutesToAdd) => {
  if (!startStr) return "";
  const [h, m] = startStr.split(":").map(Number);
  const totalMins = h * 60 + m + minutesToAdd;
  const newH = Math.floor(totalMins / 60) % 24;
  const newM = totalMins % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
};

const monthNames = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

// Utility to fetch all Karyawan (including Staf type)
const getKaryawan = () => {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM karyawan ORDER BY nama ASC", (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Utility to fetch only Student Staff (type != 'Staf') — for presensi & kehadiran pages
const getStudentStaff = () => {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT * FROM karyawan WHERE (type IS NULL OR type != 'Staf') ORDER BY nama ASC",
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      },
    );
  });
};

// Route: Form Isi Presensi
app.get("/", async (req, res) => {
  try {
    const karyawanList = await getStudentStaff();
    const todayObj = new Date();
    const today = todayObj.toISOString().split("T")[0];

    // Get stats for today
    db.all("SELECT * FROM presensi WHERE tanggal = ?", [today], (err, rows) => {
      if (err) throw err;
      let totalMinutes = 0;
      rows.forEach((p) => {
        if (!p.jamMasuk || !p.jamPulang) return;
        const parts = p.jamMasuk.split(":").map(Number);
        const partsA = p.jamPulang.split(":").map(Number);
        totalMinutes += partsA[0] * 60 + partsA[1] - (parts[0] * 60 + parts[1]);
      });
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      const stats = { totalHadir: rows.length, hours, minutes };

      // Get recent activity (last 3)
      db.all(
        "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.tanggal = ? ORDER BY p.id DESC LIMIT 3",
        [today],
        (err, recent) => {
          if (err) throw err;
          res.render("presensi", {
            karyawanList,
            today,
            stats,
            recent,
            success:
              req.query.success === "masuk"
                ? "Presensi Masuk berhasil dicatat!"
                : req.query.success === "pulang"
                  ? "Presensi Pulang berhasil dicatat!"
                  : undefined,
            error:
              req.query.error === "notfound"
                ? "Data presensi masuk tidak ditemukan untuk hari ini. Pastikan Anda sudah melakukan Presensi Masuk."
                : req.query.error === "sudah_pulang"
                  ? "Anda sudah melakukan Presensi Pulang hari ini."
                  : undefined,
            notifyAction: req.query.success || null,
            notifyNama: req.query.nama || null,
            notifyJam: req.query.jam || null,
          });
        },
      );
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// API: Check apakah karyawan sudah masuk hari ini (untuk menentukan form yang ditampilkan)
app.get("/api/check-presensi", async (req, res) => {
  const { karyawanId, tanggal, suratTugas } = req.query;
  if (!tanggal) return res.json({ status: "none" });

  try {
    if (suratTugas !== "true") {
      const check = await isHoliday(tanggal);
      if (check.isHoliday) {
        return res.json({ status: "holiday", holidayName: check.name });
      }
    }

    if (!karyawanId) return res.json({ status: "none" });

    db.get(
      "SELECT id, jamMasuk, jamPulang FROM presensi WHERE karyawanId = ? AND tanggal = ? ORDER BY id DESC LIMIT 1",
      [karyawanId, tanggal],
      (err, row) => {
        if (err) return res.json({ status: "none" });
        if (!row) return res.json({ status: "none" });
        if (row.jamPulang)
          return res.json({
            status: "sudah_pulang",
            jamMasuk: row.jamMasuk,
            jamPulang: row.jamPulang,
          });
        return res.json({ status: "sudah_masuk", jamMasuk: row.jamMasuk });
      },
    );
  } catch (e) {
    console.error(e);
    res.json({ status: "none" });
  }
});

// API: Server-Sent Events (SSE) stream for real-time audio announcements
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch (err) {
      // client connection is already dead
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Route: Presensi Masuk (INSERT new record, time auto from server)
app.post("/presensi-masuk", async (req, res) => {
  const { karyawanId, tanggal, suratTugas } = req.body;

  if (suratTugas !== "true") {
    const check = await isHoliday(tanggal);
    if (check.isHoliday) {
      return res.redirect("/?error=holiday");
    }
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const jamMasuk = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const hari = moment(tanggal).locale("id").format("dddd");

  db.get(
    "SELECT nama FROM karyawan WHERE id = ?",
    [karyawanId],
    (errK, kRow) => {
      const nama = kRow ? kRow.nama : "";
      db.run(
        "INSERT INTO presensi (karyawanId, tanggal, jamMasuk, jamPulang, pekerjaan, createdAt, updatedAt, hari, totalJam, foto) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)",
        [karyawanId, tanggal, jamMasuk, createdAt, createdAt, hari],
        (err) => {
          if (err) {
            console.error(err);
            return res.status(500).send("Error saving data");
          }
          sendSseEvent({
            type: "presensi",
            action: "masuk",
            nama: nama,
            jam: jamMasuk.substring(0, 5),
            timestamp: Date.now(),
          });
          res.redirect(
            `/?success=masuk&nama=${encodeURIComponent(nama)}&jam=${encodeURIComponent(jamMasuk.substring(0, 5))}`,
          );
        },
      );
    },
  );
});

// Route: Presensi Pulang (UPDATE existing masuk record)
app.post("/presensi-pulang", async (req, res) => {
  const { karyawanId, tanggal, pekerjaan, foto, suratTugas } = req.body;

  if (suratTugas !== "true") {
    const check = await isHoliday(tanggal);
    if (check.isHoliday) {
      return res.redirect("/?error=holiday");
    }
  }

  const now = new Date();
  const updatedAt = now.toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const jamPulang = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // Find existing masuk record for this karyawan+tanggal that hasn't checked out
  db.get(
    "SELECT * FROM presensi WHERE karyawanId = ? AND tanggal = ? AND jamPulang IS NULL ORDER BY id DESC LIMIT 1",
    [karyawanId, tanggal],
    (err, existing) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Error");
      }
      if (!existing) {
        // Check if already checked out
        db.get(
          "SELECT id FROM presensi WHERE karyawanId = ? AND tanggal = ? AND jamPulang IS NOT NULL LIMIT 1",
          [karyawanId, tanggal],
          (e, row) => {
            return res.redirect(
              row ? "/?error=sudah_pulang" : "/?error=notfound",
            );
          },
        );
        return;
      }

      // Calculate duration (HH:MM:SS format)
      const [hM, mM] = existing.jamMasuk.split(":").map(Number);
      const [hA, mA] = jamPulang.split(":").map(Number);
      const totalMins = hA * 60 + mA - (hM * 60 + mM);

      const isOvertime = totalMins > 480;
      const displayMins = isOvertime ? 480 : totalMins;
      let totalJamStr = "";
      if (displayMins > 0) {
        const h = Math.floor(displayMins / 60);
        const m = displayMins % 60;
        if (h > 0) totalJamStr += `${h} Jam `;
        if (m > 0) totalJamStr += `${m} Menit`;
      }
      if (!totalJamStr) totalJamStr = "0 Menit";

      // Save Base64 to physical file if present
      let fotoPath = null;
      if (foto) {
        try {
          // Delete old photo if it exists
          if (existing.foto && existing.foto.startsWith("/uploads/")) {
            const oldFilepath = path.join(__dirname, existing.foto);
            if (fs.existsSync(oldFilepath)) {
              fs.unlinkSync(oldFilepath);
            }
          }
          fotoPath = saveBase64Image(foto, existing.id);
        } catch (e) {
          console.error("Gagal memproses foto bukti kehadiran:", e);
        }
      }

      db.run(
        "UPDATE presensi SET jamPulang = ?, pekerjaan = ?, foto = ?, totalJam = ?, updatedAt = ? WHERE id = ?",
        [
          jamPulang,
          pekerjaan || "",
          fotoPath || existing.foto || null,
          totalJamStr.trim(),
          updatedAt,
          existing.id,
        ],
        (err) => {
          if (err) {
            console.error(err);
            return res.status(500).send("Error");
          }

          db.get(
            "SELECT nama FROM karyawan WHERE id = ?",
            [karyawanId],
            (errK, kRow) => {
              const nama = kRow ? kRow.nama : "";
              const redirectUrl = `/?success=pulang&nama=${encodeURIComponent(nama)}&jam=${encodeURIComponent(jamPulang.substring(0, 5))}`;

              sendSseEvent({
                type: "presensi",
                action: "pulang",
                nama: nama,
                jam: jamPulang.substring(0, 5),
                timestamp: Date.now(),
              });

              if (isOvertime) {
                const excessMins = totalMins - 480;
                db.run(
                  "INSERT INTO overtime (karyawanId, presensiId, tanggal, durasiMenit, sisaMenit, keterangan, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'Lembur otomatis (kelebihan jam kerja harian)', ?, ?)",
                  [
                    karyawanId,
                    existing.id,
                    tanggal,
                    excessMins,
                    excessMins,
                    updatedAt,
                    updatedAt,
                  ],
                  (errOt) => {
                    if (errOt) {
                      console.error("Gagal mencatat overtime otomatis:", errOt);
                    }
                    res.redirect(redirectUrl);
                  },
                );
              } else {
                res.redirect(redirectUrl);
              }
            },
          );
        },
      );
    },
  );
});

// Route: Daftar Kehadiran
app.get("/daftar-kehadiran", async (req, res) => {
  try {
    const karyawanList = await getStudentStaff();
    const filterNama = req.query.filterNama || "all";
    let filterTanggalMulai = req.query.filterTanggalMulai;
    let filterTanggalSelesai = req.query.filterTanggalSelesai;
    const isManualFilter = !!(filterTanggalMulai || filterTanggalSelesai);

    // If both date filters are missing or empty, default to current pay period
    if (!filterTanggalMulai && !filterTanggalSelesai) {
      const todayStr = moment().format("YYYY-MM-DD");
      const currentPeriodMonth = getPeriodMonthStr(todayStr);
      const bounds = await getActualPeriodBounds(currentPeriodMonth);
      filterTanggalMulai = bounds.startDate;
      filterTanggalSelesai = bounds.endDate;
    } else {
      filterTanggalMulai = filterTanggalMulai || "";
      filterTanggalSelesai = filterTanggalSelesai || "";
    }

    let query =
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE 1=1";
    let params = [];

    if (filterNama !== "all") {
      query += " AND p.karyawanId = ?";
      params.push(filterNama);
    }
    if (filterTanggalMulai) {
      query += " AND p.tanggal >= ?";
      params.push(filterTanggalMulai);
    }
    if (filterTanggalSelesai) {
      query += " AND p.tanggal <= ?";
      params.push(filterTanggalSelesai);
    }

    query += " ORDER BY p.tanggal DESC, p.id DESC";

    db.all(query, params, async (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Internal Server Error");
      }

      try {
        const filteredRows = rows; // Remove holiday filtering because Surat Tugas can be on holidays

        const presensi = filteredRows.map((r) => ({
          ...r,
          formattedHari:
            r.hari || moment(r.tanggal).locale("id").format("dddd"),
          formattedDate: moment(r.tanggal).locale("id").format("DD MMM YYYY"),
          totalJamStr: r.totalJam || "",
        }));

        res.render("daftar-kehadiran", {
          karyawanList,
          presensi,
          filterNama,
          filterTanggalMulai,
          filterTanggalSelesai,
          pdfStartDate: filterTanggalMulai || "",
          pdfEndDate: filterTanggalSelesai || "",
          moment,
          success:
            req.query.success === "deleted"
              ? "Data berhasil dihapus"
              : req.query.success === "edited"
                ? "Data berhasil diperbarui"
                : undefined,
        });
      } catch (innerErr) {
        console.error(innerErr);
        res.status(500).send("Internal Server Error");
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Route: Edit Data
app.post("/edit", (req, res) => {
  const { id, tanggal, jamMasuk, jamPulang, pekerjaan, returnUrl } = req.body;
  const updatedAt = new Date().toISOString();
  const hari = moment(tanggal).locale("id").format("dddd");

  db.get("SELECT * FROM presensi WHERE id = ?", [id], (err, existing) => {
    if (err || !existing) {
      console.error("Gagal mendapatkan data presensi:", err);
      return res.redirect(`${returnUrl || "/daftar-kehadiran"}?error=notfound`);
    }

    const karyawanId = existing.karyawanId;
    const menitTambahan = existing.menitTambahan || 0;

    const [hM, mM] = jamMasuk.split(":").map(Number);
    const [hA, mA] = jamPulang.split(":").map(Number);
    const totalMins = hA * 60 + mA - (hM * 60 + mM);

    const isOvertime = totalMins > 480;
    const excessMins = isOvertime ? totalMins - 480 : 0;
    const baseMins = isOvertime ? 480 : totalMins;

    // Total displayed duration includes menitTambahan
    const displayMins = Math.min(480, baseMins + menitTambahan);
    let totalJamStr = "";
    if (displayMins > 0) {
      const h = Math.floor(displayMins / 60);
      const m = displayMins % 60;
      if (h > 0) totalJamStr += `${h} Jam `;
      if (m > 0) totalJamStr += `${m} Menit`;
    }
    if (!totalJamStr) totalJamStr = "0 Menit";
    const totalJam = totalJamStr.trim();

    db.run(
      "UPDATE presensi SET tanggal = ?, jamMasuk = ?, jamPulang = ?, pekerjaan = ?, hari = ?, totalJam = ?, updatedAt = ? WHERE id = ?",
      [tanggal, jamMasuk, jamPulang, pekerjaan, hari, totalJam, updatedAt, id],
      (err) => {
        if (err) {
          console.error(err);
          return res.redirect(`${returnUrl || "/daftar-kehadiran"}?error=db`);
        }

        // Adjust or create overtime record
        db.get(
          "SELECT * FROM overtime WHERE presensiId = ?",
          [id],
          (errOt, ot) => {
            if (errOt) console.error(errOt);

            if (ot) {
              if (excessMins > 0) {
                // Update existing overtime record
                const diff = excessMins - ot.durasiMenit;
                const newSisa = Math.max(0, ot.sisaMenit + diff); // adjust sisaMenit by the difference
                db.run(
                  "UPDATE overtime SET tanggal = ?, durasiMenit = ?, sisaMenit = ?, updatedAt = ? WHERE id = ?",
                  [tanggal, excessMins, newSisa, updatedAt, ot.id],
                  (errUpd) => {
                    if (errUpd)
                      console.error("Error updating overtime:", errUpd);
                    res.redirect(
                      `${returnUrl || "/daftar-kehadiran"}?success=edited`,
                    );
                  },
                );
              } else {
                // Excess is 0 now. Delete overtime record and transfers
                db.run(
                  "DELETE FROM overtime_transfer WHERE overtimeId = ?",
                  [ot.id],
                  (errDelT) => {
                    if (errDelT) console.error(errDelT);
                    db.run(
                      "DELETE FROM overtime WHERE id = ?",
                      [ot.id],
                      (errDel) => {
                        if (errDel) console.error(errDel);
                        res.redirect(
                          `${returnUrl || "/daftar-kehadiran"}?success=edited`,
                        );
                      },
                    );
                  },
                );
              }
            } else {
              if (excessMins > 0) {
                // Create new overtime record
                db.run(
                  "INSERT INTO overtime (karyawanId, presensiId, tanggal, durasiMenit, sisaMenit, keterangan, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'Lembur otomatis (kelebihan jam kerja harian dari edit)', ?, ?)",
                  [
                    karyawanId,
                    id,
                    tanggal,
                    excessMins,
                    excessMins,
                    updatedAt,
                    updatedAt,
                  ],
                  (errIns) => {
                    if (errIns)
                      console.error("Error inserting overtime:", errIns);
                    res.redirect(
                      `${returnUrl || "/daftar-kehadiran"}?success=edited`,
                    );
                  },
                );
              } else {
                res.redirect(
                  `${returnUrl || "/daftar-kehadiran"}?success=edited`,
                );
              }
            }
          },
        );
      },
    );
  });
});

// Route: Delete Data
app.post("/delete", (req, res) => {
  const { id, returnUrl } = req.body;

  // Fetch photo path to delete physical file if exists
  db.get("SELECT foto FROM presensi WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("Gagal mengambil data foto untuk dihapus:", err);
    } else if (row && row.foto && row.foto.startsWith("/uploads/")) {
      const filepath = path.join(__dirname, row.foto);
      if (fs.existsSync(filepath)) {
        try {
          fs.unlinkSync(filepath);
        } catch (unlinkErr) {
          console.error(
            "Gagal menghapus file foto dari disk:",
            unlinkErr.message,
          );
        }
      }
    }

    db.run(
      "DELETE FROM overtime_transfer WHERE presensiId = ? OR overtimeId IN (SELECT id FROM overtime WHERE presensiId = ?)",
      [id, id],
      (err1) => {
        if (err1) console.error("Error deleting transfers:", err1);
        db.run("DELETE FROM overtime WHERE presensiId = ?", [id], (err2) => {
          if (err2) console.error("Error deleting overtime:", err2);
          db.run("DELETE FROM presensi WHERE id = ?", [id], (err) => {
            if (err) console.error(err);
            res.redirect(`${returnUrl || "/daftar-kehadiran"}?success=deleted`);
          });
        });
      },
    );
  });
});

// Route: Riwayat Bulanan
app.get("/riwayat-bulanan", async (req, res) => {
  db.all("SELECT * FROM presensi", async (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Internal Server Error");
    }

    const filteredRows = rows;

    const grouped = filteredRows.reduce((acc, curr) => {
      const monthStr = getPeriodMonthStr(curr.tanggal);
      if (!acc[monthStr]) {
        acc[monthStr] = {
          monthStr: monthStr,
          totalKehadiran: 0,
          karyawanUnik: new Set(),
        };
      }
      acc[monthStr].totalKehadiran += 1;
      acc[monthStr].karyawanUnik.add(curr.karyawanId);
      return acc;
    }, {});

    const groupedData = await Promise.all(
      Object.values(grouped)
        .sort((a, b) => b.monthStr.localeCompare(a.monthStr))
        .map(async (d) => {
          const [year, month] = d.monthStr.split("-");
          const formattedRange = await getPeriodRangeString(d.monthStr);
          return {
            ...d,
            karyawanUnik: d.karyawanUnik.size,
            monthName: `${monthNames[parseInt(month, 10) - 1]} ${year}`,
            formattedRange,
          };
        }),
    );

    res.render("riwayat-bulanan", { groupedData });
  });
});

// Route: Detail Bulanan
app.get("/detail-bulanan", async (req, res) => {
  try {
    const monthStr = req.query.month;
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      return res.redirect("/riwayat-bulanan");
    }

    const { startDate, endDate } = await getActualPeriodBounds(monthStr);

    const [yearStr, mStr] = monthStr.split("-");
    const monthName = `${monthNames[parseInt(mStr, 10) - 1]} ${yearStr}`;
    const formattedRange = await getPeriodRangeString(monthStr);

    const karyawanList = await getStudentStaff();
    const filterNama = req.query.filterNama || "all";

    let query =
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.tanggal >= ? AND p.tanggal <= ?";
    let params = [startDate, endDate];

    if (filterNama !== "all") {
      query += " AND p.karyawanId = ?";
      params.push(filterNama);
    }

    query += " ORDER BY p.tanggal DESC, p.id DESC";

    db.all(query, params, async (err, rows) => {
      if (err) throw err;

      const filteredRows = rows;

      const presensi = filteredRows.map((r) => ({
        ...r,
        formattedHari: r.hari || moment(r.tanggal).locale("id").format("dddd"),
        formattedDate: moment(r.tanggal).locale("id").format("DD MMM YYYY"),
        totalJamStr: r.totalJam || "",
      }));

      res.render("detail-bulanan", {
        monthStr,
        monthName,
        formattedRange,
        karyawanList,
        presensi,
        filterNama,
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
}); // Route: Export PDF (Print A4)
app.get("/export-pdf", async (req, res) => {
  try {
    const filterNama = req.query.filterNama || "";
    // Support both legacy ?month=YYYY-MM and new ?startDate=...&endDate=...
    const startDateParam = req.query.startDate || "";
    const endDateParam = req.query.endDate || "";
    const monthStr = req.query.month || "";

    if (!filterNama || filterNama === "all") {
      return res.status(400).send("Parameter filterNama wajib diisi");
    }
    if (!startDateParam && !endDateParam && !monthStr) {
      return res
        .status(400)
        .send("Parameter startDate/endDate atau month wajib diisi");
    }

    const karyawanList = await getStudentStaff();
    const karyawan = karyawanList.find((x) => x.id == filterNama);
    if (!karyawan) {
      return res.status(404).send("Karyawan tidak ditemukan");
    }

    const isManualFilter = !!(startDateParam && endDateParam);
    let startDate, endDate, formattedRange;

    if (startDateParam && endDateParam) {
      // Use the directly provided date range
      startDate = startDateParam;
      endDate = endDateParam;
      const startMoment = moment(startDate, "YYYY-MM-DD");
      const endMoment = moment(endDate, "YYYY-MM-DD");
      formattedRange = `${startMoment.locale("id").format("D MMMM")} – ${endMoment.locale("id").format("D MMMM YYYY")}`;
    } else {
      // Legacy: derive from monthStr
      const bounds = await getActualPeriodBounds(monthStr);
      startDate = bounds.startDate;
      endDate = bounds.endDate;
      formattedRange = `${bounds.startMoment.locale("id").format("D MMMM")} – ${bounds.endMoment.locale("id").format("D MMMM YYYY")}`;
    }

    db.all(
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.karyawanId = ? AND p.tanggal >= ? AND p.tanggal <= ? AND p.jamMasuk IS NOT NULL AND p.jamMasuk != '' AND p.jamPulang IS NOT NULL AND p.jamPulang != '' ORDER BY p.tanggal ASC, p.id ASC",
      [filterNama, startDate, endDate],
      async (err, rows) => {
        if (err) throw err;

        const filteredRows = rows;

        let totalMinutes = 0;

        const presensi = await Promise.all(
          filteredRows.map(async (r) => {
            const [hM, mM] = r.jamMasuk.split(":").map(Number);
            const [hA, mA] = r.jamPulang.split(":").map(Number);

            const pukulStr = `${r.jamMasuk.replace(":", ".")} s/d ${r.jamPulang.replace(":", ".")}`;
            const check = await isHoliday(r.tanggal);

            return {
              ...r,
              formattedDateWithDay: moment(r.tanggal)
                .locale("id")
                .format("dddd, D MMMM YYYY"),
              pukulStr,
              totalJam: r.totalJam || "",
              isSuratTugas: check.isHoliday,
              mins: hA * 60 + mA - (hM * 60 + mM),
            };
          }),
        );

        presensi.forEach((p) => {
          const totalJamStr = p.totalJam || "";
          const hourMatch = totalJamStr.match(/(\d+)\s*Jam/i);
          const minMatch = totalJamStr.match(/(\d+)\s*Menit/i);
          let minutes = 0;
          if (hourMatch) {
            minutes += parseInt(hourMatch[1], 10) * 60;
          }
          if (minMatch) {
            minutes += parseInt(minMatch[1], 10);
          }
          totalMinutes += minutes;
        });

        const totalHours = Math.floor(totalMinutes / 60);
        const totalRemainingMins = totalMinutes % 60;
        let totalDurasiStr = "";
        if (totalHours > 0) totalDurasiStr += `${totalHours} Jam `;
        if (totalRemainingMins > 0)
          totalDurasiStr += `${totalRemainingMins} Menit`;
        if (!totalDurasiStr) totalDurasiStr = "0 Jam";
        totalDurasiStr = totalDurasiStr.trim();

        res.render("presensi-pdf", {
          karyawanName: karyawan.nama,
          monthStr: monthStr || startDate.substring(0, 7),
          formattedRange,
          presensi,
          totalDurasiStr,
        });
      },
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// ==========================================
// OVERTIME (LEMBUR) ROUTES
// ==========================================

// Route: Overtime Dashboard
app.get("/overtime", async (req, res) => {
  try {
    const karyawanList = await getStudentStaff();
    const filterNama = req.query.filterNama || "all";

    // Default date to current pay period (same logic as /daftar-kehadiran)
    let filterTanggalMulai = req.query.filterTanggalMulai;
    let filterTanggalSelesai = req.query.filterTanggalSelesai;
    if (!filterTanggalMulai && !filterTanggalSelesai) {
      const todayStr = moment().format("YYYY-MM-DD");
      const currentPeriodMonth = getPeriodMonthStr(todayStr);
      const bounds = await getActualPeriodBounds(currentPeriodMonth);
      filterTanggalMulai = bounds.startDate;
      filterTanggalSelesai = bounds.endDate;
    } else {
      filterTanggalMulai = filterTanggalMulai || "";
      filterTanggalSelesai = filterTanggalSelesai || "";
    }

    // Stats (all-time, unfiltered)
    db.all(
      "SELECT durasiMenit, sisaMenit FROM overtime",
      (errStats, otStats) => {
        if (errStats) console.error(errStats);
        let totalMenit = 0;
        let totalSisa = 0;
        if (otStats) {
          otStats.forEach((o) => {
            totalMenit += o.durasiMenit;
            totalSisa += o.sisaMenit;
          });
        }
        const totalTerpakai = totalMenit - totalSisa;
        const stats = {
          totalMenit,
          totalSisa,
          totalTerpakai,
          totalJamGenerated: (totalMenit / 60).toFixed(1),
          totalJamSisa: (totalSisa / 60).toFixed(1),
          totalJamTerpakai: (totalTerpakai / 60).toFixed(1),
        };

        // Overtime records – filtered by nama and date range
        let otQuery =
          "SELECT o.*, k.nama FROM overtime o JOIN karyawan k ON o.karyawanId = k.id WHERE 1=1";
        const otParams = [];
        if (filterNama !== "all") {
          otQuery += " AND o.karyawanId = ?";
          otParams.push(filterNama);
        }
        if (filterTanggalMulai) {
          otQuery += " AND o.tanggal >= ?";
          otParams.push(filterTanggalMulai);
        }
        if (filterTanggalSelesai) {
          otQuery += " AND o.tanggal <= ?";
          otParams.push(filterTanggalSelesai);
        }
        otQuery += " ORDER BY o.tanggal DESC, o.id DESC";

        db.all(otQuery, otParams, (errRecords, overtimeRecords) => {
          if (errRecords) console.error(errRecords);

          // Under-hours presences (for transfer modal dropdown – always unfiltered by date)
          db.all(
            "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.jamMasuk IS NOT NULL AND p.jamPulang IS NOT NULL AND p.jamPulang != '' ORDER BY p.tanggal DESC, p.id DESC",
            async (errPres, allPres) => {
              if (errPres) console.error(errPres);

              const underHoursPresences = [];
              if (allPres) {
                for (const p of allPres) {
                  const [hM, mM] = p.jamMasuk.split(":").map(Number);
                  const [hA, mA] = p.jamPulang.split(":").map(Number);
                  const totalMins = hA * 60 + mA - (hM * 60 + mM);
                  const currentWorked = totalMins + (p.menitTambahan || 0);
                  if (currentWorked < 480) {
                    const check = await isHoliday(p.tanggal);
                    if (!check.isHoliday) {
                      underHoursPresences.push({
                        ...p,
                        totalMins,
                        formattedDate: moment(p.tanggal)
                          .locale("id")
                          .format("DD MMM YYYY"),
                        formattedHari:
                          p.hari ||
                          moment(p.tanggal).locale("id").format("dddd"),
                      });
                    }
                  }
                }
              }

              // Get unique months from overtime records
              const uniqueMonths = new Set();
              if (overtimeRecords) {
                overtimeRecords.forEach((r) => {
                  if (r.tanggal) {
                    uniqueMonths.add(r.tanggal.substring(0, 7)); // "YYYY-MM"
                  }
                });
              }
              // Always include current month
              uniqueMonths.add(moment().format("YYYY-MM"));

              db.all(
                "SELECT karyawanId, tanggal FROM presensi",
                async (errAllPres, allAttendance) => {
                  if (errAllPres) console.error(errAllPres);

                  const attendanceMap = {};
                  if (allAttendance) {
                    allAttendance.forEach((a) => {
                      if (!attendanceMap[a.karyawanId]) {
                        attendanceMap[a.karyawanId] = new Set();
                      }
                      attendanceMap[a.karyawanId].add(a.tanggal);
                    });
                  }

                  const absentDatesList = [];
                  const holidayCache = {};

                  for (const monthStr of uniqueMonths) {
                    const startMoment = moment(monthStr + "-01", "YYYY-MM-DD");
                    const endMoment = moment(startMoment).endOf("month");

                    const datesInMonth = [];
                    let curr = moment(startMoment);
                    while (curr.isBefore(endMoment) || curr.isSame(endMoment)) {
                      datesInMonth.push(curr.format("YYYY-MM-DD"));
                      curr.add(1, "days");
                    }

                    for (const date of datesInMonth) {
                      const d = new Date(date);
                      const day = d.getDay();
                      if (day === 0 || day === 6) continue;

                      let isLibur = holidayCache[date];
                      if (isLibur === undefined) {
                        const check = await isHoliday(date);
                        isLibur = check.isHoliday;
                        holidayCache[date] = isLibur;
                      }
                      if (isLibur) continue;

                      for (const k of karyawanList) {
                        const attended =
                          attendanceMap[k.id] && attendanceMap[k.id].has(date);
                        if (!attended) {
                          absentDatesList.push({
                            karyawanId: k.id,
                            tanggal: date,
                            formattedDate: moment(date)
                              .locale("id")
                              .format("DD MMM YYYY"),
                            formattedHari: moment(date)
                              .locale("id")
                              .format("dddd"),
                            totalMins: 0,
                            menitTambahan: 0,
                            isAbsent: true,
                          });
                        }
                      }
                    }
                  }

                  // Transfer history – filtered by nama + target presensi date range
                  let histQuery = `SELECT t.*, k.nama as namaKaryawan, p.tanggal as tanggalTarget,
                p.totalJam as totalJamTarget, o.tanggal as tanggalSumber
                FROM overtime_transfer t
                JOIN karyawan k ON t.karyawanId = k.id
                JOIN presensi p ON t.presensiId = p.id
                JOIN overtime o ON t.overtimeId = o.id
                WHERE 1=1`;
                  const histParams = [];
                  if (filterNama !== "all") {
                    histQuery += " AND t.karyawanId = ?";
                    histParams.push(filterNama);
                  }
                  if (filterTanggalMulai) {
                    histQuery += " AND p.tanggal >= ?";
                    histParams.push(filterTanggalMulai);
                  }
                  if (filterTanggalSelesai) {
                    histQuery += " AND p.tanggal <= ?";
                    histParams.push(filterTanggalSelesai);
                  }
                  histQuery += " ORDER BY t.createdAt DESC";

                  db.all(histQuery, histParams, (errHist, transferHistory) => {
                    if (errHist) console.error(errHist);

                    res.render("overtime", {
                      path: "/overtime",
                      stats,
                      overtimeRecords: overtimeRecords || [],
                      underHoursPresences,
                      absentDatesList,
                      transferHistory: transferHistory || [],
                      karyawanList,
                      moment,
                      filterNama,
                      filterTanggalMulai,
                      filterTanggalSelesai,
                      pdfStartDate: filterTanggalMulai || "",
                      pdfEndDate: filterTanggalSelesai || "",
                      success:
                        req.query.success === "transferred"
                          ? "Saldo lembur berhasil dialokasikan!"
                          : req.query.success === "edited"
                            ? "Saldo lembur berhasil diperbarui!"
                            : req.query.success === "deleted"
                              ? "Data lembur berhasil dihapus!"
                              : undefined,
                      error:
                        req.query.error === "invalid_transfer"
                          ? "Jumlah transfer tidak valid atau melebihi sisa saldo lembur."
                          : req.query.error === "target_exceeded"
                            ? "Jumlah jam target tidak boleh melebihi batas 8 jam kerja."
                            : req.query.error === "db"
                              ? "Terjadi kesalahan pada database."
                              : undefined,
                    });
                  });
                },
              );
            },
          );
        });
      },
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Route: Export Overtime PDF (only transfer history, filtered by nama + date range)
app.get("/overtime/pdf", async (req, res) => {
  try {
    const karyawanList = await getStudentStaff();
    const filterNama = req.query.filterNama || "all";

    // Default date to current pay period if not provided
    let filterTanggalMulai = req.query.filterTanggalMulai;
    let filterTanggalSelesai = req.query.filterTanggalSelesai;
    if (!filterTanggalMulai && !filterTanggalSelesai) {
      const todayStr = moment().format("YYYY-MM-DD");
      const currentPeriodMonth = getPeriodMonthStr(todayStr);
      const bounds = await getActualPeriodBounds(currentPeriodMonth);
      filterTanggalMulai = bounds.startDate;
      filterTanggalSelesai = bounds.endDate;
    } else {
      filterTanggalMulai = filterTanggalMulai || "";
      filterTanggalSelesai = filterTanggalSelesai || "";
    }

    db.all(
      "SELECT durasiMenit, sisaMenit FROM overtime",
      (errStats, otStats) => {
        if (errStats) console.error(errStats);
        let totalMenit = 0;
        let totalSisa = 0;
        if (otStats) {
          otStats.forEach((o) => {
            totalMenit += o.durasiMenit;
            totalSisa += o.sisaMenit;
          });
        }
        const totalTerpakai = totalMenit - totalSisa;
        const stats = {
          totalMenit,
          totalSisa,
          totalTerpakai,
          totalJamGenerated: (totalMenit / 60).toFixed(1),
          totalJamSisa: (totalSisa / 60).toFixed(1),
          totalJamTerpakai: (totalTerpakai / 60).toFixed(1),
        };

        // Build overtime query with optional name filter
        let otQuery =
          "SELECT o.*, k.nama FROM overtime o JOIN karyawan k ON o.karyawanId = k.id";
        const otParams = [];
        if (filterNama !== "all") {
          otQuery += " WHERE o.karyawanId = ?";
          otParams.push(filterNama);
        }
        otQuery += " ORDER BY o.tanggal DESC, o.id DESC";

        db.all(otQuery, otParams, (errRecords, overtimeRecords) => {
          if (errRecords) console.error(errRecords);

          // Build transfer history query with optional filters
          let histQuery = `SELECT t.*, k.nama as namaKaryawan, p.tanggal as tanggalTarget,
          p.totalJam as totalJamTarget, o.tanggal as tanggalSumber
          FROM overtime_transfer t
          JOIN karyawan k ON t.karyawanId = k.id
          JOIN presensi p ON t.presensiId = p.id
          JOIN overtime o ON t.overtimeId = o.id
          WHERE 1=1`;
          const histParams = [];

          if (filterNama !== "all") {
            histQuery += " AND t.karyawanId = ?";
            histParams.push(filterNama);
          }
          if (filterTanggalMulai) {
            histQuery += " AND p.tanggal >= ?";
            histParams.push(filterTanggalMulai);
          }
          if (filterTanggalSelesai) {
            histQuery += " AND p.tanggal <= ?";
            histParams.push(filterTanggalSelesai);
          }
          histQuery += " ORDER BY t.createdAt DESC";

          db.all(histQuery, histParams, (errHist, transferHistory) => {
            if (errHist) console.error(errHist);

            // Resolve filterNama to a name string
            let filterNamaLabel = "Semua Karyawan";
            if (filterNama !== "all") {
              const found = karyawanList.find(
                (k) => String(k.id) === String(filterNama),
              );
              if (found) filterNamaLabel = found.nama;
            }

            res.render("overtime-pdf", {
              stats,
              overtimeRecords: overtimeRecords || [],
              transferHistory: transferHistory || [],
              karyawanList,
              moment,
              filterNama,
              filterNamaLabel,
              filterTanggalMulai,
              filterTanggalSelesai,
            });
          });
        });
      },
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Route: Transfer Overtime to Presence Record
app.post("/overtime/transfer", (req, res) => {
  const {
    overtimeId,
    presensiId,
    absentDateId,
    alokasikanHariCuti,
    durasiMenitTransfer,
    pekerjaan,
    foto,
  } = req.body;
  const isAbsentTransfer = alokasikanHariCuti === "true";
  const targetId = isAbsentTransfer ? absentDateId : presensiId;
  const transferMins = parseInt(durasiMenitTransfer, 10);
  const nowStr = new Date().toISOString();
  const todayDateStr = moment().format("YYYY-MM-DD");

  if (!overtimeId || !targetId || isNaN(transferMins) || transferMins <= 0) {
    return res.redirect("/overtime?error=invalid_transfer");
  }

  if (isAbsentTransfer) {
    if (transferMins > 240) {
      return res.redirect("/overtime?error=invalid_transfer");
    }
    if (!pekerjaan || !pekerjaan.trim() || !foto) {
      return res.redirect("/overtime?error=invalid_transfer");
    }
  }

  // Fetch source overtime
  db.get("SELECT * FROM overtime WHERE id = ?", [overtimeId], (errOt, ot) => {
    if (errOt || !ot) {
      console.error(errOt);
      return res.redirect("/overtime?error=db");
    }

    if (ot.sisaMenit < transferMins) {
      return res.redirect("/overtime?error=invalid_transfer");
    }

    const proceedWithTarget = (target) => {
      if (target.karyawanId !== ot.karyawanId) {
        return res.redirect("/overtime?error=invalid_transfer");
      }

      // Calculate current total
      const isAbsentTarget = target.jamMasuk === "08:30";
      const [hM, mM] = target.jamMasuk.split(":").map(Number);
      const [hA, mA] = target.jamPulang.split(":").map(Number);
      const baseMins = isAbsentTarget ? 0 : hA * 60 + mA - (hM * 60 + mM);
      const currentMenitTambahan = target.menitTambahan || 0;

      const maxLimit = isAbsentTransfer || isAbsentTarget ? 240 : 480;
      if (baseMins + currentMenitTambahan + transferMins > maxLimit) {
        return res.redirect("/overtime?error=target_exceeded");
      }

      const newSisa = ot.sisaMenit - transferMins;
      const newMenitTambahan = currentMenitTambahan + transferMins;

      // Calculate new totalJam string
      const newDisplayMins = Math.min(maxLimit, baseMins + newMenitTambahan);
      let totalJamStr = "";
      if (newDisplayMins > 0) {
        const h = Math.floor(newDisplayMins / 60);
        const m = newDisplayMins % 60;
        if (h > 0) totalJamStr += `${h} Jam `;
        if (m > 0) totalJamStr += `${m} Menit`;
      }
      if (!totalJamStr) totalJamStr = "0 Menit";
      const totalJam = totalJamStr.trim();

      // Perform updates
      db.serialize(() => {
        // 1. Update overtime sisaMenit
        db.run(
          "UPDATE overtime SET sisaMenit = ?, updatedAt = ? WHERE id = ?",
          [newSisa, nowStr, ot.id],
        );

        // 2. Update target presensi menitTambahan, totalJam & jamMasuk, jamPulang
        if (isAbsentTransfer || isAbsentTarget) {
          const jamMasuk = "08:30";
          const jamPulang = calculateEndTime(jamMasuk, newMenitTambahan);
          db.run(
            "UPDATE presensi SET menitTambahan = ?, totalJam = ?, jamMasuk = ?, jamPulang = ?, updatedAt = ? WHERE id = ?",
            [
              newMenitTambahan,
              totalJam,
              jamMasuk,
              jamPulang,
              nowStr,
              target.id,
            ],
          );
        } else {
          db.run(
            "UPDATE presensi SET menitTambahan = ?, totalJam = ?, updatedAt = ? WHERE id = ?",
            [newMenitTambahan, totalJam, nowStr, target.id],
          );
        }

        // 3. Insert into overtime_transfer
        const ket = `Alokasi lembur tanggal ${moment(ot.tanggal).format("DD/MM/YYYY")} ke presensi tanggal ${moment(target.tanggal).format("DD/MM/YYYY")}`;
        db.run(
          "INSERT INTO overtime_transfer (karyawanId, overtimeId, presensiId, tanggalTransfer, durasiMenit, keterangan, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            ot.karyawanId,
            ot.id,
            target.id,
            todayDateStr,
            transferMins,
            ket,
            nowStr,
          ],
          (errFinal) => {
            if (errFinal) {
              console.error(errFinal);
              return res.redirect("/overtime?error=db");
            }
            res.redirect("/overtime?success=transferred");
          },
        );
      });
    };

    if (typeof targetId === "string" && targetId.startsWith("new_date:")) {
      const targetDate = targetId.substring("new_date:".length);
      // Check if presence already exists (safeguard)
      db.get(
        "SELECT * FROM presensi WHERE karyawanId = ? AND tanggal = ?",
        [ot.karyawanId, targetDate],
        (errCheck, existingTarget) => {
          if (errCheck) {
            console.error(errCheck);
            return res.redirect("/overtime?error=db");
          }
          if (existingTarget) {
            if (isAbsentTransfer) {
              // Update photo and description if provided and it's an absent transfer
              let savedPhotoPath = null;
              try {
                if (foto) {
                  savedPhotoPath = saveBase64Image(foto, existingTarget.id);
                }
              } catch (imgErr) {
                console.error("Gagal menyimpan foto:", imgErr);
              }

              const updateFields = [];
              const updateParams = [];
              if (savedPhotoPath) {
                updateFields.push("foto = ?");
                updateParams.push(savedPhotoPath);
              }
              if (pekerjaan && pekerjaan.trim()) {
                updateFields.push("pekerjaan = ?");
                updateParams.push(pekerjaan.trim());
              }

              if (updateFields.length > 0) {
                updateParams.push(existingTarget.id);
                db.run(
                  `UPDATE presensi SET ${updateFields.join(", ")} WHERE id = ?`,
                  updateParams,
                  (errUpdPres) => {
                    if (errUpdPres) console.error(errUpdPres);
                    db.get(
                      "SELECT * FROM presensi WHERE id = ?",
                      [existingTarget.id],
                      (errGet, updatedTarget) => {
                        if (errGet || !updatedTarget) {
                          proceedWithTarget(existingTarget);
                        } else {
                          proceedWithTarget(updatedTarget);
                        }
                      },
                    );
                  },
                );
              } else {
                proceedWithTarget(existingTarget);
              }
            } else {
              proceedWithTarget(existingTarget);
            }
          } else {
            // Create a new presence record
            const dayName = moment(targetDate).locale("id").format("dddd");
            const newPekerjaan =
              isAbsentTransfer && pekerjaan
                ? pekerjaan.trim()
                : "Alokasi lembur";
            const initJamMasuk = isAbsentTransfer ? "08:30" : "08:00";
            const initJamPulang = isAbsentTransfer ? "08:30" : "08:00";
            db.run(
              "INSERT INTO presensi (karyawanId, tanggal, jamMasuk, jamPulang, pekerjaan, createdAt, updatedAt, hari, totalJam, menitTambahan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                ot.karyawanId,
                targetDate,
                initJamMasuk,
                initJamPulang,
                newPekerjaan,
                nowStr,
                nowStr,
                dayName,
                "0 Menit",
                0,
              ],
              function (errInsert) {
                if (errInsert) {
                  console.error(errInsert);
                  return res.redirect("/overtime?error=db");
                }
                const newPresId = this.lastID;

                let savedPhotoPath = null;
                try {
                  if (isAbsentTransfer && foto) {
                    savedPhotoPath = saveBase64Image(foto, newPresId);
                  }
                } catch (imgErr) {
                  console.error("Gagal menyimpan foto:", imgErr);
                }

                if (savedPhotoPath) {
                  db.run(
                    "UPDATE presensi SET foto = ? WHERE id = ?",
                    [savedPhotoPath, newPresId],
                    (errPhoto) => {
                      if (errPhoto) console.error(errPhoto);
                      db.get(
                        "SELECT * FROM presensi WHERE id = ?",
                        [newPresId],
                        (errGet, newTarget) => {
                          if (errGet || !newTarget) {
                            console.error(errGet);
                            return res.redirect("/overtime?error=db");
                          }
                          proceedWithTarget(newTarget);
                        },
                      );
                    },
                  );
                } else {
                  db.get(
                    "SELECT * FROM presensi WHERE id = ?",
                    [newPresId],
                    (errGet, newTarget) => {
                      if (errGet || !newTarget) {
                        console.error(errGet);
                        return res.redirect("/overtime?error=db");
                      }
                      proceedWithTarget(newTarget);
                    },
                  );
                }
              },
            );
          }
        },
      );
    } else {
      // Fetch target presence normally
      db.get(
        "SELECT * FROM presensi WHERE id = ?",
        [targetId],
        (errPres, target) => {
          if (errPres || !target) {
            console.error(errPres);
            return res.redirect("/overtime?error=db");
          }
          proceedWithTarget(target);
        },
      );
    }
  });
});

// Route: Manual Edit Overtime Balance
app.post("/overtime/edit", (req, res) => {
  const { id, sisaMenit } = req.body;
  const sisa = parseInt(sisaMenit, 10);
  const updatedAt = new Date().toISOString();

  if (!id || isNaN(sisa) || sisa < 0) {
    return res.redirect("/overtime?error=invalid_transfer");
  }

  db.get("SELECT durasiMenit FROM overtime WHERE id = ?", [id], (err, row) => {
    if (err || !row) {
      return res.redirect("/overtime?error=db");
    }

    if (sisa > row.durasiMenit) {
      return res.redirect("/overtime?error=invalid_transfer");
    }

    db.run(
      "UPDATE overtime SET sisaMenit = ?, updatedAt = ? WHERE id = ?",
      [sisa, updatedAt, id],
      (errUpd) => {
        if (errUpd) {
          console.error(errUpd);
          return res.redirect("/overtime?error=db");
        }
        res.redirect("/overtime?success=edited");
      },
    );
  });
});

// Route: Delete Overtime Record
app.post("/overtime/delete", (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.redirect("/overtime?error=invalid_transfer");
  }

  // Get transfers first to revert target presences
  db.all(
    "SELECT * FROM overtime_transfer WHERE overtimeId = ?",
    [id],
    (errTrans, transfers) => {
      if (errTrans) console.error(errTrans);

      const revertPromises = [];
      if (transfers && transfers.length > 0) {
        transfers.forEach((t) => {
          const p = new Promise((resolve) => {
            db.get(
              "SELECT * FROM presensi WHERE id = ?",
              [t.presensiId],
              (errPres, target) => {
                if (target) {
                  const isAbsentTarget = target.jamMasuk === "08:30";
                  const [hM, mM] = target.jamMasuk.split(":").map(Number);
                  const [hA, mA] = target.jamPulang.split(":").map(Number);
                  const baseMins = isAbsentTarget
                    ? 0
                    : hA * 60 + mA - (hM * 60 + mM);
                  const newMenitTambahan = Math.max(
                    0,
                    (target.menitTambahan || 0) - t.durasiMenit,
                  );

                  const maxLimit = isAbsentTarget ? 240 : 480;
                  const newDisplayMins = Math.min(
                    maxLimit,
                    baseMins + newMenitTambahan,
                  );
                  let totalJamStr = "";
                  if (newDisplayMins > 0) {
                    const h = Math.floor(newDisplayMins / 60);
                    const m = newDisplayMins % 60;
                    if (h > 0) totalJamStr += `${h} Jam `;
                    if (m > 0) totalJamStr += `${m} Menit`;
                  }
                  if (!totalJamStr) totalJamStr = "0 Menit";
                  const totalJam = totalJamStr.trim();

                  if (baseMins === 0 && newMenitTambahan === 0) {
                    db.run(
                      "DELETE FROM presensi WHERE id = ?",
                      [target.id],
                      () => resolve(),
                    );
                  } else {
                    if (isAbsentTarget) {
                      const jamPulang = calculateEndTime(
                        "08:30",
                        newMenitTambahan,
                      );
                      db.run(
                        "UPDATE presensi SET menitTambahan = ?, totalJam = ?, jamPulang = ? WHERE id = ?",
                        [newMenitTambahan, totalJam, jamPulang, target.id],
                        () => resolve(),
                      );
                    } else {
                      db.run(
                        "UPDATE presensi SET menitTambahan = ?, totalJam = ? WHERE id = ?",
                        [newMenitTambahan, totalJam, target.id],
                        () => resolve(),
                      );
                    }
                  }
                } else {
                  resolve();
                }
              },
            );
          });
          revertPromises.push(p);
        });
      }

      Promise.all(revertPromises).then(() => {
        db.run(
          "DELETE FROM overtime_transfer WHERE overtimeId = ?",
          [id],
          (errDelT) => {
            if (errDelT) console.error(errDelT);
            db.run("DELETE FROM overtime WHERE id = ?", [id], (errDel) => {
              if (errDel) console.error(errDel);
              res.redirect("/overtime?success=deleted");
            });
          },
        );
      });
    },
  );
});

// --- STUDENT STAFF (KARYAWAN) CRUD ---

app.get("/student-staff", async (req, res) => {
  try {
    const karyawanList = await getKaryawan();
    res.render("student-staff", {
      karyawanList,
      path: "/student-staff",
      success_msg:
        req.query.success === "added"
          ? "Student Staff berhasil ditambahkan."
          : req.query.success === "edited"
            ? "Student Staff berhasil diperbarui."
            : req.query.success === "deleted"
              ? "Student Staff berhasil dihapus."
              : null,
      error_msg:
        req.query.error === "add_failed"
          ? "Gagal menambahkan Student Staff."
          : req.query.error === "edit_failed"
            ? "Gagal memperbarui Student Staff."
            : req.query.error === "delete_failed"
              ? "Gagal menghapus Student Staff."
              : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/student-staff/add", (req, res) => {
  const { nama, type, role } = req.body;
  if (!nama) return res.redirect("/student-staff?error=add_failed");
  db.run(
    "INSERT INTO karyawan (nama, type, role) VALUES (?, ?, ?)",
    [nama, type || null, role || null],
    (err) => {
      if (err) {
        console.error(err);
        return res.redirect("/student-staff?error=add_failed");
      }
      res.redirect("/student-staff?success=added");
    },
  );
});

app.post("/student-staff/edit", (req, res) => {
  const { id, nama, type, role } = req.body;
  if (!id || !nama) return res.redirect("/student-staff?error=edit_failed");
  db.run(
    "UPDATE karyawan SET nama = ?, type = ?, role = ? WHERE id = ?",
    [nama, type || null, role || null, id],
    (err) => {
      if (err) {
        console.error(err);
        return res.redirect("/student-staff?error=edit_failed");
      }
      res.redirect("/student-staff?success=edited");
    },
  );
});

app.post("/student-staff/delete", (req, res) => {
  const { id } = req.body;
  if (!id) return res.redirect("/student-staff?error=delete_failed");
  db.run("DELETE FROM karyawan WHERE id = ?", [id], (err) => {
    if (err) {
      console.error(err);
      return res.redirect("/student-staff?error=delete_failed");
    }
    res.redirect("/student-staff?success=deleted");
  });
});

// --- FACE API ROUTES ---
app.post("/api/karyawan/:id/register-face", (req, res) => {
  const { id } = req.params;
  const { descriptor } = req.body;
  if (!id || !descriptor) {
    return res.status(400).json({ error: "Missing ID or descriptor" });
  }
  const descriptorStr = JSON.stringify(descriptor);
  db.run(
    "UPDATE karyawan SET face_descriptor = ? WHERE id = ?",
    [descriptorStr, id],
    (err) => {
      if (err) {
        console.error("Gagal mendaftarkan wajah:", err);
        return res.status(500).json({ error: "Database error" });
      }
      res.json({ success: true, message: "Wajah berhasil didaftarkan!" });
    },
  );
});

app.get("/api/karyawan/faces", (req, res) => {
  db.all(
    "SELECT id, nama, face_descriptor FROM karyawan WHERE face_descriptor IS NOT NULL AND (type IS NULL OR type != 'Staf')",
    (err, rows) => {
      if (err) {
        console.error("Gagal memuat data wajah:", err);
        return res.status(500).json({ error: "Database error" });
      }
      const facesList = rows.map((r) => ({
        id: r.id,
        nama: r.nama,
        descriptor: JSON.parse(r.face_descriptor),
      }));
      res.json(facesList);
    },
  );
});

app.post("/api/karyawan/:id/delete-face", (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE karyawan SET face_descriptor = NULL WHERE id = ?",
    [id],
    (err) => {
      if (err) {
        console.error("Gagal menghapus data wajah:", err);
        return res.status(500).json({ error: "Database error" });
      }
      res.json({ success: true, message: "Data wajah berhasil dihapus." });
    },
  );
});

// --- TASK MANAGEMENT CRUD ---

app.get("/task-management", async (req, res) => {
  try {
    const karyawanList = await getKaryawan();
    db.all("SELECT * FROM workspaces ORDER BY id ASC", (errW, workspaces) => {
      if (errW) workspaces = [{ id: 1, nama: "General" }];
      db.all(
        `
        SELECT t.*, 
               GROUP_CONCAT(k.nama ORDER BY k.nama ASC SEPARATOR ', ') AS assignees,
               GROUP_CONCAT(k.id ORDER BY k.nama ASC SEPARATOR ',') AS assigneeIds
        FROM tasks t
        LEFT JOIN task_karyawan tk ON t.id = tk.taskId
        LEFT JOIN karyawan k ON tk.karyawanId = k.id
        GROUP BY t.id
        ORDER BY CASE WHEN t.status = 'Todo' THEN 1 WHEN t.status = 'On Progress' THEN 2 WHEN t.status = 'Done' THEN 3 ELSE 4 END ASC, t.order_index ASC, t.id DESC
      `,
        (err, tasks) => {
          if (err) {
            console.error(err);
            return res.status(500).send("Internal Server Error");
          }

          const tasksFormatted = tasks.map((task) => ({
            ...task,
            assigneeIds: task.assigneeIds
              ? task.assigneeIds.split(",").map(Number)
              : [],
          }));

          res.render("task-management", {
            tasks: tasksFormatted,
            karyawanList,
            workspaces: workspaces || [],
            path: "/task-management",
            success_msg:
              req.query.success === "added"
                ? "Task berhasil ditambahkan."
                : req.query.success === "edited"
                  ? "Task berhasil diperbarui."
                  : req.query.success === "deleted"
                    ? "Task berhasil dihapus."
                    : req.query.success === "ws_added"
                      ? "Workspace berhasil ditambahkan."
                      : req.query.success === "ws_edited"
                        ? "Workspace berhasil diperbarui."
                        : req.query.success === "ws_deleted"
                          ? "Workspace berhasil dihapus."
                          : null,
            error_msg:
              req.query.error === "add_failed"
                ? "Gagal menambahkan data."
                : req.query.error === "edit_failed"
                  ? "Gagal memperbarui data."
                  : req.query.error === "delete_failed"
                    ? "Gagal menghapus data."
                    : null,
            notifyAction: req.query.success || null,
            notifyTaskId: req.query.taskId || null,
            notifyStatus: req.query.toStatus || null,
          });
        },
      );
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// --- WORKSPACE CRUD ---
app.post("/workspaces/add", (req, res) => {
  const { nama } = req.body;
  if (!nama) return res.redirect("/task-management?error=add_failed");
  db.run("INSERT INTO workspaces (nama) VALUES (?)", [nama], (err) => {
    if (err) return res.redirect("/task-management?error=add_failed");
    res.redirect("/task-management?success=ws_added");
  });
});

app.post("/workspaces/edit", (req, res) => {
  const { id, nama } = req.body;
  if (!id || !nama) return res.redirect("/task-management?error=edit_failed");

  db.get("SELECT nama FROM workspaces WHERE id = ?", [id], (errG, row) => {
    if (errG || !row) return res.redirect("/task-management?error=edit_failed");
    const oldName = row.nama;
    db.run("UPDATE workspaces SET nama = ? WHERE id = ?", [nama, id], (err) => {
      if (err) return res.redirect("/task-management?error=edit_failed");
      // Update tasks that were using this workspace
      db.run(
        "UPDATE tasks SET workspace = ? WHERE workspace = ?",
        [nama, oldName],
        () => {
          res.redirect("/task-management?success=ws_edited");
        },
      );
    });
  });
});

app.post("/workspaces/delete", (req, res) => {
  const { id } = req.body;
  if (!id) return res.redirect("/task-management?error=delete_failed");

  db.get("SELECT nama FROM workspaces WHERE id = ?", [id], (errG, row) => {
    if (errG || !row)
      return res.redirect("/task-management?error=delete_failed");
    const oldName = row.nama;
    db.run("DELETE FROM workspaces WHERE id = ?", [id], (err) => {
      if (err) return res.redirect("/task-management?error=delete_failed");
      // Fallback tasks to 'General'
      db.run(
        "UPDATE tasks SET workspace = 'General' WHERE workspace = ?",
        [oldName],
        () => {
          res.redirect("/task-management?success=ws_deleted");
        },
      );
    });
  });
});

app.post("/task-management/add", (req, res) => {
  const {
    task,
    tanggal,
    deadline,
    status,
    assignees,
    foto,
    workspace,
    requester,
    source,
    priority,
    link,
  } = req.body;
  if (!task || !tanggal || !deadline || !status) {
    return res.redirect("/task-management?error=add_failed");
  }

  db.run(
    "INSERT INTO tasks (task, tanggal, deadline, status, foto, workspace, requester, source, priority, link, order_index) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0)",
    [
      task,
      tanggal,
      deadline,
      status,
      workspace || "General",
      requester || null,
      source || "Sistem",
      priority || "Low",
      link || null,
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.redirect("/task-management?error=add_failed");
      }

      const taskId = this.lastID;

      db.run(
        "UPDATE tasks SET code = CONCAT('#', LPAD(id, 4, '0')) WHERE id = ?",
        [taskId],
        (errCode) => {
          if (errCode) console.error("Error setting task code:", errCode);

          // Handle optional image
          let fotoPath = null;
          if (foto) {
            try {
              fotoPath = saveBase64Image(foto, `task_${taskId}`);
            } catch (e) {
              console.error("Gagal menyimpan foto task:", e);
            }
          }

          const proceed = () => {
            if (assignees && assignees.length > 0) {
              const assigneeIds = Array.isArray(assignees)
                ? assignees
                : [assignees];
              let insertCount = 0;
              const runInsert = () => {
                if (insertCount >= assigneeIds.length) {
                  db.all(
                    "SELECT nama FROM karyawan WHERE id IN (" +
                      assigneeIds.map(() => "?").join(",") +
                      ")",
                    assigneeIds,
                    (errK, kRows) => {
                      const namesList = kRows
                        ? kRows.map((r) => r.nama).join(", ")
                        : "";
                      const assigneeIdsList = assigneeIds.map(Number);

                      db.get(
                        "SELECT * FROM tasks WHERE id = ?",
                        [taskId],
                        (errT, tRow) => {
                          sendSseEvent({
                            type: "task",
                            action: "added",
                            task: {
                              ...tRow,
                              assignees: namesList,
                              assigneeIds: assigneeIdsList,
                            },
                            timestamp: Date.now(),
                          });
                          res.redirect(
                            `/task-management?success=added&taskId=${taskId}`,
                          );
                        },
                      );
                    },
                  );
                  return;
                }
                db.run(
                  "INSERT INTO task_karyawan (taskId, karyawanId) VALUES (?, ?)",
                  [taskId, assigneeIds[insertCount]],
                  (errTk) => {
                    if (errTk) {
                      console.error("Error inserting task_karyawan:", errTk);
                    }
                    insertCount++;
                    runInsert();
                  },
                );
              };
              runInsert();
            } else {
              db.get(
                "SELECT * FROM tasks WHERE id = ?",
                [taskId],
                (errT, tRow) => {
                  sendSseEvent({
                    type: "task",
                    action: "added",
                    task: {
                      ...tRow,
                      assignees: "",
                      assigneeIds: [],
                    },
                    timestamp: Date.now(),
                  });
                  res.redirect(
                    `/task-management?success=added&taskId=${taskId}`,
                  );
                },
              );
            }
          };

          if (fotoPath) {
            db.run(
              "UPDATE tasks SET foto = ? WHERE id = ?",
              [fotoPath, taskId],
              (errF) => {
                if (errF) console.error("Error updating task foto:", errF);
                proceed();
              },
            );
          } else {
            proceed();
          }
        },
      );
    },
  );
});

app.post("/task-management/edit", (req, res) => {
  const {
    id,
    task,
    tanggal,
    deadline,
    status,
    assignees,
    foto,
    workspace,
    requester,
    source,
    priority,
    link,
  } = req.body;
  if (!id || !task || !tanggal || !deadline || !status) {
    return res.redirect("/task-management?error=edit_failed");
  }

  // Handle optional image
  let fotoPath = null;
  if (foto) {
    try {
      fotoPath = saveBase64Image(foto, `task_${id}`);
    } catch (e) {
      console.error("Gagal menyimpan foto task:", e);
    }
  }

  db.all(
    "SELECT karyawanId FROM task_karyawan WHERE taskId = ?",
    [id],
    (errAk, akRows) => {
      const oldAssigneeIds = akRows
        ? akRows
            .map((r) => r.karyawanId)
            .sort()
            .join(",")
        : "";
      const newAssigneeIds = (
        assignees
          ? (Array.isArray(assignees) ? assignees : [assignees]).map(Number)
          : []
      )
        .sort()
        .join(",");
      const assigneesChanged = oldAssigneeIds !== newAssigneeIds;

      db.get(
        "SELECT foto FROM tasks WHERE id = ?",
        [id],
        (errG, existingTask) => {
          const finalFoto = foto
            ? fotoPath || null
            : existingTask
              ? existingTask.foto
              : null;

          db.run(
            "UPDATE tasks SET task = ?, tanggal = ?, deadline = ?, status = ?, foto = ?, workspace = ?, requester = ?, source = ?, priority = ?, link = ? WHERE id = ?",
            [
              task,
              tanggal,
              deadline,
              status,
              finalFoto,
              workspace || "General",
              requester || null,
              source || "Sistem",
              priority || "Low",
              link || null,
              id,
            ],
            (err) => {
              if (err) {
                console.error(err);
                return res.redirect("/task-management?error=edit_failed");
              }

              db.run(
                "DELETE FROM task_karyawan WHERE taskId = ?",
                [id],
                (errDel) => {
                  if (errDel) {
                    console.error(errDel);
                    return res.redirect("/task-management?error=edit_failed");
                  }

                  if (assignees && assignees.length > 0) {
                    const assigneeIds = Array.isArray(assignees)
                      ? assignees
                      : [assignees];
                    let insertCount = 0;
                    const runInsert = () => {
                      if (insertCount >= assigneeIds.length) {
                        db.all(
                          "SELECT nama FROM karyawan WHERE id IN (" +
                            assigneeIds.map(() => "?").join(",") +
                            ")",
                          assigneeIds,
                          (errK, kRows) => {
                            const namesList = kRows
                              ? kRows.map((r) => r.nama).join(", ")
                              : "";
                            const assigneeIdsList = assigneeIds.map(Number);

                            db.get(
                              "SELECT * FROM tasks WHERE id = ?",
                              [id],
                              (errT, tRow) => {
                                sendSseEvent({
                                  type: "task",
                                  action: "edited",
                                  task: {
                                    ...tRow,
                                    assignees: namesList,
                                    assigneeIds: assigneeIdsList,
                                  },
                                  assigneesChanged: assigneesChanged,
                                  timestamp: Date.now(),
                                });
                                res.redirect(
                                  `/task-management?success=edited&taskId=${id}&toStatus=${status}&assigneesChanged=${assigneesChanged}`,
                                );
                              },
                            );
                          },
                        );
                        return;
                      }
                      db.run(
                        "INSERT INTO task_karyawan (taskId, karyawanId) VALUES (?, ?)",
                        [id, assigneeIds[insertCount]],
                        (errTk) => {
                          if (errTk) {
                            console.error(
                              "Error inserting task_karyawan:",
                              errTk,
                            );
                          }
                          insertCount++;
                          runInsert();
                        },
                      );
                    };
                    runInsert();
                  } else {
                    db.get(
                      "SELECT * FROM tasks WHERE id = ?",
                      [id],
                      (errT, tRow) => {
                        sendSseEvent({
                          type: "task",
                          action: "edited",
                          task: {
                            ...tRow,
                            assignees: "",
                            assigneeIds: [],
                          },
                          assigneesChanged: assigneesChanged,
                          timestamp: Date.now(),
                        });
                        res.redirect(
                          `/task-management?success=edited&taskId=${id}&toStatus=${status}&assigneesChanged=${assigneesChanged}`,
                        );
                      },
                    );
                  }
                },
              );
            },
          );
        },
      );
    },
  );
});

app.post("/task-management/update-status", (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res
      .status(400)
      .json({ success: false, error: "Missing task ID or status" });
  }

  db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, id], (err) => {
    if (err) {
      console.error("Error updating task status:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true });
  });
});

app.post("/task-management/update-order", (req, res) => {
  const { updates } = req.body; // Array of { id, status, order_index }
  if (!updates || !Array.isArray(updates)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid updates format" });
  }

  // To prevent multiple queries running synchronously and causing connection issues, run them sequentially
  let updateCount = 0;
  const doUpdate = () => {
    if (updateCount >= updates.length) {
      return res.json({ success: true });
    }
    const item = updates[updateCount];
    db.run(
      "UPDATE tasks SET status = ?, order_index = ? WHERE id = ?",
      [item.status, item.order_index, item.id],
      (err) => {
        if (err) console.error("Error updating order:", err);
        updateCount++;
        doUpdate();
      },
    );
  };
  doUpdate();
});

app.post("/task-management/delete", (req, res) => {
  const { id } = req.body;
  if (!id) return res.redirect("/task-management?error=delete_failed");

  db.get("SELECT code FROM tasks WHERE id = ?", [id], (errG, task) => {
    const code = task ? task.code : "#" + String(id).padStart(4, "0");
    db.run("DELETE FROM tasks WHERE id = ?", [id], (err) => {
      if (err) {
        console.error(err);
        return res.redirect("/task-management?error=delete_failed");
      }
      sendSseEvent({
        type: "task",
        action: "deleted",
        taskId: id,
        code: code,
        timestamp: Date.now(),
      });
      res.redirect("/task-management?success=deleted");
    });
  });
});

const keyPath = path.join(__dirname, "key.pem");
const certPath = path.join(__dirname, "cert.pem");
let server;
let isHttps = false;

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const https = require("https");
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  server = https.createServer(options, app);
  isHttps = true;
} else {
  server = app;
}

if (!process.env.VERCEL) {
  server.listen(PORT, "0.0.0.0", () => {
    const protocol = isHttps ? "https" : "http";
    console.log(`==================================================`);
    console.log(`Server running locally: ${protocol}://localhost:${PORT}`);

    // Deteksi IP Address lokal di jaringan
    const os = require("os");
    const networkInterfaces = os.networkInterfaces();
    let hasNetworkAddress = false;

    Object.keys(networkInterfaces).forEach((interfaceName) => {
      networkInterfaces[interfaceName].forEach((iface) => {
        // Ambil IPv4 yang bukan loopback/internal (127.0.0.1)
        if (
          (iface.family === "IPv4" || iface.family === 4) &&
          !iface.internal
        ) {
          console.log(
            `Access on your local network: ${protocol}://${iface.address}:${PORT}`,
          );
          hasNetworkAddress = true;
        }
      });
    });

    if (!hasNetworkAddress) {
      console.log(
        "No active network adapter found (WiFi/Ethernet). Connect to a network to access from other devices.",
      );
    }
    if (isHttps) {
      console.log("SSL Mode: Active (HTTPS)");
    } else {
      console.log(
        "SSL Mode: Inactive (HTTP). To use HTTPS locally, place 'key.pem' and 'cert.pem' in project root.",
      );
    }
    console.log(`==================================================`);
  });
}

// Import runBackup from backup.js for automatic scheduling
const { runBackup } = require("./backup");

// Helper function to check and run weekly backup automatically
const checkWeeklyBackup = async () => {
  try {
    const backupDir = path.join(__dirname, "backup");
    const infoPath = path.join(backupDir, "backup_info.json");
    let shouldBackup = false;

    if (!fs.existsSync(infoPath)) {
      shouldBackup = true;
    } else {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      const lastBackupDate = moment(info.lastBackup, "YYYY-MM-DD HH:mm:ss");
      const diffDays = moment().diff(lastBackupDate, "days");
      if (diffDays >= 7) {
        shouldBackup = true;
      }
    }

    if (shouldBackup) {
      console.log("[Auto Backup] Memulai backup mingguan otomatis...");
      await runBackup();
      console.log(
        "[Auto Backup] Backup mingguan otomatis berhasil diselesaikan.",
      );
    }
  } catch (err) {
    console.error("[Auto Backup] Gagal menjalankan backup otomatis:", err);
  }
};

if (!process.env.VERCEL) {
  // Jalankan pengecekan pertama kali 5 detik setelah server menyala
  setTimeout(checkWeeklyBackup, 5000);

  // Lakukan pengecekan berkala setiap 1 jam sekali (3.600.000 ms)
  setInterval(checkWeeklyBackup, 3600000);
}
