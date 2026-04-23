const admin = require('firebase-admin');
const express = require('express');

// ========== KONFIGURASI ==========
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://monitoring-udang-vaname-default-rtdb.firebaseio.com/" // GANTI!
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

// Interval sticky notifikasi: 20 detik
const STICKY_INTERVAL_MS = 20 * 1000; // 20000 ms

// Menyimpan daftar kolam yang pernah terdeteksi
let knownPools = new Set();

// Untuk mencegah spam: simpan nilai sensor terakhir yang dikirim (opsional)
let lastSentValues = new Map(); // key: poolID, value: string ringkasan

// ========== FUNGSI KIRIM STICKY NOTIFIKASI (SILENT, COLLAPSE) ==========
async function sendStickyNotification(poolID, title, body) {
    const topic = `pool_${poolID}`;
    const message = {
        notification: { title, body },
        topic: topic,
        android: {
            collapseKey: `sticky_${poolID}`,
            priority: "high",
            notification: {
                sound: "",       // Tidak ada suara di Android
                tag: `sticky_${poolID}`,
                color: "#2196F3",
                icon: "ic_launcher"
            }
        },
        // Untuk iOS, kita kirim tanpa sound (hapus properti aps.sound)
        apns: {
            payload: {
                aps: {
                    contentAvailable: true  // Silent push, tidak menampilkan notifikasi? Sebenarnya ini untuk background.
                    // Jika ingin notifikasi tampil di iOS tapi tanpa suara, gunakan:
                    // sound: null (tidak diizinkan), lebih baik hapus properti sound.
                }
            }
        }
    };
    // Hapus properti sound jika null untuk iOS? Atau kita cukup tidak sertakan apns.
    // Cara aman: hanya kirim untuk Android dulu, atau buat kondisi platform.
    // Sederhananya, kita hapus bagian apns, karena notifikasi tetap akan sampai ke iOS tanpa apns.
    // Atau kita set apns dengan headers yang benar.
    // Paling mudah: hapus apns, biarkan FCM menangani default.
    delete message.apns; // Hapus apns agar tidak error
    try {
        const response = await admin.messaging().send(message);
        console.log(`✅ Sticky notifikasi terkirim ke ${poolID}: ${body}`);
    } catch (error) {
        console.error(`❌ Gagal kirim sticky: ${error.message}`);
    }
}

// ========== KIRIM STATUS PERIODIK (SETIAP 20 DETIK) ==========
async function sendPeriodicStatus() {
    if (knownPools.size === 0) return;
    console.log(`⏰ Mengirim sticky update untuk ${knownPools.size} kolam...`);
    
    for (const poolID of knownPools) {
        try {
            const sensorRef = db.ref(`${poolID}/sensor`);
            const sensorSnap = await sensorRef.once('value');
            const sensor = sensorSnap.val();
            if (!sensor) continue;

            const suhu = parseFloat(sensor.suhu).toFixed(1);
            const ph = parseFloat(sensor.ph).toFixed(1);
            const ec = parseFloat(sensor.ec).toFixed(1);
            const ketinggian = parseFloat(sensor.ketinggian).toFixed(1);

            const summary = `🌡️${suhu}°C | pH ${ph} | 💧${ec} Ppt | 📏${ketinggian} cm`;
            const title = `📊 Smart Vaname - ${poolID}`;
            
            // (Opsional) hanya kirim jika nilai berubah dari pengiriman sebelumnya
            const last = lastSentValues.get(poolID);
            if (last === summary) {
                // Nilai sama, lewati agar tidak spam meskipun collapse sudah menggantikan
                // Tapi jika tetap ingin update setiap 20 dtk, hapus kondisi ini.
                // Saya sarankan tetap kirim agar selalu update meskipun sama.
                // Agar tidak spam, biarkan collapse key yang mengatasi.
            }
            await sendStickyNotification(poolID, title, summary);
            lastSentValues.set(poolID, summary);
        } catch (err) {
            console.error(`❌ Gagal kirim sticky untuk ${poolID}:`, err.message);
        }
    }
}

