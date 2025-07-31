import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

// === Konfigurasi Awal ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GOLD_API_URL = 'https://api.treasury.id/api/v1/antigrvty/gold/stats/buy';

/**
 * Fungsi utama untuk mengambil data harga emas dan menyimpan HANYA DATA TERBARU ke Supabase.
 */
async function fetchAndStoreLatestGoldData() {
    console.log(`[${new Date().toISOString()}] 🚀 Memulai proses pengambilan data harga emas...`);

    try {
        const { data: apiResponse } = await axios.get(GOLD_API_URL);

        if (!apiResponse || !apiResponse.data || apiResponse.data.length === 0) {
            console.log('⚠️ API tidak mengembalikan data yang valid atau array kosong.');
            return;
        }

        const latestData = apiResponse.data.reduce((latest, current) => {
            return current.id > latest.id ? current : latest;
        });

        console.log(`ℹ️ Data terbaru ditemukan: ID=${latestData.id}, Harga=${latestData.buying_rate}`);

        const { data: existingRecord, error: checkError } = await supabase
            .from('emasDB')
            .select('id')
            .eq('gold_id', latestData.id)
            .maybeSingle();

        if (checkError) {
            console.error('❌ Gagal saat memeriksa data di Supabase:', checkError.message);
            return;
        }

        if (existingRecord) {
            console.log(`🤫 Data dengan ID ${latestData.id} sudah ada. Tidak ada data baru yang disimpan.`);
            return;
        }

        console.log(`➕ Menambahkan data baru dengan ID ${latestData.id} ke Supabase...`);
        const { error: insertError } = await supabase
            .from('emasDB')
            .insert([
                {
                    gold_id: latestData.id,
                    buying_rate: latestData.buying_rate,
                    date: latestData.date,
                },
            ]);

        if (insertError) {
            console.error('❌ Gagal memasukkan data ke Supabase:', insertError.message);
        } else {
            console.log(`✅ Sukses! Data terbaru berhasil disimpan.`);
        }

    } catch (error) {
        console.error('❌ Terjadi kesalahan selama proses:', error.message);
    }
}

// === Konfigurasi Cron Job ===
// Menjadwalkan tugas untuk berjalan setiap jam, pada menit ke-20.
// Contoh: 01:20, 02:20, 03:20, dst.
const cronSchedule = '50 * * * *'; // <<< PERUBAHAN DI SINI
cron.schedule(cronSchedule, fetchAndStoreLatestGoldData, {
    timezone: "Asia/Jakarta"
});

console.log(`⏳ Cron job dijadwalkan dengan pola "${cronSchedule}" (WIB).`);

// === Konfigurasi Server Express untuk Health Check ===
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send('✅ Gold Price Data Collector is running.');
});
app.listen(PORT, () => {
    console.log(`🌐 Server berjalan di port ${PORT}.`);
});