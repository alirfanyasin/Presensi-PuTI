# CORE - SIMASS

### Memuat modul kecerdasan buatan (AI) tinyFaceDetector, faceLandmark, & faceRecognition

```js
async function loadFaceModels() {
  if (isModelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
  await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
  await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
  isModelsLoaded = true;
}
```

### Mengambil Wajah Terdaftar & Membuat Pencocok Wajah (Frontend)

```js
async function loadRegisteredFaces() {
  try {
    const res = await fetch("/api/karyawan/faces");
    registeredFaces = await res.json(); // Mengandung array descriptor karyawan

    // Mapping JSON array ke format LabeledFaceDescriptors milik face-api.js
    const labeledDescriptors = registeredFaces.map((f) => {
      const descriptor = new Float32Array(f.descriptor);
      return new faceapi.LabeledFaceDescriptors(String(f.id), [descriptor]);
    });

    // Threshold toleransi perbedaan wajah (0.45 = cukup ketat/aman)
    faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.45);
  } catch (e) {
    console.error("Gagal mengambil data wajah terdaftar:", e);
  }
}
```

### Loop Pendeteksian & Pencocokan Wajah Real-Time (Core Utama)

```js
scanInterval = setInterval(async () => {
  if (!cameraStream || isManualMode || recognizedUser) return;

  // Mendeteksi wajah tunggal beserta landmark dan deskriptornya
  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.5,
  });
  const detection = await faceapi
    .detectSingleFace(faceScanVideo, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (detection) {
    if (faceMatcher) {
      // Mencari kecocokan terdekat berdasarkan nilai Euclidean distance descriptor wajah
      const match = faceMatcher.findBestMatch(detection.descriptor);

      if (match.label !== "unknown") {
        const matchedId = parseInt(match.label, 10);
        const user = registeredFaces.find((f) => f.id === matchedId);
        if (user) {
          // Wajah COCOK / Terverifikasi!
          recognizedUser = user;
          verifyUser(user);
        }
      } else {
        // Wajah tidak dikenal
        unrecognizedFramesCount++;
        if (unrecognizedFramesCount >= 6) {
          showScanFailedDialog(); // Arahkan ke pilihan manual
        }
      }
    }
  }
}, 300);
```

### Pendaftaran Wajah Baru (Frontend)

```js
// Mendapatkan descriptor wajah saat registrasi
const options = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.5,
});
const detection = await faceapi
  .detectSingleFace(regVideo, options)
  .withFaceLandmarks()
  .withFaceDescriptor();

if (detection) {
  // Array ini berupa Float32Array dengan panjang 128 elemen
  const faceDescriptorArray = Array.from(detection.descriptor);

  // Kirim data descriptor ke backend API untuk disimpan
  await fetch(`/api/karyawan/${karyawanId}/register-face`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptor: faceDescriptorArray }),
  });
}
```

### Backend Penyimpanan ke Database (Node.js/Express & MySQL)

```js
// Route pendaftaran wajah di app.js
app.post("/api/karyawan/:id/register-face", (req, res) => {
  const { id } = req.params;
  const { descriptor } = req.body; // Array descriptor berisi 128 angka float

  const descriptorStr = JSON.stringify(descriptor); // Diubah ke teks JSON string

  db.run(
    "UPDATE karyawan SET face_descriptor = ? WHERE id = ?",
    [descriptorStr, id],
    (err) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json({ success: true, message: "Wajah berhasil didaftarkan!" });
    },
  );
});
```
