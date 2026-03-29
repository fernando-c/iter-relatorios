const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');

const PBI_USERNAME = process.env.PBI_USERNAME;
const PBI_PASSWORD = process.env.PBI_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const REPORT_URL = 'https://app.powerbi.com/groups/234f9d81-3fd0-4618-9c73-70d9415096ff/reports/43186310-9462-486b-ad59-6bc0102cad94';

const monthMap = {
    0: 'Jan', 1: 'Fev', 2: 'Mar', 3: 'Abr', 4: 'Mai', 5: 'Jun',
    6: 'Jul', 7: 'Ago', 8: 'Set', 9: 'Out', 10: 'Nov', 11: 'Dez'
};

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function exportPDF() {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Vai direto para o login da Microsoft
    console.log('[INFO] Navegando para login Microsoft...');
    await page.goto('https://login.microsoftonline.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(2000);

    // Digita o email
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', PBI_USERNAME);
    await page.click('input[type="submit"]');
    console.log('[INFO] Email enviado.');
    await wait(3000);

    // Digita a senha
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await page.type('input[type="password"]', PBI_PASSWORD);
    await page.click('input[type="submit"]');
    console.log('[INFO] Senha enviada.');
    await wait(4000);

    // Confirmar "manter conectado" se aparecer
    try {
        await page.waitForSelector('#idSIButton9', { timeout: 5000 });
        await page.click('#idSIButton9');
        console.log('[INFO] Manter conectado confirmado.');
        await wait(3000);
    } catch { }

    // Navega para o relatório
    console.log('[INFO] Navegando para o relatorio...');
    await page.goto(REPORT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(10000);

    // Verifica se o login foi bem sucedido
    const url = page.url();
    console.log(`[INFO] URL atual: ${url}`);
    if (url.includes('login') || url.includes('microsoftonline')) {
        throw new Error('Login falhou — ainda na pagina de autenticacao');
    }

    // Gera PDF
    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2, '0')}${monthMap[today.getMonth()]}${String(today.getFullYear()).slice(-2)}`;
    const filename = `Curva DI Futuro ${dateStr} - Relatorio ITER.pdf`;
    const filepath = path.join('/tmp', filename);

    await page.pdf({
        path: filepath,
        format: 'A4',
        landscape: true,
        printBackground: true
    });

    console.log(`[OK] PDF gerado: ${filename}`);
    await browser.close();
    return { filepath, filename };
}

async function sendTelegram(filepath, filename) {
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT);
        form.append('caption', `Curva DI Futuro — ${new Date().toLocaleDateString('pt-BR')}`);
        form.append('document', fs.createReadStream(filepath), { filename });

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_TOKEN}/sendDocument`,
            method: 'POST',
            headers: form.getHeaders()
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const json = JSON.parse(data);
                if (json.ok) {
                    console.log('[OK] PDF enviado via Telegram.');
                    resolve();
                } else {
                    reject(new Error(`Telegram erro: ${JSON.stringify(json)}`));
                }
            });
        });

        req.on('error', reject);
        form.pipe(req);
    });
}

(async () => {
    try {
        const { filepath, filename } = await exportPDF();
        await sendTelegram(filepath, filename);
        console.log('Etapa 3 concluida.');
    } catch (e) {
        console.error('[ERRO]', e.message);
        process.exit(1);
    }
})();