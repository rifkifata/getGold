import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import moment from 'moment-timezone';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';

const { Client } = pkg;

// === Supabase setup ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ZIP_FILE = 'session_default.zip';
const BUCKET = 'wa-sessions';
const SESSION_PATH = path.join('.wwebjs_auth', 'session', 'Default');

let client;
let clientReady = false;
let activeJobs = [];

// === Ambil session zip dari Supabase Storage ===
async function extractSessionFromStorage() {
    const { data, error } = await supabase
        .storage
        .from(BUCKET)
        .download(ZIP_FILE);

    if (error) {
        console.error('❌ Gagal mengunduh ZIP session dari Supabase:', error.message);
        return false;
    }

    const tempZipPath = path.join('.', ZIP_FILE);
    fs.writeFileSync(tempZipPath, Buffer.from(await data.arrayBuffer()));

    // Bersihkan dulu folder lama
    if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    }

    // Ekstrak ZIP
    const zip = new AdmZip(tempZipPath);
    zip.extractAllTo(SESSION_PATH, true);
    fs.unlinkSync(tempZipPath);

    console.log('✅ Session berhasil diekstrak ke .wwebjs_auth/session/Default');
    return true;
}

// === Inisialisasi WhatsApp client ===
async function initWhatsappClient() {
    const success = await extractSessionFromStorage();

    client = new Client({
        authStrategy: new pkg.LocalAuth({
            dataPath: '.wwebjs_auth'
        }),
    });

    client.on('qr', (qr) => {
        console.log('🟡 Scan QR berikut untuk login:\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        console.log('🔐 Authenticated.');
    });

    client.on('ready', async () => {
        clientReady = true;
        console.log('✅ WhatsApp client is ready!');
        await reloadCronSchedules();
    });

    client.on('disconnected', (reason) => {
        console.error('🔌 WhatsApp disconnected:', reason);
        clientReady = false;
    });

    client.initialize();
}

// === Gold config ===
async function getDynamicThreshold() {
    const { data, error } = await supabase
        .from('gold_config')
        .select('threshold')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    if (error) {
        console.error('❌ Gagal mengambil threshold:', error.message);
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
        console.error('❌ Gagal mengambil cron_times:', error?.message || 'Tidak ada data.');
        return [];
    }

    return data.cron_times.split(',').map(str => str.trim()).filter(Boolean);
}

// === Penjadwalan ulang cron dari DB ===
function clearAllJobs() {
    activeJobs.forEach(job => job.stop());
    activeJobs = [];
}

async function reloadCronSchedules() {
    clearAllJobs();
    const cronTimes = await getCronTimes();

    for (const timeStr of cronTimes) {
        const [hour, minute] = timeStr.split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) continue;

        const utcHour = (hour - 7 + 24) % 24;
        const expression = `${minute} ${utcHour} * * *`;

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

// === Fungsi utama pengiriman WA ===
const TARGET_NUMBERS = process.env.WA_TARGET_NUMBERS
    ? process.env.WA_TARGET_NUMBERS.split(',').map(n => n.trim()).filter(Boolean)
    : [];

async function checkGoldAndSend() {
    const now = new Date().toISOString();
    console.log(`🔍 Memulai pengecekan harga emas pada ${now}`);

    if (!clientReady || TARGET_NUMBERS.length === 0) return;

    const threshold = await getDynamicThreshold();
    if (!threshold) return;

    try {
        const res = await axios.get('https://api.treasury.id/api/v1/antigrvty/gold/stats/buy', {
            headers: {
                'user-agent': 'Mozilla/5.0',
                'origin': 'https://web.treasury.id',
                'accept': 'application/json, text/plain, */*'
            }
        });

        const latest = res.data.data.reduce((a, b) => (a.id > b.id ? a : b));
        console.log(`📦 Data: ID ${latest.id}, Harga: Rp${latest.buying_rate}, Tanggal: ${latest.date}`);

        if (latest.buying_rate < threshold) {
            const { data: existing } = await supabase
                .from('emasDB')
                .select('id')
                .eq('gold_id', latest.id)
                .maybeSingle();

            if (existing) {
                console.log(`🚫 gold_id ${latest.id} sudah dikirim. Lewat.`);
                return;
            }

            const year = new Date().getFullYear();
            const parsedDate = new Date(`${latest.date} ${year}`);
            const formattedDate = formatCustomDate(parsedDate);

            for (const number of TARGET_NUMBERS) {
                const chatId = `${number}@c.us`;
                const message = `📉 Harga emas turun!\nHarga beli: Rp${latest.buying_rate}\nTanggal: ${latest.date}`;

                try {
                    await client.sendMessage(chatId, message);
                    console.log(`✅ Terkirim ke ${number}`);

                    await supabase.from('emasDB').insert([{
                        buying_rate: latest.buying_rate,
                        sent_to: number,
                        sent_at: new Date().toISOString(),
                        date: formattedDate,
                        gold_id: latest.id
                    }]);
                } catch (err) {
                    console.error(`❌ Gagal kirim ke ${number}:`, err.message);
                }
            }
        } else {
            console.log(`ℹ️ Harga Rp${latest.buying_rate} ≥ threshold Rp${threshold}`);
        }

    } catch (err) {
        console.error('❗ Gagal ambil harga emas:', err.message);
    }
}

function formatCustomDate(date) {
    const d = date.getDate().toString().padStart(2, '0');
    const m = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const y = date.getFullYear();
    const h = date.getHours().toString().padStart(2, '0');
    const min = date.getMinutes().toString().padStart(2, '0');
    return `${d}-${m}-${y} ${h}:${min}`;
}

// === Auto reload schedule tiap 30 menit ===
cron.schedule('*/30 * * * *', reloadCronSchedules);

// === Jalankan App ===
initWhatsappClient();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
    res.send('✅ WhatsApp Bot is running (Render)');
});

app.listen(PORT, () => {
    console.log(`🌐 Server aktif di port ${PORT}`);
});
