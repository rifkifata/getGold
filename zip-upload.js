import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import fetch from 'node-fetch';
import FormData from 'form-data';
import unzipper from 'unzipper';
import 'dotenv/config';

// === Konfigurasi ===
const ZIP_NAME = 'session_default.zip';
const FOLDER_TO_ZIP = path.join('.wwebjs_auth', 'session', 'Default');
const ZIP_PATH = path.join('.', ZIP_NAME);
const EXTRACT_DEST = path.join('.wwebjs_auth', 'extracted_test');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET = 'wa-sessions';

// === 1. Buat ZIP ===
function zipFolder(sourceFolder, outPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', err => reject(err));

        archive.pipe(output);
        archive.directory(sourceFolder, false);
        archive.finalize();
    });
}

// === 2. Extract ZIP ke folder lokal
function extractZipToFolder(zipPath, destination) {
    return fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destination }))
        .promise();
}

// === 3. Upload ZIP ke Supabase Storage ===
async function uploadToSupabaseStorage(filePath, fileName) {
    const fileStream = fs.createReadStream(filePath);
    const form = new FormData();
    form.append('file', fileStream, fileName);

    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${fileName}`, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: form
    });

    if (response.ok) {
        console.log('✅ Upload ZIP ke Supabase berhasil.');
    } else {
        const errorText = await response.text();
        console.error('❌ Gagal upload:', errorText);
    }
}

// === Eksekusi ===
(async () => {
    if (!fs.existsSync(FOLDER_TO_ZIP)) {
        console.error(`❌ Folder tidak ditemukan: ${FOLDER_TO_ZIP}`);
        return;
    }

    console.log('📦 Men-zip folder...');
    await zipFolder(FOLDER_TO_ZIP, ZIP_PATH);

    console.log(`📂 Mengekstrak ZIP ke folder lokal: ${EXTRACT_DEST}`);
    fs.mkdirSync(EXTRACT_DEST, { recursive: true });
    await extractZipToFolder(ZIP_PATH, EXTRACT_DEST);
    console.log('✅ Berhasil di-extract ke folder lokal.');

    console.log('☁️ Upload ke Supabase...');
    await uploadToSupabaseStorage(ZIP_PATH, ZIP_NAME);

    // Opsional: Hapus file ZIP lokal
    //fs.unlinkSync(ZIP_PATH);
})();
