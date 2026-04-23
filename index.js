const ntpClient = require('ntp-client');
const admin = require('firebase-admin');
const express = require('express');

// ========== FUNGSI SINKRONISASI WAKTU ==========
async function syncSystemTime() {
    return new Promise((resolve, reject) => {
        ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
            if (err) {
                console.error("❌ Gagal sinkronisasi waktu:", err);
                return reject(err);
            }
            const now = new Date();
            const diff = date.getTime() - now.getTime();
            console.log(`🕒 Waktu server: ${now.toISOString()}`);
            console.log(`🕒 Waktu NTP: ${date.toISOString()}`);
            console.log(`📊 Selisih: ${diff} ms (${Math.abs(diff)/1000} detik)`);
            if (Math.abs(diff) > 5000) {
                console.warn("⚠️ Selisih waktu lebih dari 5 detik, mungkin akan menyebabkan error JWT.");
            }
            resolve(date);
        });
    });
}

// ========== INISIALISASI FIREBASE ==========
async function initializeFirebase() {
    try {
        await syncSystemTime();
    } catch (e) {
        console.error("⚠️ Gagal sync time, lanjutkan dengan waktu sistem:", e.message);
    }

    let serviceAccount;
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        console.log("✅ Menggunakan kredensial dari environment variable.");
    } else {
        try {
            serviceAccount = require('./serviceAccountKey.json');
            console.log("✅ Menggunakan kredensial dari file lokal.");
        } catch (err) {
            console.error("❌ Tidak ada kredensial Firebase yang valid.");
            process.exit(1);
        }
    }

    const databaseURL = process.env.DATABASE_URL || "https://monitoring-udang-vaname-default-rtdb.firebaseio.com/";
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: databaseURL
    });
    console.log("✅ Firebase berhasil diinisialisasi.");
    return admin.database();
}

let db;
const app = express();
const PORT = process.env.PORT || 3000;
const STICKY_INTERVAL_MS = 20 * 1000;
let knownPools = new Set();
let lastSentValues = new Map();

// ========== FUNGSI KIRIM STICKY NOTIFIKASI ==========
async function sendStickyNotification(poolID, title, body) {
    const topic = `pool_${poolID}`;
    const message = {
        notification: { title, body },
        topic: topic,
        android: {
            collapseKey: `sticky_${poolID}`,
            priority: "high",
            notification: {
                sound: "",
                tag: `sticky_${poolID}`,
                color: "#2196F3",
                icon: "ic_launcher"
            }
        }
    };
    try {
        await admin.messaging().send(message);
        console.log(`✅ Sticky notifikasi terkirim ke ${poolID}: ${body}`);
    } catch (error) {
        console.error(`❌ Gagal kirim sticky: ${error.message}`);
    }
}

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
            await sendStickyNotification(poolID, title, summary);
            lastSentValues.set(poolID, summary);
        } catch (err) {
            console.error(`❌ Gagal kirim sticky untuk ${poolID}:`, err.message);
        }
    }
}

async function sendAlertNotification(poolID, suhu, ph, ec, ketinggian, minSuhu, maxSuhu, minPh, maxPh, minEc, maxEc, minAir, maxAir) {
    const send = async (title, body) => {
        const message = {
            notification: { title, body },
            topic: `pool_${poolID}`,
            android: { priority: "high" }
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
        await sendAlertNotification(poolID, suhu, ph, ec, ketinggian, minSuhu, maxSuhu, minPh, maxPh, minEc, maxEc, minAir, maxAir);
    } catch (error) {
        console.error(`❌ Error saat memeriksa kolam ${poolID}:`, error);
    }
}

// ========== START SERVER SETELAH FIREBASE SIAP ==========
initializeFirebase().then(database => {
    db = database;
    const rootRef = db.ref('/');
    rootRef.on('child_changed', (snapshot) => {
        const poolID = snapshot.key;
        if (snapshot.hasChild('sensor')) {
            console.log(`📡 Perubahan sensor di kolam: ${poolID}`);
            checkSensorAndNotify(poolID);
        }
    });
    setInterval(() => {
        sendPeriodicStatus();
    }, STICKY_INTERVAL_MS);
    app.get('/', (req, res) => {
        res.send('Server Smart Vaname dengan sticky notification (20 detik, silent, collapse)');
    });
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server berjalan di port ${PORT}`);
        console.log(`⏰ Sticky notification setiap ${STICKY_INTERVAL_MS / 1000} detik (silent, tidak menumpuk)`);
    });
}).catch(err => {
    console.error("🔥 Gagal inisialisasi Firebase:", err);
    process.exit(1);
});