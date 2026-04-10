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

/* ================= FIND CLAIM ================= */
async function findClaim(page) {
    return await page.evaluate(() => {
        const keywords = ['claim', 'reward', 'roll', 'collect', 'get'];

        const els = [...document.querySelectorAll('*')];

        for (const el of els) {
            const txt = (el.textContent || '').toLowerCase().trim();

            if (!txt) continue;

            if (keywords.some(k => txt.includes(k))) {
                const r = el.getBoundingClientRect();

                if (r.width > 50 && r.height > 20) {
                    return {
                        x: r.x + r.width / 2,
                        y: r.y + r.height / 2,
                        text: txt
                    };
                }
            }
        }

        return null;
    });
}

/* ================= FIND CLAIM IFRAME ================= */
async function findClaimFrame(page) {
    for (const frame of page.frames()) {
        try {
            const result = await frame.evaluate(() => {
                const keywords = ['claim', 'reward', 'roll', 'collect'];

                const els = [...document.querySelectorAll('*')];

                for (const el of els) {
                    const txt = (el.textContent || '').toLowerCase();

                    if (keywords.some(k => txt.includes(k))) {
                        const r = el.getBoundingClientRect();

                        return {
                            x: r.x + r.width / 2,
                            y: r.y + r.height / 2
                        };
                    }
                }

                return null;
            });

            if (result) return result;

        } catch (e) {}
    }

    return null;
}

/* ================= CLICK ULTRA STABLE ================= */
async function realClick(page, pos) {
    try {
        // micro mouvement anti bug
        await page.mouse.move(pos.x + 1, pos.y + 1);
        await delay(100);

        await page.mouse.move(pos.x, pos.y, { steps: 30 });
        await delay(400);

        // clic stable (fix erreur "left is not pressed")
        await page.mouse.click(pos.x, pos.y, {
            delay: 120 + Math.random() * 200
        });

        console.log('✅ Clic effectué');

    } catch (e) {
        console.log('⚠️ Fallback JS click');

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

    console.log('🔍 Recherche bouton...');

    let pos = null;

    for (let i = 0; i < 6; i++) {
        pos = await findClaim(page);

        if (!pos) {
            console.log('🔄 Recherche iframe...');
            pos = await findClaimFrame(page);
        }

        if (pos) break;

        console.log('⏳ Retry...');
        await delay(4000);
    }

    if (!pos) {
        return { success: false, message: '❌ Aucun bouton détecté' };
    }

    console.log('📍 Bouton trouvé:', pos);

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

    console.log('🔥 CLIC HUMAIN...');
    await realClick(page, pos);

    await delay(12000);

    page.off('response', listener);

    const txt = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (apiSuccess || txt.includes('claimed')) {
        return { success: true, message: '✅ SUCCESS' };
    }

    if (txt.includes('wait') || txt.includes('cooldown')) {
        return { success: false, message: '⏳ COOLDOWN' };
    }

    return { success: false, message: '❌ CLAIM échoué' };
}

/* ================= RETRY ================= */
async function claimRetry(page) {
    for (let i = 1; i <= 3; i++) {
        console.log(`🔁 Tentative ${i}`);

        const res = await claim(page);

        console.log('📊', res);

        if (res.success) return res;
        if (res.message.includes('COOLDOWN')) return res;

        await delay(10000);
    }

    return { success: false, message: '❌ Échec total' };
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

        // anti-bot
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
