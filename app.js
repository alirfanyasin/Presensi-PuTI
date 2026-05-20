const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const moment = require("moment");
const { isHoliday } = require("./holidayHelper");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(bodyParser.json({ limit: "50mb" }));
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
  let startMoment = moment(`${startYear}-${String(startMonth).padStart(2, "0")}-16`, "YYYY-MM-DD");
  while (true) {
    const check = await isHoliday(startMoment.format("YYYY-MM-DD"));
    if (!check.isHoliday) {
      break;
    }
    startMoment.add(1, "day");
  }
  
  // End date: 15th of current month, shifted backward to the first non-holiday/non-weekend
  let endMoment = moment(`${year}-${String(month).padStart(2, "0")}-15`, "YYYY-MM-DD");
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
    endMoment
  };
};

// Helper to get formatted Indonesian range string for a given period month (YYYY-MM)
const getPeriodRangeString = async (periodMonthStr) => {
  const { startMoment, endMoment } = await getActualPeriodBounds(periodMonthStr);
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
  const matches = base64Str.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
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

// Utility to fetch all Karyawan
const getKaryawan = () => {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM karyawan ORDER BY nama ASC", (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Route: Form Isi Presensi
app.get("/", async (req, res) => {
  try {
    const karyawanList = await getKaryawan();
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
  const { karyawanId, tanggal } = req.query;
  if (!tanggal) return res.json({ status: "none" });

  try {
    const check = await isHoliday(tanggal);
    if (check.isHoliday) {
      return res.json({ status: "holiday", holidayName: check.name });
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
      }
    );
  } catch (e) {
    console.error(e);
    res.json({ status: "none" });
  }
});

// Route: Presensi Masuk (INSERT new record, time auto from server)
app.post("/presensi-masuk", async (req, res) => {
  const { karyawanId, tanggal } = req.body;
  
  const check = await isHoliday(tanggal);
  if (check.isHoliday) {
    return res.redirect("/?error=holiday");
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const jamMasuk = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const hari = moment(tanggal).locale("id").format("dddd");

  db.run(
    "INSERT INTO presensi (karyawanId, tanggal, jamMasuk, jamPulang, pekerjaan, createdAt, updatedAt, hari, totalJam, foto) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)",
    [karyawanId, tanggal, jamMasuk, createdAt, createdAt, hari],
    (err) => {
      if (err) { console.error(err); return res.status(500).send("Error saving data"); }
      res.redirect("/?success=masuk");
    },
  );
});

// Route: Presensi Pulang (UPDATE existing masuk record)
app.post("/presensi-pulang", async (req, res) => {
  const { karyawanId, tanggal, pekerjaan, foto } = req.body;

  const check = await isHoliday(tanggal);
  if (check.isHoliday) {
    return res.redirect("/?error=holiday");
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
      if (err) { console.error(err); return res.status(500).send("Error"); }
      if (!existing) {
        // Check if already checked out
        db.get("SELECT id FROM presensi WHERE karyawanId = ? AND tanggal = ? AND jamPulang IS NOT NULL LIMIT 1", [karyawanId, tanggal], (e, row) => {
          return res.redirect(row ? "/?error=sudah_pulang" : "/?error=notfound");
        });
        return;
      }

      // Calculate duration (HH:MM:SS format)
      const [hM, mM] = existing.jamMasuk.split(":").map(Number);
      const [hA, mA] = jamPulang.split(":").map(Number);
      const totalMins = hA * 60 + mA - (hM * 60 + mM);
      let totalJamStr = "";
      if (totalMins > 0) {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        if (h > 0) totalJamStr += `${h} Jam `;
        if (m > 0) totalJamStr += `${m} Menit`;
      }
      if (!totalJamStr) totalJamStr = "0 Menit";

      // Save Base64 to physical file if present
      let fotoPath = null;
      if (foto) {
        try {
          // Delete old photo if it exists
          if (existing.foto && existing.foto.startsWith('/uploads/')) {
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
        [jamPulang, pekerjaan || "", fotoPath || existing.foto || null, totalJamStr.trim(), updatedAt, existing.id],
        (err) => {
          if (err) { console.error(err); return res.status(500).send("Error"); }
          res.redirect("/?success=pulang");
        },
      );
    },
  );
});

// Route: Daftar Kehadiran
app.get("/daftar-kehadiran", async (req, res) => {
  try {
    const karyawanList = await getKaryawan();
    const filterNama = req.query.filterNama || "all";
    let filterTanggalMulai = req.query.filterTanggalMulai;
    let filterTanggalSelesai = req.query.filterTanggalSelesai;

    if (filterTanggalMulai === undefined && filterTanggalSelesai === undefined) {
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
      if (err) throw err;
      
      const filteredRows = [];
      for (const r of rows) {
        const check = await isHoliday(r.tanggal);
        if (!check.isHoliday) {
          filteredRows.push(r);
        }
      }

      const presensi = filteredRows.map((r) => ({
        ...r,
        formattedHari: r.hari || moment(r.tanggal).locale("id").format("dddd"),
        formattedDate: moment(r.tanggal).locale("id").format("DD MMM YYYY"),
        totalJamStr: r.totalJam || "",
      }));

      res.render("daftar-kehadiran", {
        karyawanList,
        presensi,
        filterNama,
        filterTanggalMulai,
        filterTanggalSelesai,
        moment,
        success:
          req.query.success === "deleted"
            ? "Data berhasil dihapus"
            : req.query.success === "edited"
              ? "Data berhasil diperbarui"
              : undefined,
      });
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
  const [hM, mM] = jamMasuk.split(":").map(Number);
  const [hA, mA] = jamPulang.split(":").map(Number);
  const totalMins = hA * 60 + mA - (hM * 60 + mM);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  let totalJamStr = "";
  if (hours > 0) totalJamStr += `${hours} Jam `;
  if (mins > 0) totalJamStr += `${mins} Menit`;
  if (!totalJamStr) totalJamStr = "0 Menit";
  const totalJam = totalJamStr.trim();

  db.run(
    "UPDATE presensi SET tanggal = ?, jamMasuk = ?, jamPulang = ?, pekerjaan = ?, hari = ?, totalJam = ?, updatedAt = ? WHERE id = ?",
    [tanggal, jamMasuk, jamPulang, pekerjaan, hari, totalJam, updatedAt, id],
    (err) => {
      if (err) console.error(err);
      res.redirect(`${returnUrl || "/daftar-kehadiran"}?success=edited`);
    },
  );
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
          console.error("Gagal menghapus file foto dari disk:", unlinkErr.message);
        }
      }
    }

    db.run("DELETE FROM presensi WHERE id = ?", [id], (err) => {
      if (err) console.error(err);
      res.redirect(`${returnUrl || "/daftar-kehadiran"}?success=deleted`);
    });
  });
});

// Route: Riwayat Bulanan
app.get("/riwayat-bulanan", async (req, res) => {
  db.all("SELECT * FROM presensi", async (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Internal Server Error");
    }

    const filteredRows = [];
    for (const r of rows) {
      const check = await isHoliday(r.tanggal);
      if (!check.isHoliday) {
        filteredRows.push(r);
      }
    }

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
        })
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

    const karyawanList = await getKaryawan();
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
      
      const filteredRows = [];
      for (const r of rows) {
        const check = await isHoliday(r.tanggal);
        if (!check.isHoliday) {
          filteredRows.push(r);
        }
      }

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
});

