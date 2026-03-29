const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const FormData  = require('form-data');

const PBI_USERNAME   = process.env.PBI_USERNAME;
const PBI_PASSWORD   = process.env.PBI_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const REPORT_URL     = 'https://app.powerbi.com/groups/234f9d81-3fd0-4618-9c73-70d9415096ff/reports/43186310-9462-486b-ad59-6bc0102cad94';

const monthMap = {
    0:'Jan',1:'Fev',2:'Mar',3:'Abr',4:'Mai',5:'Jun',
    6:'Jul',7:'Ago',8:'Set',9:'Out',10:'Nov',11:'Dez'
};

async function exportPDF() {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Login
    await page.goto('https://app.powerbi.com', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#email', { timeout: 20000 });
    await page.type('#email', PBI_USERNAME);
    await page.click('#submitBtn');
    await page.waitForSelector('#i0118', { timeout: 20000 });
    await page.type('#i0118', PBI_PASSWORD);
    await page.click('#idSIButton9');
    await new Promise(r => setTimeout(r, 4000));

    // Confirmar "manter conectado" se aparecer
    try { await page.click('#idSIButton9'); } catch {}
    await new Promise(r => setTimeout(r, 3000));

    // Navega para o relatório
    await page.goto(REPORT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));

    // Gera PDF
    const today   = new Date();
    const dateStr = `${String(today.getDate()).padStart(2,'0')}${monthMap[today.getMonth()]}${String(today.getFullYear()).slice(-2)}`;
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
        form.append('caption', `📊 *Curva DI Futuro* — ${new Date().toLocaleDateString('pt-BR')}`);
        form.append('parse_mode', 'Markdown');
        form.append('document', fs.createReadStream(filepath), { filename });

        const req = https.request({
            hostname: 'api.telegram.org',
            path:     `/bot${TELEGRAM_TOKEN}/sendDocument`,
            method:   'POST',
            headers:  form.getHeaders()
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
        console.log('Etapa 4 concluida.');
    } catch (e) {
        console.error('[ERRO]', e.message);
        process.exit(1);
    }
})();
