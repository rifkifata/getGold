import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

const client = new Client({
    authStrategy: new LocalAuth(), // pakai folder `.wwebjs_auth` default
});

client.on('qr', (qr) => {
    console.log('🟡 Silakan scan QR untuk login:\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('✅ Berhasil login dan terautentikasi.');
});

client.on('ready', () => {
    console.log('✅ WhatsApp client sudah siap.');
    process.exit(0); // Keluar setelah siap
});

client.on('auth_failure', (msg) => {
    console.error('❌ Autentikasi gagal:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('🔌 WhatsApp disconnected:', reason);
});

client.initialize();
