import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

// === Konfigurasi Awal ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GOLD_API_URL = 'https://api.treasury.id/api/v1/antigrvty/gold/stats/buy';

// === Fungsi Utama: Ambil & Simpan Data Emas Terbaru ===
async function fetchAndStoreLatestGoldData() {
    console.log(`[${new Date().toISOString()}] 🚀 Memulai proses pengambilan data harga emas...`);

    try {
        const { data: apiResponse } = await axios.get(GOLD_API_URL);

        if (!apiResponse || !apiResponse.data || apiResponse.data.length === 0) {
            console.log('⚠️ API tidak mengembalikan data yang valid atau array kosong.');
            return;
        }

        const latestData = [...apiResponse.data].sort((a, b) => b.id - a.id)[0];

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

// === Jadwal Cron Job ===
const cronSchedule = '3 * * * *'; // setiap jam pada menit ke-5
cron.schedule(cronSchedule, fetchAndStoreLatestGoldData, {
    timezone: "Asia/Jakarta"
});
console.log(`⏳ Cron job dijadwalkan dengan pola "${cronSchedule}" (WIB).`);

// === Server Express ===
const app = express();
const PORT = process.env.PORT || 3000;

// Health Check
app.get('/', (req, res) => {
    res.send('✅ Gold Price Data Collector is running.');
});

// Endpoint: Semua data
app.get('/api/emas', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('emasDB')
            .select('*')
            .order('gold_id', { ascending: false });

        if (error) {
            console.error('❌ Gagal mengambil data dari Supabase:', error.message);
            return res.status(500).json({ error: 'Gagal mengambil data emas' });
        }

        res.json(data);
    } catch (err) {
        console.error('❌ Terjadi kesalahan pada endpoint /api/emas:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Endpoint: Data terbaru saja
app.get('/api/emas/latest', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('emasDB')
            .select('*')
            .order('gold_id', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('❌ Gagal mengambil data terbaru dari Supabase:', error.message);
            return res.status(500).json({ error: 'Gagal mengambil data terbaru' });
        }

        if (!data) {
            return res.status(404).json({ error: 'Data tidak ditemukan' });
        }

        res.json(data);
    } catch (err) {
        console.error('❌ Terjadi kesalahan pada endpoint /api/emas/latest:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🌐 Server berjalan di port ${PORT}.`);
});
