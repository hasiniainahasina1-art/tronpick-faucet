const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= SAFE GOTO ================= */
async function safeGoto(page, url) {
    console.log('🌐 Navigation:', url);

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    }).catch(() => console.log('⚠️ Timeout ignoré'));

    await delay(5000);
}

/* ================= HUMAN ================= */
async function human(page) {
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(
            Math.random() * 800,
            Math.random() * 600,
            { steps: 20 }
        );
        await delay(300 + Math.random() * 500);
    }
}

/* ================= LOGIN ================= */
async function login(page) {
    await safeGoto(page, 'https://tronpick.io/login.php');

    await page.type('input[type="email"]', EMAIL, { delay: 50 });
    await page.type('input[type="password"]', PASSWORD, { delay: 50 });

    await human(page);

    const loginBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button')]
            .find(b => b.textContent.toLowerCase().includes('log in'));
    });

    if (!loginBtn) throw new Error('Bouton login introuvable');

    await loginBtn.click().catch(() => console.log('⚠️ click fallback'));

    await delay(8000);

    console.log('✅ Login OK:', page.url());
}

/* ================= FIND CLAIM ================= */
async function findClaim(page) {
    return await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];

        for (const el of els) {
            const txt = (el.textContent || '').trim().toUpperCase();

            if (txt === 'CLAIM' && el.offsetParent !== null) {
                const r = el.getBoundingClientRect();
                return {
                    x: r.x + r.width / 2,
                    y: r.y + r.height / 2
                };
            }
        }

        return null;
    });
}

/* ================= CLICK REAL ================= */
async function realClick(page, pos) {
    await page.mouse.move(pos.x, pos.y, { steps: 25 });
    await delay(500);

    await page.mouse.down();
    await delay(120);
    await page.mouse.up();
}

/* ================= CLAIM ================= */
async function claim(page) {
    await safeGoto(page, 'https://tronpick.io/faucet.php');

    await human(page);

    console.log('🔍 Recherche CLAIM...');

    let pos = null;

    // retry find bouton
    for (let i = 0; i < 5; i++) {
        pos = await findClaim(page);
        if (pos) break;

        console.log('⏳ Bouton non trouvé, retry...');
        await delay(3000);
    }

    if (!pos) {
        return { success: false, message: 'CLAIM introuvable' };
    }

    console.log('📍 Position:', pos);

    // écoute API
    let apiSuccess = false;

    const listener = async res => {
        const url = res.url().toLowerCase();
        if (url.includes('claim')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) apiSuccess = true;
        }
    };

    page.on('response', listener);

    console.log('🔥 CLIC...');
    await realClick(page, pos);

    await delay(10000);

    page.off('response', listener);

    const text = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (apiSuccess || text.includes('claimed')) {
        return { success: true, message: 'SUCCESS' };
    }

    if (text.includes('wait') || text.includes('cooldown')) {
        return { success: false, message: 'COOLDOWN' };
    }

    return { success: false, message: 'Échec CLAIM' };
}

/* ================= RETRY ================= */
async function claimRetry(page) {
    for (let i = 1; i <= 3; i++) {
        console.log(`🔁 Tentative ${i}`);

        const res = await claim(page);

        console.log('📊', res);

        if (res.success) return res;

        if (res.message === 'COOLDOWN') return res;

        await delay(8000);
    }

    return { success: false, message: 'Échec total' };
}

/* ================= MAIN ================= */
(async () => {
    let browser;

    try {
        console.log('🚀 Lancement');

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
                get: () => false
            });
        });

        await login(page);

        const result = await claimRetry(page);

        console.log('🏁 RESULT FINAL:', result);

    } catch (e) {
        console.log('❌ ERREUR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
