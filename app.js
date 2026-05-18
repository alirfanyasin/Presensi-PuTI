const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const db = require("./db");
const moment = require("moment");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(bodyParser.json({ limit: "50mb" }));

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
app.get("/api/check-presensi", (req, res) => {
  const { karyawanId, tanggal } = req.query;
  if (!karyawanId || !tanggal) return res.json({ status: "none" });
  db.get(
    "SELECT id, jamMasuk, jamPulang FROM presensi WHERE karyawanId = ? AND tanggal = ? ORDER BY id DESC LIMIT 1",
    [karyawanId, tanggal],
    (err, row) => {
      if (err) return res.json({ status: "none" });
      if (!row) return res.json({ status: "none" });
      if (row.jamPulang) return res.json({ status: "sudah_pulang", jamMasuk: row.jamMasuk, jamPulang: row.jamPulang });
      return res.json({ status: "sudah_masuk", jamMasuk: row.jamMasuk });
    }
  );
});

// Route: Presensi Masuk (INSERT new record, time auto from server)
app.post("/presensi-masuk", (req, res) => {
  const { karyawanId, tanggal } = req.body;
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
app.post("/presensi-pulang", (req, res) => {
  const { karyawanId, tanggal, pekerjaan, foto } = req.body;
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

      db.run(
        "UPDATE presensi SET jamPulang = ?, pekerjaan = ?, foto = ?, totalJam = ?, updatedAt = ? WHERE id = ?",
        [jamPulang, pekerjaan || "", foto || null, totalJamStr.trim(), updatedAt, existing.id],
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
    const filterTanggal = req.query.filterTanggal || "";

    let query =
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE 1=1";
    let params = [];

    if (filterNama !== "all") {
      query += " AND p.karyawanId = ?";
      params.push(filterNama);
    }
    if (filterTanggal) {
      query += " AND p.tanggal = ?";
      params.push(filterTanggal);
    }

    query += " ORDER BY p.tanggal DESC, p.id DESC";

    db.all(query, params, (err, rows) => {
      if (err) throw err;
      const presensi = rows.map((r) => ({
        ...r,
        formattedHari: r.hari || moment(r.tanggal).locale("id").format("dddd"),
        formattedDate: moment(r.tanggal).locale("id").format("DD MMM YYYY"),
        totalJamStr: r.totalJam || "",
      }));

      res.render("daftar-kehadiran", {
        karyawanList,
        presensi,
        filterNama,
        filterTanggal,
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
  db.run("DELETE FROM presensi WHERE id = ?", [id], (err) => {
    if (err) console.error(err);
    res.redirect(`${returnUrl || "/daftar-kehadiran"}?success=deleted`);
  });
});

// Route: Riwayat Bulanan
app.get("/riwayat-bulanan", (req, res) => {
  db.all("SELECT * FROM presensi", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Internal Server Error");
    }

    const grouped = rows.reduce((acc, curr) => {
      const monthStr = curr.tanggal.substring(0, 7);
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

    const groupedData = Object.values(grouped)
      .sort((a, b) => b.monthStr.localeCompare(a.monthStr))
      .map((d) => {
        const [year, month] = d.monthStr.split("-");
        return {
          ...d,
          karyawanUnik: d.karyawanUnik.size,
          monthName: `${monthNames[parseInt(month, 10) - 1]} ${year}`,
        };
      });

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

    const [year, month] = monthStr.split("-");
    const monthName = `${monthNames[parseInt(month, 10) - 1]} ${year}`;

    const karyawanList = await getKaryawan();
    const filterNama = req.query.filterNama || "all";

    let query =
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.tanggal LIKE ?";
    let params = [`${monthStr}-%`];

    if (filterNama !== "all") {
      query += " AND p.karyawanId = ?";
      params.push(filterNama);
    }

    query += " ORDER BY p.tanggal DESC, p.id DESC";

    db.all(query, params, (err, rows) => {
      if (err) throw err;
      const presensi = rows.map((r) => ({
        ...r,
        formattedHari: r.hari || moment(r.tanggal).locale("id").format("dddd"),
        formattedDate: moment(r.tanggal).locale("id").format("DD MMM YYYY"),
        totalJamStr: r.totalJam || "",
      }));

      res.render("detail-bulanan", {
        monthStr,
        monthName,
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

// Route: Export CSV
app.get("/export", async (req, res) => {
  try {
    const filterNama = req.query.filterNama || "all";
    const filterTanggal = req.query.filterTanggal || "";
    const month = req.query.month || "";

    let query =
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE 1=1";
    let params = [];

    if (filterNama !== "all") {
      query += " AND p.karyawanId = ?";
      params.push(filterNama);
    }
    if (filterTanggal) {
      query += " AND p.tanggal = ?";
      params.push(filterTanggal);
    }
    if (month) {
      query += " AND p.tanggal LIKE ?";
      params.push(`${month}-%`);
    }

    query += " ORDER BY p.tanggal DESC, p.id DESC";

    db.all(query, params, async (err, rows) => {
      if (err) throw err;

      const headers = [
        "No",
        "Nama Karyawan",
        "Tanggal",
        "Jam Masuk",
        "Jam Pulang",
        "Deskripsi Pekerjaan",
      ];
      const csvRows = rows.map((p, i) => [
        i + 1,
        `"${p.nama}"`,
        p.tanggal,
        p.jamMasuk,
        p.jamPulang,
        `"${p.pekerjaan.replace(/"/g, '""')}"`,
      ]);

      const csvContent = [
        headers.join(","),
        ...csvRows.map((row) => row.join(",")),
      ].join("\n");

      let fileNameStr = "Presensi";
      if (month) fileNameStr += `_${month}`;
      else if (filterTanggal) fileNameStr += `_${filterTanggal}`;
      else fileNameStr += "_SemuaTanggal";

      if (filterNama !== "all") {
        const kList = await getKaryawan();
        const k = kList.find((x) => x.id == filterNama);
        if (k) fileNameStr += `_${k.nama.replace(/\s+/g, "_")}`;
      }

      res.header("Content-Type", "text/csv");
      res.attachment(`${fileNameStr}.csv`);
      res.send(csvContent);
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

    const startPeriod = moment(`${monthStr}-16`, "YYYY-MM-DD").locale("id");
    const endPeriod = moment(startPeriod)
      .clone()
      .add(1, "month")
      .subtract(1, "day");
    const formattedRange = `${startPeriod.format("D MMMM")} – ${endPeriod.format("D MMMM YYYY")}`;

    db.all(
      "SELECT p.*, k.nama FROM presensi p JOIN karyawan k ON p.karyawanId = k.id WHERE p.karyawanId = ? AND p.tanggal LIKE ? ORDER BY p.tanggal ASC, p.id ASC",
      [filterNama, `${monthStr}-%`],
      (err, rows) => {
        if (err) throw err;

        let totalMinutes = 0;
        const presensi = rows.map((r) => {
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