// Route: Export PDF (Print A4)
app.get("/export-pdf", async (req, res) => {
  try {
    const filterNama = req.query.filterNama || "";
    const monthStr = req.query.month || "";

    if (!filterNama || filterNama === "all" || !monthStr) {
      return res.status(400).send("Parameter filterNama dan month wajib diisi");
    }

    const karyawanList = await getKaryawan();
    const karyawan = karyawanList.find((x) => x.id == filterNama);
    if (!karyawan) {
      return res.status(404).send("Karyawan tidak ditemukan");
    }

    const { startDate, endDate, startMoment, endMoment } = await getActualPeriodBounds(monthStr);
    const formattedRange = `${startMoment.locale("id").format("D MMMM")} – ${endMoment.locale("id").format("D MMMM YYYY")}`;

    db.all(
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.karyawanId = ? AND p.tanggal >= ? AND p.tanggal <= ? AND p.jamPulang IS NOT NULL AND p.jamPulang != '' ORDER BY p.tanggal ASC, p.id ASC",
      [filterNama, startDate, endDate],
      async (err, rows) => {
        if (err) throw err;

        const filteredRows = [];
        for (const r of rows) {
          const check = await isHoliday(r.tanggal);
          if (!check.isHoliday) {
            filteredRows.push(r);
          }
        }

        let totalMinutes = 0;
        const presensi = filteredRows.map((r) => {
          const [hM, mM] = r.jamMasuk.split(":").map(Number);
          const [hA, mA] = r.jamPulang.split(":").map(Number);
          totalMinutes += hA * 60 + mA - (hM * 60 + mM);

          const pukulStr = `${r.jamMasuk.replace(":", ".")} s/d ${r.jamPulang.replace(":", ".")}`;

          return {
            ...r,
            formattedDateWithDay: moment(r.tanggal)
              .locale("id")
              .format("dddd, D MMMM YYYY"),
            pukulStr,
            totalJam: r.totalJam || "",
          };
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
          monthStr,
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`==================================================`);
  console.log(`Server running locally: http://localhost:${PORT}`);

  // Deteksi IP Address lokal di jaringan
  const os = require("os");
  const networkInterfaces = os.networkInterfaces();
  let hasNetworkAddress = false;

  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((iface) => {
      // Ambil IPv4 yang bukan loopback/internal (127.0.0.1)
      if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) {
        console.log(
          `Access on your local network: http://${iface.address}:${PORT}`,
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
  console.log(`==================================================`);
});

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
      console.log("[Auto Backup] Backup mingguan otomatis berhasil diselesaikan.");
    }
  } catch (err) {
    console.error("[Auto Backup] Gagal menjalankan backup otomatis:", err);
  }
};

// Jalankan pengecekan pertama kali 5 detik setelah server menyala
setTimeout(checkWeeklyBackup, 5000);

// Lakukan pengecekan berkala setiap 1 jam sekali (3.600.000 ms)
setInterval(checkWeeklyBackup, 3600000);

