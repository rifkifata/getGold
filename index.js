import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import moment from 'moment-timezone';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import unzipper from 'unzipper';

const { Client, LocalAuth } = pkg;

// === Supabase setup ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'wa-sessions';
const ZIP_NAME = 'session_default.zip';
const ZIP_DEST = `.wwebjs_auth/session/Default`;

// === Download & extract session zip ===
async function extractSessionZipFromSupabase() {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${ZIP_NAME}`;
    const response = await fetch(url, {
        headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`
        }
    });

    if (!response.ok) {
        console.warn(`⚠️ Gagal mengunduh ZIP dari Supabase: ${response.statusText}`);
        return false;
    }

    if (fs.existsSync(ZIP_DEST)) {
        fs.rmSync(ZIP_DEST, { recursive: true, force: true });
    }
    fs.mkdirSync(ZIP_DEST, { recursive: true });

    await new Promise((resolve, reject) => {
        response.body
            .pipe(unzipper.Extract({ path: ZIP_DEST }))
            .on('close', resolve)
            .on('error', reject);
    });

    console.log(`✅ Session berhasil diekstrak ke ${ZIP_DEST}`);
    return true;
}

// === WhatsApp client setup ===
let clientReady = false;
let client;
let activeJobs = [];

const TARGET_NUMBERS = process.env.WA_TARGET_NUMBERS
    ? process.env.WA_TARGET_NUMBERS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

async function initWhatsappClient() {
    const success = await extractSessionZipFromSupabase();

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: '.wwebjs_auth'
        })
    });

    client.on('qr', qr => {
        console.log('🟡 Scan QR berikut untuk login:\n');
        qrcode.generate(qr, { small: true });
        if (!success) console.warn('⚠️ QR muncul karena session tidak berhasil dimuat dari Supabase.');
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp berhasil diautentikasi.');
    });

    client.on('ready', async () => {
        clientReady = true;
        console.log('✅ WhatsApp client is ready!');
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

// === Cron Reload Jadwal ===
cron.schedule('*/30 * * * *', reloadCronSchedules);

// === Inisialisasi WA dan Express ===
initWhatsappClient();

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('✅ WhatsApp Bot is running.'));
app.listen(PORT, () => {
    console.log(`🌐 Express aktif di port ${PORT}`);
});
