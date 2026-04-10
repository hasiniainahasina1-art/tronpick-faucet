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

    await delay(6000);
}

/* ================= HUMAN ================= */
async function human(page) {
    for (let i = 0; i < 6; i++) {
        await page.mouse.move(
            Math.random() * 900,
            Math.random() * 700,
            { steps: 25 }
        );
        await delay(300 + Math.random() * 600);
    }
}

/* ================= LOGIN ================= */
async function login(page) {
    await safeGoto(page, 'https://tronpick.io/login.php');

    await page.type('input[type="email"]', EMAIL, { delay: 60 });
    await page.type('input[type="password"]', PASSWORD, { delay: 60 });

    await human(page);

    const btn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button')]
            .find(b => b.textContent.toLowerCase().includes('log in'));
    });

    if (!btn) throw new Error('❌ Bouton login introuvable');

    await btn.click().catch(() => console.log('⚠️ click fallback'));

    await delay(8000);

    console.log('✅ Login OK:', page.url());
}

/* ================= FIND BEST BUTTON ================= */
async function findBestButton(page) {
    return await page.evaluate(() => {
        const keywords = ['claim', 'reward', 'roll', 'collect', 'spin', 'get'];

        const elements = [...document.querySelectorAll('button, a, div, input')];

        let best = null;

        for (const el of elements) {
            const text = (el.textContent || el.value || '').toLowerCase().trim();
            const rect = el.getBoundingClientRect();

            if (!text) continue;
            if (rect.width < 50 || rect.height < 20) continue;
            if (el.offsetParent === null) continue;

            const score = keywords.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0);

            if (score > 0) {
                best = {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                    text,
                    score
                };
                break;
            }
        }

        return best;
    });
}

/* ================= CLICK ================= */
async function realClick(page, pos) {
    try {
        await page.mouse.move(pos.x, pos.y, { steps: 30 });
        await delay(400);

        await page.mouse.click(pos.x, pos.y, {
            delay: 120 + Math.random() * 200
        });

        console.log('✅ Clic sur:', pos.text);

    } catch (e) {
        console.log('⚠️ Fallback JS');

        await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.click();
        }, pos);
    }
}

/* ================= CLAIM ================= */
async function claim(page) {
    await safeGoto(page, 'https://tronpick.io/faucet.php');

    await human(page);

    console.log('🔍 Recherche bouton actif...');

    let button = null;

    for (let i = 0; i < 6; i++) {
        button = await findBestButton(page);

        if (button) break;

        console.log('⏳ Aucun bouton trouvé, retry...');
        await delay(4000);
    }

    if (!button) {
        return { success: false, message: '❌ Aucun bouton actif trouvé' };
    }

    console.log('📍 Bouton détecté:', button);

    // écoute API
    let apiSuccess = false;

    const listener = async res => {
        const url = res.url().toLowerCase();
        if (url.includes('claim') || url.includes('reward')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) apiSuccess = true;
        }
    };

    page.on('response', listener);

    console.log('🔥 CLIC...');
    await realClick(page, button);

    await delay(12000);

    page.off('response', listener);

    const txt = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (apiSuccess || txt.includes('claimed') || txt.includes('success')) {
        return { success: true, message: '✅ SUCCESS' };
    }

    if (txt.includes('wait') || txt.includes('cooldown')) {
        return { success: false, message: '⏳ COOLDOWN' };
    }

    return { success: false, message: '❌ Action non validée' };
}

/* ================= MAIN ================= */
(async () => {
    let browser;

    try {
        console.log('🚀 START');

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

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        await login(page);

        const result = await claim(page);

        console.log('🏁 RESULT FINAL:', result);

    } catch (e) {
        console.log('❌ ERREUR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
