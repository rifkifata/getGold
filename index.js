
import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import moment from 'moment-timezone';
import fs from 'fs';

const { Client } = pkg;

// === Supabase setup ===
const supabaseUrl = 'https://njuwhppokcqtbgyornsn.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// === Session Key ===
const SESSION_TABLE = 'wa_sessions';
const SESSION_KEY = 'default';

async function loadSessionFromSupabase() {
    const { data, error } = await supabase
        .from(SESSION_TABLE)
        .select('session_data')
        .eq('key', SESSION_KEY)
        .single();

    if (error || !data?.session_data) {
        console.warn('⚠️ Tidak ada sesi WhatsApp di Supabase.');
        return undefined;
    }

    console.log('✅ Sesi WhatsApp dimuat dari Supabase.');
    return data.session_data;
}

async function saveSessionToSupabase(session) {
    const { error } = await supabase
        .from(SESSION_TABLE)
        .upsert({ key: SESSION_KEY, session_data: session });

    if (error) {
        console.error('❌ Gagal menyimpan sesi ke Supabase:', error.message);
    } else {
        console.log('✅ Sesi WhatsApp disimpan ke Supabase.');
    }
}

// === WhatsApp setup ===
let client;
let clientReady = false;

async function initWhatsappClient() {
    const sessionData = await loadSessionFromSupabase();

    client = new pkg.Client({
        session: sessionData
    });

    client.on('qr', (qr) => {
        console.log('🟡 Scan QR berikut untuk login:\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', async (session) => {
        await saveSessionToSupabase(session);
    });

    client.on('ready', async () => {
        clientReady = true;
        console.log('✅ WhatsApp client is ready!');
        await reloadCronSchedules();
    });

    client.on('disconnected', async (reason) => {
        console.error('🔌 WhatsApp disconnected:', reason);
        clientReady = false;
    });

    client.initialize();
}

// === Supabase config ===
const TARGET_NUMBERS = process.env.WA_TARGET_NUMBERS
    ? process.env.WA_TARGET_NUMBERS.split(',').map(num => num.trim()).filter(Boolean)
    : [];

let activeJobs = [];

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

async function getCronTimes() {
    const { data, error } = await supabase
        .from('gold_config')
        .select('cron_times')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !data?.cron_times) {
        console.error('❌ Gagal mengambil cron_times dari Supabase:', error?.message || 'Tidak ada data.');
        return [];
    }

    return data.cron_times.split(',').map(str => str.trim()).filter(Boolean);
}

function clearAllJobs() {
    activeJobs.forEach(job => job.stop());
    activeJobs = [];
}

async function reloadCronSchedules() {
    clearAllJobs();

    const cronTimes = await getCronTimes();
    if (cronTimes.length === 0) {
        console.warn('⚠️ Tidak ada cron_times yang valid dari DB.');
        return;
    }

    for (const timeStr of cronTimes) {
        const [hour, minute] = timeStr.split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) {
            console.warn(`⚠️ Format waktu tidak valid: ${timeStr}`);
            continue;
        }

        const wibHour = (hour - 7 + 24) % 24;
        const expression = `${minute} ${wibHour} * * *`;
        const job = cron.schedule(expression, () => {
            const nowWIB = moment().tz('Asia/Jakarta');
            if (nowWIB.hour() === hour && nowWIB.minute() === minute && clientReady) {
                checkGoldAndSend();
            }
        });

        activeJobs.push(job);
        console.log(`⏳ Menjadwalkan cron job (WIB ${timeStr}): ${expression} (UTC)`);
    }
}

async function checkGoldAndSend() {
    const now = new Date().toISOString();
    console.log(`🔍 Memulai pengecekan harga emas pada ${now}`);

    if (!clientReady) {
        console.warn('⚠️ WhatsApp belum siap, pengiriman dibatalkan.');
        return;
    }

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

function formatCustomDate(dateObj) {
    const day = dateObj.getDate().toString().padStart(2, '0');
    const month = dateObj.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year = dateObj.getFullYear();
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = dateObj.getMinutes().toString().padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}`;
}

cron.schedule('*/30 * * * *', reloadCronSchedules);

initWhatsappClient();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
    res.send('✅ WhatsApp Bot is running (Render).');
});

app.listen(PORT, () => {
    console.log(`🌐 Express server aktif di port ${PORT}`);
});
