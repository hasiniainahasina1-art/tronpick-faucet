const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables manquantes');
    process.exit(1);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

/* ================= HUMAN SIMULATION ================= */
async function humanBehavior(page) {
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(
            Math.random() * 800,
            Math.random() * 600,
            { steps: 20 }
        );
        await delay(300 + Math.random() * 500);
    }
}

/* ================= TURNSTILE ================= */
async function waitTurnstile(page, timeout = 60000) {
    console.log('🔎 Attente Turnstile...');
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const frame = page.frames().find(f =>
            f.url().includes('challenges.cloudflare.com')
        );

        if (!frame) {
            console.log('✅ Turnstile OK');
            return true;
        }

        await delay(2000);
    }

    console.log('⚠️ Turnstile timeout');
    return false;
}

/* ================= LOGIN ================= */
async function login(page) {
    console.log('🌐 Ouverture login...');
    await page.goto('https://tronpick.io/login.php', {
        waitUntil: 'networkidle2'
    });

    await delay(3000);

    await page.type('input[type="email"]', EMAIL, { delay: 50 });
    await delay(500);
    await page.type('input[type="password"]', PASSWORD, { delay: 50 });

    await humanBehavior(page);

    console.log('🔐 Click login...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('button')
    ]);

    await delay(5000);
    await waitTurnstile(page);

    console.log('📍 URL:', page.url());
}

/* ================= CLAIM ULTRA ================= */
async function ultraClaim(page) {
    console.log('🚀 CLAIM ULTRA');

    await page.goto('https://tronpick.io/faucet.php', {
        waitUntil: 'networkidle2'
    });

    await delay(8000);
    await humanBehavior(page);

    // attendre bouton
    await page.waitForFunction(() => {
        return [...document.querySelectorAll('button, input, a')]
            .some(el =>
                (el.textContent || el.value || '')
                .toUpperCase().includes('CLAIM')
            );
    }, { timeout: 20000 });

    const handle = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button, input, a, div')]
            .find(el =>
                (el.textContent || el.value || '')
                .toUpperCase().includes('CLAIM') &&
                el.offsetParent !== null
            );
    });

    if (!handle) {
        return { success: false, message: 'CLAIM introuvable' };
    }

    const el = handle.asElement();

    await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
    await delay(2000);

    const box = await el.boundingBox();
    if (!box) return { success: false, message: 'Pas de position' };

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y, { steps: 30 });
    await delay(1000);

    console.log('🔥 CLICK RÉEL');
    await page.mouse.down();
    await delay(150);
    await page.mouse.up();

    // 🔥 écoute API
    let apiDetected = false;
    let apiResponse = '';

    page.on('response', async res => {
        const url = res.url().toLowerCase();

        if (url.includes('claim') || url.includes('faucet')) {
            apiDetected = true;
            try {
                apiResponse = await res.text();
            } catch {}
        }
    });

    await delay(10000);

    const pageResult = await page.evaluate(() => {
        const txt = document.body.innerText.toLowerCase();

        if (txt.includes('success') || txt.includes('claimed'))
            return { success: true, message: 'SUCCESS PAGE' };

        if (txt.includes('wait') || txt.includes('cooldown'))
            return { success: false, message: 'COOLDOWN' };

        return null;
    });

    if (apiDetected) {
        if (apiResponse.includes('success'))
            return { success: true, message: 'SUCCESS API' };

        return { success: false, message: 'REFUS API' };
    }

    if (pageResult) return pageResult;

    return { success: false, message: 'Aucune réponse' };
}

/* ================= RETRY ================= */
async function claimWithRetry(page, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
        console.log(`🔁 Tentative ${i}/${attempts}`);

        const result = await ultraClaim(page);

        console.log('📊 Résultat:', result);

        if (result.success) return result;

        if (result.message.includes('COOLDOWN')) {
            return result;
        }

        console.log('⏳ Retry...');
        await delay(10000);
    }

    return { success: false, message: 'Échec après retry' };
}

/* ================= MAIN ================= */
(async () => {
    let browser;
    const status = { success: false, message: '', time: new Date().toISOString() };

    try {
        console.log('🚀 Lancement navigateur');

        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: {
                host: PROXY_HOST,
                port: PROXY_PORT,
                username: PROXY_USERNAME,
                password: PROXY_PASSWORD
            }
        });

        browser = br;

        await page.setViewport({ width: 1280, height: 720 });

        // anti detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        await login(page);

        const result = await claimWithRetry(page, 3);

        status.success = result.success;
        status.message = result.message;

    } catch (e) {
        console.log('❌ ERREUR:', e.message);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();

        fs.writeFileSync(
            path.join(__dirname, 'public', 'status.json'),
            JSON.stringify(status, null, 2)
        );

        console.log('📝 FIN:', status);
    }
})();
