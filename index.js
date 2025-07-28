
import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
const { Client, LocalAuth } = pkg;
import { createClient } from '@supabase/supabase-js';

// Supabase setup
const supabaseUrl = 'https://njuwhppokcqtbgyornsn.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// WhatsApp setup
const client = new Client({
    authStrategy: new LocalAuth()
});

// Configurable variables
const THRESHOLD = process.env.GOLD_THRESHOLD || 1800000; // Bisa diganti di .env
const TARGET_NUMBER = process.env.WA_TARGET_NUMBER; // Format: '628xxxxxx'

async function checkGoldAndSend() {
    const now = new Date().toISOString();
    console.log(`🔍 Memulai pengecekan harga emas pada ${now}`);

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

        if (latest.buying_rate < THRESHOLD) {
            console.log(`📉 Harga emas Rp${latest.buying_rate} < threshold Rp${THRESHOLD}, akan diperiksa untuk dikirim.`);

            // Cek apakah gold_id ini sudah dikirim
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
                console.log(`🚫 gold_id ${latest.id} sudah pernah dikirim sebelumnya. Skip.`);
                return;
            }

            // Siapkan pesan WhatsApp
            const message = `📉 Harga emas turun!\nHarga beli: Rp${latest.buying_rate}\nTanggal: ${latest.date}`;
            const chatId = `${TARGET_NUMBER}@c.us`;

            await client.sendMessage(chatId, message); // Aktifkan jika siap kirim
            console.log(`📨 Siap kirim ke WhatsApp ${TARGET_NUMBER}: ${message}`);

            const thisYear = new Date().getFullYear();
            const fullDateStr = `${latest.date} ${thisYear}`;
            const parsedDate = new Date(fullDateStr);

           const formattedDate = formatCustomDate(parsedDate);
            console.log('🧾 Formatted date:', formattedDate);   


            // Simpan ke Supabase
            const { data: insertData, error: insertError } = await supabase.from('emasDB').insert([
                {
                    buying_rate: latest.buying_rate,
                    sent_to: TARGET_NUMBER,
                    sent_at: new Date().toISOString(),
                     date: formattedDate,
                    gold_id: latest.id
                }
            ]);

            if (insertError) {
                console.error('❌ Gagal menyimpan ke Supabase:', insertError.message);
            } else {
                console.log(`✅ Data berhasil disimpan ke Supabase: gold_id ${latest.id}`);
            }

        } else {
            console.log(`ℹ️ Harga emas Rp${latest.buying_rate} ≥ threshold Rp${THRESHOLD}, tidak dikirim.`);
        }
    } catch (err) {
        if (err.response) {
            console.error('❗ API Error:', err.response.status, err.response.data);
        } else {
            console.error('❗ Error saat ambil atau proses data:', err.message);
        }
    }
}

function formatCustomDate(dateObj) {
    const day = dateObj.getDate().toString().padStart(2, '0');
    const month = dateObj.toLocaleString('en-US', { month: 'short' }).toUpperCase(); // e.g., JUL
    const year = dateObj.getFullYear();
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = dateObj.getMinutes().toString().padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}`;
}

client.on('qr', (qr) => {
    console.log('🟡 Scan QR berikut untuk login:\n');
    qrcode.generate(qr, { small: true }); // tampilkan QR ke terminal
});

client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    console.log('⏳ Inisialisasi cron schedule setiap 30 detik...');
    // cron.schedule('*/30 * * * * *', checkGoldAndSend);
    cron.schedule('0 0 8,12,20 * * *', checkGoldAndSend); //tiap jam 8 pagi 12 siang 8 malam

});

client.initialize();
