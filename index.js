import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import moment from 'moment-timezone';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import qrcodeImage from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Client, LocalAuth } = pkg;

// === Supabase setup ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'wa-sessions';

// === Bersihkan folder session/cache lama ===
function cleanSessionFolders() {
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    const cachePath = path.join(__dirname, '.wwebjs_cache');
    [sessionPath, cachePath].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`🧹 Folder ${dir} dihapus.`);
        }
    });
}

// === Upload QR image ke Supabase ===
async function uploadQRImage(buffer) {
    const filename = `qr-${uuidv4()}.png`;
    const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
        contentType: 'image/png',
        upsert: true
    });

    if (error) {
        console.error('❌ Gagal upload QR ke Supabase:', error.message);
    } else {
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
        console.log(`☁️ QR code juga diunggah ke Supabase:\n${publicUrl}`);
    }
}

// === WA Client init ===
let client;
let clientReady = false;
let activeJobs = [];

const TARGET_NUMBERS = process.env.WA_TARGET_NUMBERS
    ? process.env.WA_TARGET_NUMBERS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

async function initWhatsappClient() {
    cleanSessionFolders();

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: '.wwebjs_auth'
        })
    });

    client.on('qr', async qr => {
        console.log('🟡 Scan QR berikut untuk login:\n');
        qrcode.generate(qr, { small: true });

        try {
            const buffer = await qrcodeImage.toBuffer(qr, { type: 'png' });
            await uploadQRImage(buffer);
        } catch (err) {
            console.error('❌ Gagal generate/upload QR:', err.message);
        }
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp berhasil diautentikasi.');
    });

    client.on('ready', async () => {
        clientReady = true;
        console.log('✅ WhatsApp client is ready!');

        // Cek apakah folder baru terbentuk setelah login
        const folderPath = path.join('.wwebjs_auth', 'session', 'Default');
        if (fs.existsSync(folderPath)) {
            console.log(`📁 Folder session berhasil dibuat oleh WhatsApp: ${folderPath}`);
        }

        await reloadCronSchedules();
    });

    client.on('disconnected', reason => {
        console.error('🔌 WhatsApp disconnected:', reason);
        clientReady = false;
    });

    client.initialize();
}

// === Konfigurasi dari Supabase ===
async function getDynamicThreshold() {
    const { data, error } = await supabase
        .from('gold_config')
        .select('threshold')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
    if (error) {
        console.error('❌ Gagal ambil threshold:', error.message);
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
        console.error('❌ Gagal ambil cron_times:', error?.message || 'Tidak ada data');
        return [];
    }
    return data.cron_times.split(',').map(str => str.trim());
}

// === Cron job manager ===
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
        const expr = `${minute} ${utcHour} * * *`;
        cron.schedule(expr, () => {
            const nowWIB = moment().tz('Asia/Jakarta');
            if (nowWIB.hour() === hour && nowWIB.minute() === minute && clientReady) {
                checkGoldAndSend();
            }
        });
        activeJobs.push(expr);
        console.log(`⏳ Menjadwalkan cron job (WIB ${timeStr}): ${expr} (UTC)`);
    }
}

// === Fungsi utama: Cek harga dan kirim WA ===
async function checkGoldAndSend() {
    console.log(`🔍 Cek harga emas ${new Date().toISOString()}`);
    if (!clientReady) return;

    const threshold = await getDynamicThreshold();
    if (!threshold) return;

    try {
        const { data } = await axios.get('https://api.treasury.id/api/v1/antigrvty/gold/stats/buy');
        const latest = data.data.reduce((a, b) => (a.id > b.id ? a : b));
        if (latest.buying_rate >= threshold) return;

        const { data: exist } = await supabase
            .from('emasDB')
            .select('id')
            .eq('gold_id', latest.id)
            .maybeSingle();

        if (exist) return;

        const date = new Date(`${latest.date} ${new Date().getFullYear()}`);
        const formatted = `${date.getDate()}-${date.toLocaleString('en-US', { month: 'short' }).toUpperCase()}-${date.getFullYear()}`;

        for (const num of TARGET_NUMBERS) {
            const msg = `📉 Harga emas turun!\nHarga beli: Rp${latest.buying_rate}\nTanggal: ${latest.date}`;
            await client.sendMessage(`${num}@c.us`, msg);
            await supabase.from('emasDB').insert([{
                buying_rate: latest.buying_rate,
                sent_to: num,
                sent_at: new Date().toISOString(),
                date: formatted,
                gold_id: latest.id
            }]);
        }
    } catch (err) {
        console.error('❌ Error saat ambil data emas:', err.message);
    }
}

// === Jadwal refresh cron setiap 30 menit ===
cron.schedule('*/30 * * * *', reloadCronSchedules);

// === Mulai ===
initWhatsappClient();

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('✅ WhatsApp Bot is running.'));
app.listen(PORT, () => {
    console.log(`🌐 Express aktif di port ${PORT}`);
});
