// api/test-turnstile.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!BROWSERLESS_TOKEN) {
        return res.status(500).json({ error: 'BROWSERLESS_TOKEN manquant' });
    }

    const screenshots = [];
    let browser;

    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        console.log('🌐 Navigation vers login.php');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'domcontentloaded', timeout: 15000 });

        // 1. Actualisation (reload) et attente 6 secondes
        console.log('🔄 Actualisation de la page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        console.log('⏳ Attente de 6 secondes après actualisation...');
        await delay(6000);
        screenshots.push({
            label: '01_apres_actualisation_6s',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 2. Premier clic Turnstile et capture
        console.log('🖱️ Premier clic Turnstile');
        // Utiliser les coordonnées validées (640, 615)
        await page.mouse.click(640, 615);
        screenshots.push({
            label: '02_apres_premier_clic',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 3. Attendre 6 secondes et capture
        console.log('⏳ Attente de 6 secondes après premier clic...');
        await delay(6000);
        screenshots.push({
            label: '03_apres_6s_attente',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 4. Deuxième clic Turnstile et capture
        console.log('🖱️ Deuxième clic Turnstile');
        await page.mouse.click(640, 615);
        screenshots.push({
            label: '04_apres_deuxieme_clic',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        await browser.close();
        res.status(200).json({ success: true, screenshots });

    } catch (error) {
        console.error('❌ Erreur:', error);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: error.message });
    }
}