// ========== FUNGSI PENGECEKAN AMBANG BATAS (TIDAK BERUBAH) ==========
async function checkSensorAndNotify(poolID) {
    console.log(`🔍 Memeriksa kolam: ${poolID}`);
    const sensorRef = db.ref(`${poolID}/sensor`);
    const thresholdRef = db.ref(`${poolID}/threshold`);
    try {
        const [sensorSnap, threshSnap] = await Promise.all([
            sensorRef.once('value'),
            thresholdRef.once('value')
        ]);
        const sensor = sensorSnap.val();
        const threshold = threshSnap.val();
        if (!sensor || !threshold) {
            console.log(`⚠️ Data sensor atau threshold tidak lengkap untuk ${poolID}`);
            return;
        }

        knownPools.add(poolID);

        const suhu = parseFloat(sensor.suhu);
        const ph = parseFloat(sensor.ph);
        const ec = parseFloat(sensor.ec);
        const ketinggian = parseFloat(sensor.ketinggian);

        const minSuhu = threshold.suhu?.min ?? 26;
        const maxSuhu = threshold.suhu?.max ?? 30;
        const minPh = threshold.ph?.min ?? 7;
        const maxPh = threshold.ph?.max ?? 8;
        const minEc = threshold.ec?.min ?? 5;
        const maxEc = threshold.ec?.max ?? 7;
        const minAir = threshold.ketinggian?.min ?? 0;
        const maxAir = threshold.ketinggian?.max ?? 100;

        // Notifikasi bahaya (dengan suara, penting) – tetap menggunakan sendNotificationToTopic biasa
        // Di sini Anda bisa menggunakan fungsi yang sama dengan sendNotificationToTopic (tanpa collapse)
        // Saya asumsikan Anda ingin notifikasi bahaya tetap bersuara dan tidak di-collapse dengan sticky.
        // Untuk itu, buat fungsi terpisah untuk bahaya.
        await sendAlertNotification(poolID, suhu, ph, ec, ketinggian, minSuhu, maxSuhu, minPh, maxPh, minEc, maxEc, minAir, maxAir);
    } catch (error) {
        console.error(`❌ Error saat memeriksa kolam ${poolID}:`, error);
    }
}

// Notifikasi bahaya (dengan suara, tanpa collapse agar tidak tertimpa sticky)
async function sendAlertNotification(poolID, suhu, ph, ec, ketinggian, minSuhu, maxSuhu, minPh, maxPh, minEc, maxEc, minAir, maxAir) {
    const send = async (title, body) => {
        const message = {
            notification: { title, body },
            topic: `pool_${poolID}`,
            android: { priority: "high" } // default bersuara
        };
        try {
            await admin.messaging().send(message);
            console.log(`✅ ALERT: ${title}`);
        } catch (err) { console.error(err); }
    };

    if (suhu > maxSuhu) await send(`⚠️ Suhu Tinggi (${poolID})`, `Suhu: ${suhu}°C > ${maxSuhu}°C`);
    else if (suhu < minSuhu) await send(`❄️ Suhu Rendah (${poolID})`, `Suhu: ${suhu}°C < ${minSuhu}°C`);

    if (ph > maxPh) await send(`⚠️ pH Tinggi (${poolID})`, `pH: ${ph} > ${maxPh}`);
    else if (ph < minPh) await send(`⚠️ pH Rendah (${poolID})`, `pH: ${ph} < ${minPh}`);

    if (ec > maxEc) await send(`⚠️ Salinitas Tinggi (${poolID})`, `EC: ${ec} Ppt > ${maxEc} Ppt`);
    else if (ec < minEc) await send(`⚠️ Salinitas Rendah (${poolID})`, `EC: ${ec} Ppt < ${minEc} Ppt`);

    if (ketinggian > maxAir) await send(`⚠️ Air Penuh (${poolID})`, `Tinggi: ${ketinggian} cm > ${maxAir} cm`);
    else if (ketinggian < minAir) await send(`⚠️ Air Surut (${poolID})`, `Tinggi: ${ketinggian} cm < ${minAir} cm`);
}

// ========== LISTENER PERUBAHAN SENSOR ==========
const rootRef = db.ref('/');
rootRef.on('child_changed', (snapshot) => {
    const poolID = snapshot.key;
    if (snapshot.hasChild('sensor')) {
        console.log(`📡 Perubahan sensor di kolam: ${poolID}`);
        checkSensorAndNotify(poolID);
    }
});

// ========== START PERIODIC STICKY NOTIFICATION ==========
setInterval(() => {
    sendPeriodicStatus();
}, STICKY_INTERVAL_MS);

// ========== ENDPOINT ==========
app.get('/', (req, res) => {
    res.send('Server Smart Vaname dengan sticky notification (20 detik, silent, collapse)');
});

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
    console.log(`⏰ Sticky notification setiap ${STICKY_INTERVAL_MS / 1000} detik (silent, tidak menumpuk)`);
});