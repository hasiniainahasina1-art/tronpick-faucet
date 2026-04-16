// api/test-turnstile.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

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

        // Capture avant toute action
        screenshots.push({
            label: '01_page_chargee',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // Attendre l'iframe Turnstile
        console.log('🛡️ Attente iframe Turnstile...');
        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 10000 }
        ).catch(() => null);

        if (frame) {
            console.log('✅ Iframe trouvée, clic checkbox');
            await frame.click('input[type="checkbox"]');
            await new Promise(resolve => setTimeout(resolve, 5000)); // attendre 5s
            
            screenshots.push({
                label: '02_apres_clic',
                base64: await page.screenshot({ encoding: 'base64', fullPage: true })
            });
        } else {
            console.log('⚠️ Iframe non trouvée');
            screenshots.push({
                label: '02_iframe_non_trouvee',
                base64: await page.screenshot({ encoding: 'base64', fullPage: true })
            });
        }

        await browser.close();
        res.status(200).json({ success: true, screenshots });

    } catch (error) {
        console.error('❌ Erreur:', error);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: error.message });
    }
}
