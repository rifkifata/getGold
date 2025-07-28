import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';

const { Client, LocalAuth } = pkg;

// === Supabase setup ===
const supabaseUrl = 'https://njuwhppokcqtbgyornsn.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// === WhatsApp setup ===
const client = new Client({
    authStrategy: new LocalAuth()
});

// === Target Nomor dari ENV ===
const TARGET_NUMBERS = process.env.WA_TARGET_NUMBERS
    ? process.env.WA_TARGET_NUMBERS.split(',').map(num => num.trim()).filter(Boolean)
    : [];

// === Ambil threshold dari Supabase ===
async function getDynamicThreshold() {
    const { data, error } = await supabase
        .from('gold_config')
        .select('threshold')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    if (error) {
        console.error('❌ Gagal mengambil threshold dari Supabase:', error.message);
        return null;
    }

    return parseInt(data.threshold, 10);
}

// === Fungsi Utama: Mengecek dan Kirim WA ===
async function checkGoldAndSend() {
    const now = new Date().toISOString();
    console.log(`🔍 Memulai pengecekan harga emas pada ${now}`);

    if (TARGET_NUMBERS.length === 0) {
        console.error('❗ TARGET_NUMBERS kosong. Harap isi WA_TARGET_NUMBERS di .env.');
        return;
    }

    const threshold = await getDynamicThreshold();
    if (!threshold) {
        console.error('❌ Threshold tidak tersedia. Proses dibatalkan.');
        return;
    }

    try {
        const response = await axios.get('https://api.treasury.id/api/v1/antigrvty/gold/stats/buy', {
            headers: {
                'user-agent': 'Mozilla/5.0',
                'origin': 'https://web.treasury.id',
                'accept': 'application/json, text/plain, */*',
                'accept-language': 'en,en-US;q=0.9,id;q=0.8'
            }
        });

        const dataArr = response.data.data;
        if (!Array.isArray(dataArr) || dataArr.length === 0) {
            console.warn('⚠️ Data emas kosong atau bukan array.');
            return;
        }

        const latest = dataArr.reduce((a, b) => (a.id > b.id ? a : b));
        console.log(`📦 Data terbaru: ID ${latest.id}, Harga: Rp${latest.buying_rate}, Tanggal: ${latest.date}`);

        if (latest.buying_rate < threshold) {
            console.log(`📉 Harga emas Rp${latest.buying_rate} < threshold Rp${threshold}, lanjut pengiriman.`);

            const { data: existing, error: checkError } = await supabase
                .from('emasDB')
                .select('id')
                .eq('gold_id', latest.id)
                .maybeSingle();

            if (checkError) {
                console.error('❌ Gagal memeriksa Supabase:', checkError.message);
                return;
            }

            if (existing) {
                console.log(`🚫 gold_id ${latest.id} sudah pernah dikirim sebelumnya. Melewati.`);
                return;
            }

            const thisYear = new Date().getFullYear();
            const fullDateStr = `${latest.date} ${thisYear}`;
            const parsedDate = new Date(fullDateStr);
            const formattedDate = formatCustomDate(parsedDate);

            for (const number of TARGET_NUMBERS) {
                const chatId = `${number}@c.us`;
                const message = `📉 Harga emas turun!\nHarga beli: Rp${latest.buying_rate}\nTanggal: ${latest.date}`;

                try {
                    console.log(`📤 Mengirim pesan ke ${number}...`);
                    await client.sendMessage(chatId, message);
                    console.log(`✅ Pesan berhasil dikirim ke ${number}`);

                    const { error: insertError } = await supabase.from('emasDB').insert([{
                        buying_rate: latest.buying_rate,
                        sent_to: number,
                        sent_at: new Date().toISOString(),
                        date: formattedDate,
                        gold_id: latest.id
                    }]);

                    if (insertError) {
                        console.error(`❌ Gagal simpan ke Supabase untuk ${number}:`, insertError.message);
                    } else {
                        console.log(`✅ Disimpan ke Supabase untuk ${number}`);
                    }

                } catch (sendError) {
                    console.error(`❌ Gagal kirim ke ${number}:`, sendError.message);
                }
            }

        } else {
            console.log(`ℹ️ Harga emas Rp${latest.buying_rate} ≥ threshold Rp${threshold}, tidak dikirim.`);
        }

    } catch (err) {
        if (err.response) {
            console.error('❗ API Error:', err.response.status, err.response.data);
        } else {
            console.error('❗ Error saat ambil/proses data:', err.message);
        }
    }
}

// === Format Tanggal ===
function formatCustomDate(dateObj) {
    const day = dateObj.getDate().toString().padStart(2, '0');
    const month = dateObj.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year = dateObj.getFullYear();
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = dateObj.getMinutes().toString().padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}`;
}

// === WhatsApp QR login ===
client.on('qr', (qr) => {
    console.log('🟡 Scan QR berikut untuk login:\n');
    qrcode.generate(qr, { small: true });
});

// === WhatsApp siap digunakan ===
client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    console.log('⏳ Menjadwalkan cron job pukul 10:00 dan 20:00...');
    cron.schedule('0 0 10,20 * * *', checkGoldAndSend); // jam 10 dan 20
});

client.on('disconnected', (reason) => {
    console.error('🔌 WhatsApp disconnected:', reason);
});

client.initialize();

// === Web server dummy (agar Render tidak error) ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
    res.send('✅ WhatsApp Bot is running (Render).');
});

app.listen(PORT, () => {
    console.log(`🌐 Express server aktif di port ${PORT}`);
});
